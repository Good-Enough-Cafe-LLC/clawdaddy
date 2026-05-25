import { io } from 'socket.io-client';
import { createWebRTC } from './webrtcProvider';
import { deriveSharedKey, computeAuthHash } from '@clawdaddy/core';
import { getConfig } from './config';

const RECONNECT_BASE_MS = getConfig().reconnectBaseMs;
const RECONNECT_MAX_MS = getConfig().reconnectMaxMs;

export interface SocketClientOptions {
  url: string;
  hostId: string;
  pairingCode: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onTunnelOpen: (socketRef: any, authHashRef: string, sharedKeyRef: string) => void;
  onTunnelClose: () => void;
  onPacket?: (packet: any, send: (p: any) => void) => void;
  log: (msg: string, type?: string) => void;
  createWebRTC?: boolean;
}

export function createSocketClient(options: SocketClientOptions) {
  const {
    url,
    hostId,
    pairingCode,
    onConnect,
    onDisconnect,
    onTunnelOpen,
    onTunnelClose,
    onPacket,
    log,
    createWebRTC: shouldCreateWebRTC = true,
  } = options;

  let socket: ReturnType<typeof io> | null = null;
  // In multi-peer mode, one RTC instance per client session
  const sessionPeers = new Map<string, ReturnType<typeof createWebRTC>>();
  // Single-peer mode (legacy): one RTC for the first session
  let rtc: ReturnType<typeof createWebRTC> | null = null;
  let destroyed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;

  const sharedKey = deriveSharedKey(pairingCode, hostId);
  const authHash = computeAuthHash(sharedKey);

  const scheduleReconnect = () => {
    if (destroyed || reconnectTimer) return;
    reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt), RECONNECT_MAX_MS);
    log(`Reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempt})`, 'info');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!destroyed) connect();
    }, delay);
  };

  const teardown = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Close all session peers
    for (const [sessionId, peer] of sessionPeers.entries()) {
      try { peer.close(); } catch (_) { }
      sessionPeers.delete(sessionId);
    }
    if (rtc) { try { rtc.close(); } catch (_) { } rtc = null; }
    if (socket) { try { socket.disconnect(); } catch (_) { } socket = null; }
  };

  // ── Handle a new client session ─────────────────────────────────────────────
  // Called when the switchboard notifies us a client wants to connect.
  // Each session gets its own WebRTC peer; signals are routed by sessionId.
  const handleClientSession = (sock: ReturnType<typeof io>, sessionId: string) => {
    log(`📲 Incoming client session: ${sessionId.slice(0, 8)}...`, 'info');

    if (shouldCreateWebRTC) {
      // Single-peer mode: only support one client at a time
      if (rtc) {
        log('⚠️ Single-peer mode: closing existing peer for new session', 'info');
        try { rtc.close(); } catch (_) { }
        rtc = null;
      }

      rtc = createWebRTC({
        socket: sock,
        sessionId,      // ← pass through so webrtcProvider can include it on signals
        authHash,
        sharedKey,
        role: 'receiver',
        log,
        onOpen: () => {
          log('🔓 P2P tunnel open — client connected!', 'success');
          onTunnelOpen(sock, authHash, sharedKey);
        },
        onClose: () => {
          log('🔒 P2P tunnel closed.', 'error');
          onTunnelClose();
          rtc = null;
          // Don't full teardown/reconnect on peer close — stay registered
          // on the switchboard so new clients can connect
        },
        onData: (packet) => {
          if (onPacket && rtc) {
            onPacket(packet, rtc.send);
          }
        },
      });
    } else {
      // Multi-peer mode: create one peer per session, hand session map to caller
      const peer = createWebRTC({
        socket: sock,
        sessionId,
        authHash,
        sharedKey,
        role: 'receiver',
        log,
        onOpen: () => {
          log(`🔓 Peer connected (session: ${sessionId.slice(0, 8)}...)`, 'success');
          onTunnelOpen(sock, authHash, sharedKey);
        },
        onClose: () => {
          log(`🔒 Peer closed (session: ${sessionId.slice(0, 8)}...)`, 'error');
          sessionPeers.delete(sessionId);
          onTunnelClose();
        },
        onData: (packet) => {
          if (onPacket) {
            onPacket(packet, peer.send);
          }
        },
      });

      sessionPeers.set(sessionId, peer);
      log(`Multi-peer mode: session ${sessionId.slice(0, 8)}... handed to PeerManager`, 'info');
    }
  };

  const connect = () => {
    teardown();
    if (destroyed) return;

    log('Connecting to switchboard as server node...', 'info');

    const sock = io(url, { transports: ['websocket'], reconnection: false });
    socket = sock;

    sock.on('connect', () => {
      reconnectAttempt = 0;

      // Register as a persistent server node
      sock.emit('register', {
        role:     'server',
        serverId: hostId,
        authHash,
      });
    });

    // ── Wait for switchboard to confirm server registration ─────────────────
    sock.on('registered', ({ role, serverId }: { role: string; serverId: string }) => {
      if (role !== 'server') return;
      log(`✅ Registered as server node: ${serverId}`, 'success');
      onConnect();

      if (!shouldCreateWebRTC) {
        // Multi-peer mode: socket is ready, PeerManager will use it
        log('Multi-peer mode: WebRTC will be managed by PeerManager', 'info');
        onTunnelOpen(sock, authHash, sharedKey);
      }
      // In single-peer mode we wait for client_session before creating WebRTC
    });

    // ── New client wants to connect ─────────────────────────────────────────
    // Switchboard sends this when a client successfully registers against us
    sock.on('client_session', ({ sessionId }: { sessionId: string }) => {
      handleClientSession(sock, sessionId);
    });

    // ── Inbound signals from clients ────────────────────────────────────────
    // Forwarded by the switchboard; sessionId tells us which peer to route to
    sock.on('signal', ({ sessionId, signalData }: { sessionId: string; signalData: any }) => {
      if (shouldCreateWebRTC) {
        // Single-peer mode: signal goes to the one rtc instance
        if (rtc) {
          (rtc as any).receiveSignal?.(signalData);
        } else {
          log(`⚠️ Received signal for session ${sessionId.slice(0, 8)}... but no peer exists yet`, 'error');
        }
      } else {
        // Multi-peer mode: route to the right session peer
        const peer = sessionPeers.get(sessionId);
        if (peer) {
          (peer as any).receiveSignal?.(signalData);
        } else {
          log(`⚠️ No peer found for session ${sessionId.slice(0, 8)}...`, 'error');
        }
      }
    });

    // ── Client disconnected mid-handshake ───────────────────────────────────
    sock.on('client_disconnected', ({ sessionId }: { sessionId: string }) => {
      log(`⚠️ Client disconnected: session ${sessionId.slice(0, 8)}...`, 'info');
      const peer = sessionPeers.get(sessionId);
      if (peer) {
        try { peer.close(); } catch (_) { }
        sessionPeers.delete(sessionId);
      }
      if (shouldCreateWebRTC && rtc) {
        try { rtc.close(); } catch (_) { }
        rtc = null;
      }
    });

    // ── Switchboard-level errors ────────────────────────────────────────────
    sock.on('error', ({ code, message }: { code: string; message: string }) => {
      log(`❌ Switchboard error [${code}]: ${message}`, 'error');
    });

    sock.on('disconnect', (reason: any) => {
      log(`Switchboard disconnected: ${reason}`, 'error');
      onDisconnect();
      scheduleReconnect();
    });

    sock.on('connect_error', (e: { message: any }) => {
      log(`Switchboard error: ${e.message}`, 'error');
      teardown();
      scheduleReconnect();
    });
  };

  connect();

  return {
    disconnect: () => {
      destroyed = true;
      teardown();
    },
    send: (packet: any) => {
      if (rtc) rtc.send(packet);
    },
    // Expose session peers for multi-peer mode callers
    getSessionPeer: (sessionId: string) => sessionPeers.get(sessionId),
  };
}