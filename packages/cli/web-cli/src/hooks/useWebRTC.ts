import { useCallback, useRef } from 'react'
import { io } from 'socket.io-client'
import type { Instance as SimplePeerInstance } from 'simple-peer'
import SimplePeer from 'simple-peer/simplepeer.min.js'
import { useStore } from '../store'
import { buildChunks } from '../lib/chunking'
import { deriveSharedKey, computeAuthHash, computeHMAC, verifyHMAC } from '../lib/crypto'
import { reassemble } from '@clawdaddy/core'

const SIGNAL_SERVER = 'https://clawdaddyswitch01.goodenoughcafe.com'
const MAX_RECONNECT_ATTEMPTS = 3

// ─── Client ID ────────────────────────────────────────────────────────────────
// Stable secret that identifies this browser to the server so it can load
// persisted memory (system prompt, LTM). Stored in localStorage so it survives
// page refreshes but is per-browser by default.
// Only transmitted over the already-authenticated encrypted WebRTC channel.

const CLIENT_ID_KEY = 'clawdaddy_client_id'

function getOrCreateClientId(override?: string): string {
  if (override) return override
  const saved = localStorage.getItem(CLIENT_ID_KEY)
  if (saved) return saved
  const generated = crypto.randomUUID()
  localStorage.setItem(CLIENT_ID_KEY, generated)
  return generated
}

// ─── Types ────────────────────────────────────────────────────────────────────

type PendingHandler = {
  onToken?: (t: string) => void
  onDone?: (s: any) => void
  onError?: (e: string) => void
  onCommandResult?: (r: any) => void
}

// ─── Module-level mutable state ───────────────────────────────────────────────

let _socket: ReturnType<typeof io> | null = null
let _peer: SimplePeerInstance | null = null
let _sharedKey: string | null = null
let _authHash: string | null = null
let _targetId: string | null = null
let _pairingCode: string | null = null
let _sessionId: string | null = null
let _clientId: string | null = null          // stable identity for server-side memory
let _isDestroyed = false
let _isConnecting = false
let _isReconnecting = false
let _reconnectAttempt = 0
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null
let _connectionTimeout: ReturnType<typeof setTimeout> | null = null
const _pending = new Map<string, PendingHandler>()

export function useWebRTC() {
  const socketRef            = useRef(_socket)
  const peerRef              = useRef(_peer)
  const sharedKeyRef         = useRef(_sharedKey)
  const authHashRef          = useRef(_authHash)
  const targetIdRef          = useRef(_targetId)
  const pairingCodeRef       = useRef(_pairingCode)
  const sessionIdRef         = useRef(_sessionId)
  const isDestroyedRef       = useRef(_isDestroyed)
  const isConnectingRef      = useRef(_isConnecting)
  const reconnectAttemptRef  = useRef(_reconnectAttempt)
  const reconnectTimerRef    = useRef(_reconnectTimer)
  const connectionTimeoutRef = useRef(_connectionTimeout)
  const pendingRef           = useRef(_pending)

  socketRef.current            = _socket
  peerRef.current              = _peer
  sharedKeyRef.current         = _sharedKey
  authHashRef.current          = _authHash
  targetIdRef.current          = _targetId
  pairingCodeRef.current       = _pairingCode
  sessionIdRef.current         = _sessionId
  isDestroyedRef.current       = _isDestroyed
  isConnectingRef.current      = _isConnecting
  reconnectAttemptRef.current  = _reconnectAttempt
  reconnectTimerRef.current    = _reconnectTimer
  connectionTimeoutRef.current = _connectionTimeout
  pendingRef.current           = _pending

  const log = useCallback((msg: string, type?: 'info' | 'success' | 'error' | 'data' | 'api' | 'rtc') =>
    useStore.getState().addLog(msg, type), [])
  const status = useCallback((state: any, text: string) =>
    useStore.getState().setStatus(state, text), [])

  // ── Secure send ───────────────────────────────────────────────────────────
  const sendSecure = useCallback(async (payload: unknown) => {
    if (!_peer || _peer.destroyed || !_peer.connected || !_sharedKey) {
      throw new Error('No active P2P connection')
    }
    const signature  = await computeHMAC(_sharedKey, payload)
    const serialised = JSON.stringify({ payload, signature })
    const chunks     = buildChunks(serialised)
    for (const frame of chunks) {
      try {
        _peer.send(JSON.stringify(frame))
      } catch (e: any) {
        log(`Send failed: ${e.message}`, 'error')
        throw e
      }
    }
  }, [log])

  // ── Receive handler ───────────────────────────────────────────────────────
  const handleIncoming = useCallback(async (raw: string) => {
    let frame: any
    try { frame = JSON.parse(raw) } catch { log('Malformed frame', 'error'); return }
    if (typeof frame.id !== 'string' || typeof frame.index !== 'number' || typeof frame.total !== 'number') return

    const serialised = reassemble(frame)
    if (serialised === null) return

    let envelope: any
    try { envelope = JSON.parse(serialised) } catch { log('Malformed packet after reassembly', 'error'); return }

    if (!_sharedKey || !(await verifyHMAC(_sharedKey, envelope.payload, envelope.signature))) {
      log('HMAC verification failed', 'error'); return
    }

    const packet  = envelope.payload
    const handler = _pending.get(packet.requestId)
    if (!handler) return

    switch (packet.type) {
      case 'token':          handler.onToken?.(packet.token);                              break
      case 'done':           handler.onDone?.(packet.stats);   _pending.delete(packet.requestId); break
      case 'error':          handler.onError?.(packet.error);  _pending.delete(packet.requestId); break
      case 'command_result': handler.onCommandResult?.(packet.result); _pending.delete(packet.requestId); break
      case 'command_error':  handler.onError?.(packet.error);  _pending.delete(packet.requestId); break
    }
  }, [log])

  // ── Teardown ──────────────────────────────────────────────────────────────
  const teardown = useCallback(() => {
    if (_reconnectTimer)    { clearTimeout(_reconnectTimer);    _reconnectTimer    = null }
    if (_connectionTimeout) { clearTimeout(_connectionTimeout); _connectionTimeout = null }
    if (_peer)   { try { _peer.destroy()      } catch (_) { } _peer   = null }
    if (_socket) { try { _socket.disconnect() } catch (_) { } _socket = null }
    _sharedKey = null
    _authHash  = null
    _sessionId = null
    for (const [id, h] of _pending) {
      h.onError?.('Connection lost')
      _pending.delete(id)
    }
  }, [])

  // ── Schedule reconnect ────────────────────────────────────────────────────
  const scheduleReconnect = useCallback(() => {
    if (_isDestroyed || _isReconnecting || _reconnectTimer || !_targetId || !_pairingCode) return
    if (localStorage.getItem('clawdaddy_rtc_disconnected')) return

    if (_reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached.`, 'error')
      status('error', 'connection failed — max retries')
      _isConnecting   = false
      _isReconnecting = false
      return
    }

    _isReconnecting = true
    _reconnectAttempt++
    const delay = Math.min(1000 * Math.pow(2, _reconnectAttempt), 15000)
    log(`Reconnect ${_reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s...`, 'rtc')
    status('connecting', `reconnect ${_reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS}`)

    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null
      _isReconnecting = false
      if (!_isDestroyed && _targetId && _pairingCode && (!_peer || _peer.destroyed)) {
        startRtcConnection(_targetId, _pairingCode)
      }
    }, delay)
  }, [log, status])

  // ── Send identify ─────────────────────────────────────────────────────────
  // Sends the stable client ID right after the tunnel opens so the server can
  // load persisted memory. Fire-and-forget — UI doesn't wait for the response.
  const sendIdentify = useCallback(async () => {
    if (!_clientId) return
    try {
      const requestId = crypto.randomUUID()
      // Register handler before sending so the response is caught
      _pending.set(requestId, {
        onCommandResult: (result: any) => {
          if (result?.ltmFacts > 0) {
            log(`🧠 Loaded ${result.ltmFacts} memory facts`, 'success')
          }
          _pending.delete(requestId)
        },
        onError: () => {
          _pending.delete(requestId)
          // Older server without identify — silently ignore
        },
      })
      await sendSecure({ type: 'command', requestId, command: 'identify', payload: { clientId: _clientId } })
    } catch (_) {
      // Safe to ignore — identify is best-effort
    }
  }, [log, sendSecure])

  // ── Start handshake ───────────────────────────────────────────────────────
  const startHandshake = useCallback((sock: ReturnType<typeof io>, sessionId: string) => {
    log(`Reaching for ${_targetId}...`, 'rtc')
    status('connecting', 'handshaking...')

    _connectionTimeout = setTimeout(() => {
      if (_peer && !_peer.connected) {
        log('Connection timed out', 'error')
        teardown()
        scheduleReconnect()
      }
    }, 30000)

    const p = new SimplePeer({
      initiator: true,
      trickle:   true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
    })
    _peer = p

    p.on('signal', (data: any) => {
      sock.emit('signal', { sessionId, signalData: data })
    })

    const onSignal = ({ sessionId: incoming, signalData }: any) => {
      if (incoming !== sessionId) return
      if (_peer && !_peer.destroyed) {
        try { _peer.signal(signalData) } catch (e: any) { log(`Signal error: ${e.message}`, 'error') }
      }
    }
    sock.on('signal', onSignal)

    p.on('connect', () => {
      if (_connectionTimeout) { clearTimeout(_connectionTimeout); _connectionTimeout = null }
      _reconnectAttempt = 0
      _isConnecting     = false
      log('🔐 P2P tunnel established', 'success')
      status('connected', `connected · ${_targetId}`)
      useStore.getState().setPairedState(true, _targetId!)
      useStore.getState().addKnownNode(_targetId!)

      // Send stable identity so server loads persisted memory for this client
      sendIdentify()
    })

    p.on('data', (data: Buffer) => {
      handleIncoming(data.toString())
    })

    p.on('error', (e: any) => {
      log(`Peer error: ${e.message}`, 'error')
    })

    p.on('close', () => {
      log('P2P connection closed', 'error')
      sock.off('signal', onSignal)

      if (_peer === p) { _peer = null; _sessionId = null }
      _sharedKey    = null
      _authHash     = null
      _isConnecting = false

      status('error', 'disconnected')
      useStore.getState().setPairedState(false)

      if (!_isDestroyed && !localStorage.getItem('clawdaddy_rtc_disconnected')) {
        scheduleReconnect()
      }
    })
  }, [handleIncoming, log, scheduleReconnect, sendIdentify, status, teardown])

  // ── Main connect ──────────────────────────────────────────────────────────
  const startRtcConnection = useCallback(async (nodeId: string, pairingCode: string) => {
    if (_isConnecting) { log('Already connecting...'); return }

    teardown()
    if (_isDestroyed || !nodeId || !pairingCode) return

    _isConnecting = true
    log('🔑 Deriving shared key (PBKDF2)...', 'rtc')
    status('connecting', 'deriving key...')

    try {
      _sharedKey = await deriveSharedKey(pairingCode, nodeId)
      _authHash  = await computeAuthHash(_sharedKey)
    } catch (e: any) {
      log(`Key derivation failed: ${e.message}`, 'error')
      _isConnecting = false
      return
    }

    log('Connecting to switchboard...', 'rtc')
    status('connecting', 'connecting...')

    const sock = io(SIGNAL_SERVER, { transports: ['websocket'], reconnection: false })
    _socket = sock
    const authHash = _authHash!

    sock.on('connect', () => {
      log('Connected to switchboard', 'success')
      const sessionId = crypto.randomUUID()
      _sessionId = sessionId
      log(`Registering session ${sessionId.slice(0, 8)}...`, 'rtc')
      sock.emit('register', { role: 'client', sessionId, targetServerId: nodeId, authHash })
    })

    sock.on('registered', ({ role, sessionId }: { role: string; sessionId: string }) => {
      if (role !== 'client') return
      log(`Session confirmed: ${sessionId.slice(0, 8)}...`, 'rtc')
      startHandshake(sock, sessionId)
    })

    sock.on('error', ({ code, message }: { code: string; message: string }) => {
      log(`Switchboard [${code}]: ${message}`, 'error')
      if (code === 'AUTH_FAILED' || code === 'NOT_FOUND') {
        status('error', message); teardown(); _isConnecting = false; return
      }
      teardown(); scheduleReconnect()
    })

    sock.on('disconnect', (reason: string) => {
      log(`Switchboard disconnected: ${reason}`, 'error')
      if (!_peer) scheduleReconnect()
    })

    sock.on('connect_error', (e: any) => {
      log(`Switchboard error: ${e.message}`, 'error')
      teardown(); scheduleReconnect()
    })
  }, [log, scheduleReconnect, startHandshake, status, teardown])

  // ── Public: connect ───────────────────────────────────────────────────────
  // clientId is optional — defaults to auto-generated/saved value in localStorage.
  // Pass an explicit value to use a portable identity across browsers/devices.
  const connect = useCallback(async (nodeId: string, pairingCode: string, clientId?: string) => {
    _isDestroyed      = false
    _targetId         = nodeId
    _pairingCode      = pairingCode
    _clientId         = getOrCreateClientId(clientId)
    _reconnectAttempt = 0
    localStorage.removeItem('clawdaddy_rtc_disconnected')
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }

    log(`Targeting node: ${nodeId}`, 'rtc')
    log(`Pairing code: ${pairingCode.slice(0, 4)}-****`, 'rtc')
    log(`Client ID: ${_clientId.slice(0, 8)}...`, 'rtc')

    await startRtcConnection(nodeId, pairingCode)
  }, [log, startRtcConnection])

  // ── Public: disconnect ────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    _isDestroyed      = true
    _targetId         = null
    _pairingCode      = null
    _sessionId        = null
    _isConnecting     = false
    _reconnectAttempt = 0
    localStorage.setItem('clawdaddy_rtc_disconnected', '1')
    useStore.getState().setPairedState(false)
    teardown()
    status('', 'disconnected')
    log('Disconnected.', 'rtc')
  }, [log, status, teardown])

  // ── Public: runCommand ────────────────────────────────────────────────────
  const runCommand = useCallback((name: string, payload?: unknown) => {
    if (!_peer || _peer.destroyed || !_sharedKey) {
      log('Not connected.', 'error')
      return Promise.reject(new Error('Not connected'))
    }
    const requestId = crypto.randomUUID()
    log(`→ command: ${name}${payload !== undefined ? ' ' + JSON.stringify(payload) : ''}`, 'data')

    return new Promise((resolve, reject) => {
      _pending.set(requestId, {
        onCommandResult: (r) => { log(`← ${JSON.stringify(r)}`, 'success'); resolve(r) },
        onError:         (e) => { log(`← error: ${e}`, 'error');            reject(new Error(e)) },
      })

      setTimeout(() => {
        if (_pending.has(requestId)) {
          _pending.get(requestId)?.onError?.('Timed out')
          _pending.delete(requestId)
          reject(new Error('Timed out'))
        }
      }, 10000)

      sendSecure({ type: 'command', requestId, command: name, payload }).catch((e) => {
        _pending.delete(requestId)
        reject(e)
      })
    })
  }, [log, sendSecure])

  // ── Public: sendInference ─────────────────────────────────────────────────
  const sendInference = useCallback(async (
    text:         string,
    maxTokens:    number,
    temperature:  number,
    systemPrompt: string | null,
  ) => {
    if (!_peer || _peer.destroyed || !_sharedKey) { log('Not connected.', 'error'); return }
    const requestId   = crypto.randomUUID()
    const rtcPayload: any = {
      type: 'inference', requestId,
      messages: [{ role: 'user', content: text }],
      options:  { temperature, max_tokens: maxTokens, stream: true },
    }
    if (systemPrompt) rtcPayload.system = systemPrompt
    await sendSecure(rtcPayload)
  }, [log, sendSecure])

  // ── Public: status checks ─────────────────────────────────────────────────
  const isConnected  = useCallback(() => !!_peer && !_peer.destroyed, [])
  const isConnecting = useCallback(() => _isConnecting, [])

  // Expose client ID so Sidebar can show it for debugging / manual copy
  const getClientId = useCallback(() => _clientId ?? getOrCreateClientId(), [])

  return {
    connect,
    disconnect,
    sendSecure,
    sendInference,
    runCommand,
    pendingRef,
    isConnected,
    isConnecting,
    isConnectingRef,
    getClientId,
  }
}