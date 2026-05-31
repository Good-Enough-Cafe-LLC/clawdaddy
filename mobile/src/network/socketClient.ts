// socketClient.ts - Clean version without excessive debug logs
import { io } from 'socket.io-client';
import { MultiPeerManager } from './multiPeerManager';
import { deriveSharedKey, computeAuthHash } from '@clawdaddy/core';

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;

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
  url: string;
  phoneId: string;
  pairingCode: string;
  onPacket: (packet: any, send: (p: any) => void, sessionId: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onTunnelOpen: (sessionId: string) => void;
  onTunnelClose: (sessionId: string) => void;
  log: (msg: string, type?: any) => void;
}) => {
  let socket: ReturnType<typeof io> | null = null;
  let peerManager: MultiPeerManager | null = null;
  let destroyed = false;
  let reconnectTimer: any = null;
  let reconnectAttempt = 0;

  const normalizedPhoneId = normalizePhoneId(phoneId);
  const normalizedPairingCode = normalizePairingCode(pairingCode);

  const sharedKey = deriveSharedKey(normalizedPairingCode, normalizedPhoneId);
  const authHash = computeAuthHash(sharedKey);

  log(`🔐 Server ready | ID: ${normalizedPhoneId}`, 'info');

  const scheduleReconnect = () => {
    if (destroyed || reconnectTimer) return;
    reconnectAttempt++;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
      RECONNECT_MAX_MS,
    );
    log(`Reconnecting in ${Math.round(delay / 1000)}s...`, 'info');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!destroyed) connect();
    }, delay);
  };

  const teardown = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (peerManager) {
      try {
        peerManager.close();
      } catch (_) {}
      peerManager = null;
    }
    if (socket) {
      try {
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
  };

  const connect = () => {
    teardown();
    if (destroyed) return;

    log('Connecting to switchboard...', 'info');

    const sock = io(url, { transports: ['websocket'], reconnection: false });
    socket = sock;

    sock.on('connect', () => {
      reconnectAttempt = 0;
      sock.emit('register', {
        role: 'server',
        serverId: normalizedPhoneId,
        authHash,
      });
    });

    sock.on(
      'registered',
      ({ role, serverId }: { role: string; serverId: string }) => {
        if (role !== 'server') return;
        log(`✅ Registered | Waiting for connections`, 'success');
        onConnect();

        peerManager = new MultiPeerManager({
          socket: sock,
          authHash,
          sharedKey,
          maxConnections: 5,
          log,
        });

        peerManager.on('peer-connected', (sessionId: string) => {
          log(`🔗 Client connected`, 'success');
          onTunnelOpen(sessionId);
        });

        peerManager.on('peer-disconnected', (sessionId: string) => {
          log(`🔌 Client disconnected`, 'info');
          onTunnelClose(sessionId);
        });

        peerManager.on('peer-data', (sessionId: string, data: any) => {
          onPacket(
            data,
            (packet: any) => {
              peerManager?.sendToPeer(sessionId, packet);
            },
            sessionId,
          ); // sessionId is guaranteed to be string here
        });
      },
    );

    sock.on('error', ({ code, message }: { code: string; message: string }) => {
      log(`❌ Switchboard error: ${message}`, 'error');
      if (code === 'VALIDATION' || code === 'CAPACITY') {
        teardown();
        destroyed = true;
      }
    });

    sock.on('disconnect', (reason: string) => {
      log(`Disconnected from switchboard`, 'error');
      onDisconnect();
      scheduleReconnect();
    });

    sock.on('connect_error', (e: any) => {
      log(`Connection error: ${e.message}`, 'error');
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
    send: (packet: any, sessionId?: string) => {
      if (peerManager) {
        if (sessionId) {
          peerManager.sendToPeer(sessionId, packet);
        } else {
          const peers = peerManager.getPeers();
          if (peers.length > 0) {
            peerManager.sendToPeer(peers[0], packet);
          }
        }
      }
    },
    getPeerManager: () => peerManager,
  };
};
