import { io } from 'socket.io-client';
import { createWebRTC } from './webrtcProvider';
import { deriveSharedKey, computeAuthHash } from '@clawdaddy/core';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS  = 30000;

const normalizePhoneId = (id: string): string => id.trim().toUpperCase();

const normalizePairingCode = (code: string): string => {
  const cleaned = code.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length === 8 && !cleaned.includes('-')) {
    return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
  }
  return cleaned;
};

export const createSocketClient = ({
  url,
  phoneId,
  pairingCode,
  onPacket,
  onConnect,
  onDisconnect,
  onTunnelOpen,
  onTunnelClose,
  log,
}: {
  url:           string;
  phoneId:       string;
  pairingCode:   string;
  onPacket:      (packet: any, send: (p: any) => void) => void;
  onConnect:     () => void;
  onDisconnect:  () => void;
  onTunnelOpen:  () => void;
  onTunnelClose: () => void;
  log:           (msg: string, type?: any) => void;
}) => {
  let socket:          ReturnType<typeof io> | null = null;
  let rtc:             ReturnType<typeof createWebRTC> | null = null;
  let destroyed        = false;
  let reconnectTimer:  any = null;
  let reconnectAttempt = 0;

  const normalizedPhoneId    = normalizePhoneId(phoneId);
  const normalizedPairingCode = normalizePairingCode(pairingCode);

  const sharedKey = deriveSharedKey(normalizedPairingCode, normalizedPhoneId);
  const authHash  = computeAuthHash(sharedKey);

  log('🔐 PHONE DEBUG:');
  log(`   Phone ID:     ${normalizedPhoneId}`);
  log(`   Pairing Code: ${normalizedPairingCode}`);
  log(`   Auth Hash:    ${authHash.slice(0, 16)}...`);

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
    if (rtc)    { try { rtc.close();            } catch (_) { } rtc    = null; }
    if (socket) { try { socket.disconnect();    } catch (_) { } socket = null; }
  };

  const connect = () => {
    teardown();
    if (destroyed) return;

    log('Connecting to switchboard...', 'info');

    const sock = io(url, { transports: ['websocket'], reconnection: false });
    socket = sock;

    sock.on('connect', () => {
      reconnectAttempt = 0;

      // Generate a fresh sessionId for this connection attempt.
      // The phone is always the server role — it waits for clients (the CLI/web)
      // to connect to it via the switchboard.
      sock.emit('register', {
        role:     'server',
        serverId: normalizedPhoneId,
        authHash,
      });

      log(`📱 Registering as server: ${normalizedPhoneId}`, 'info');
    });

    // Wait for switchboard confirmation before setting up WebRTC.
    // This matches the pattern used on the CLI and web sides.
    sock.on('registered', ({ role, serverId }: { role: string; serverId: string }) => {
      if (role !== 'server') return;
      log(`✅ Registered as server: ${serverId}`, 'success');
      onConnect();

      // Phone is always the receiver — it waits for offers from clients.
      // WebRTC is created here and stays alive, ready to accept any incoming
      // client_session that the switchboard forwards.
      rtc = createWebRTC({
        socket: sock,
        authHash,
        sharedKey,
        log,
        onOpen: () => {
          log('🔓 P2P tunnel open — client connected!', 'success');
          onTunnelOpen();
        },
        onClose: () => {
          log('🔒 P2P tunnel closed.', 'error');
          onTunnelClose();
          // Don't full teardown — stay registered on the switchboard so new
          // clients can connect without needing to re-register.
          rtc = null;
        },
        onData: (packet) => {
          if (rtc) onPacket(packet, rtc.send);
        },
      });
    });

    // ── Switchboard-level errors ────────────────────────────────────────────
    sock.on('error', ({ code, message }: { code: string; message: string }) => {
      log(`❌ Switchboard [${code}]: ${message}`, 'error');
      // Validation errors won't fix themselves — stop retrying
      if (code === 'VALIDATION' || code === 'CAPACITY') {
        teardown();
        destroyed = true;
      }
    });

    sock.on('disconnect', (reason: string) => {
      log(`Switchboard disconnected: ${reason}`, 'error');
      onDisconnect();
      scheduleReconnect();
    });

    sock.on('connect_error', (e: any) => {
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
  };
};