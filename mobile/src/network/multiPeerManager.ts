// multiPeerManager.ts for React Native - with proper EventEmitter
import { createWebRTC } from './webrtcProvider';

// Simple EventEmitter implementation for React Native
class SimpleEventEmitter {
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  on(event: string, callback: (...args: any[]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback?: (...args: any[]) => void) {
    if (!callback) {
      this.listeners.delete(event);
      return;
    }
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const index = callbacks.indexOf(callback);
      if (index !== -1) callbacks.splice(index, 1);
    }
  }

  emit(event: string, ...args: any[]) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => callback(...args));
    }
  }
}

interface PeerConnection {
  sessionId: string;
  generation: number;
  rtc: any;
  send: (packet: any) => void;
  connectedAt: Date;
  lastActivity: Date;
}

interface MultiPeerManagerOptions {
  socket: any;
  authHash: string;
  sharedKey: string;
  maxConnections: number;
  log: (msg: string, type?: string) => void;
  activeInferenceSessions?: Set<string>;
}

export class MultiPeerManager extends SimpleEventEmitter {
  private peers: Map<string, PeerConnection> = new Map();
  private sessionGenerations: Map<string, number> = new Map();
  private pendingSessions: Set<string> = new Set();
  private maxConnections: number;
  private socket: any;
  private authHash: string;
  private sharedKey: string;
  private log: (msg: string, type?: string) => void;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private _isClosing: boolean = false;
  private activeInferenceSessions?: Set<string>;

  constructor(options: MultiPeerManagerOptions) {
    super();
    this.socket = options.socket;
    this.authHash = options.authHash;
    this.sharedKey = options.sharedKey;
    this.maxConnections = options.maxConnections;
    this.log = options.log;
    this.activeInferenceSessions = options.activeInferenceSessions;

    this.setupSocketHandlers();
    this.startHeartbeat();
  }

  private ts(): string {
    return new Date().toISOString().slice(11, 19);
  }

  private getActivePeerCount(): number {
    let count = 0;
    for (const [sessionId, peer] of this.peers.entries()) {
      if (peer.generation === this.sessionGenerations.get(sessionId)) count++;
    }
    return count;
  }

  private setupSocketHandlers(): void {
    // Handle client_session events from switchboard
    this.socket.on('client_session', ({ sessionId }: { sessionId: string }) => {
      const ts = this.ts();

      // Clean up any existing session with this ID
      if (this.peers.has(sessionId) || this.pendingSessions.has(sessionId)) {
        this.log(
          `${ts} 🧹 Cleaning up existing session ${sessionId.slice(0, 8)}... before new client_session`,
          'warn',
        );
        this.teardownPeer(sessionId, 'new client_session');
        this.pendingSessions.delete(sessionId);
      }

      const activeCount = this.getActivePeerCount();
      if (activeCount >= this.maxConnections) {
        this.log(
          `${ts} ❌ Rejected session ${sessionId.slice(0, 8)}...: at capacity (${activeCount}/${this.maxConnections})`,
          'error',
        );
        return;
      }

      this.pendingSessions.add(sessionId);
      this.log(
        `${ts} 📲 Pending session: ${sessionId.slice(0, 8)}... (${activeCount + 1}/${this.maxConnections})`,
        'info',
      );
    });

    // Handle signals from switchboard
    this.socket.on('signal', ({ sessionId, signalData }: { sessionId: string; signalData: any }) => {
      const ts = this.ts();

      if (!sessionId || !signalData) {
        this.log(`${ts} ⚠️ Received signal with missing sessionId or signalData`, 'warn');
        return;
      }

      if (signalData.type === 'offer') {
        this.handleOffer(sessionId, signalData);
        return;
      }

      // Non-offer signals route to existing peer
      const peer = this.peers.get(sessionId);
      if (!peer) {
        this.log(
          `${ts} 🗑️ Ignoring ${signalData.type ?? 'candidate'} for unknown session ${sessionId.slice(0, 8)}...`,
          'debug',
        );
        return;
      }

      const currentGen = this.sessionGenerations.get(sessionId);
      if (peer.generation !== currentGen) {
        this.log(
          `${ts} 🗑️ Ignoring ${signalData.type ?? 'candidate'} — stale generation (peer: ${peer.generation}, current: ${currentGen})`,
          'debug',
        );
        return;
      }

      try {
        peer.rtc.signal(signalData);
        peer.lastActivity = new Date();
      } catch (err: any) {
        this.log(
          `${ts} ❌ Failed to forward ${signalData.type ?? 'candidate'} to ${sessionId.slice(0, 8)}...: ${err.message}`,
          'error',
        );
      }
    });

    // Handle client disconnection
    this.socket.on('client_disconnected', ({ sessionId }: { sessionId: string }) => {
      const ts = this.ts();
      this.log(`${ts} ⚠️ Client disconnected mid-handshake: ${sessionId.slice(0, 8)}...`, 'info');
      this.pendingSessions.delete(sessionId);
      this.teardownPeer(sessionId, 'client disconnected');
    });
  }

  private handleOffer(sessionId: string, signalData: any): void {
    const ts = this.ts();

    const hasActiveInference = this.activeInferenceSessions?.has(sessionId);

    if (hasActiveInference) {
      this.log(`${ts} 🔄 Client reconnecting during active inference for ${sessionId.slice(0, 8)}...`, 'warn');
      
      const existingPeer = this.peers.get(sessionId);
      if (existingPeer) {
        try {
          existingPeer.rtc?.signal(signalData);
          return;
        } catch (err) {
          this.log(`${ts} Failed to reconnect, will create new`, 'warn');
        }
      }
    }

    // Forceful cleanup of existing peer
    const existingPeer = this.peers.get(sessionId);
    if (existingPeer) {
      this.log(`${ts} 🧹 Force cleaning existing peer for ${sessionId.slice(0, 8)}...`, 'info');
      try {
        existingPeer.rtc?.close();
      } catch (_) { }
      this.peers.delete(sessionId);
      this.sessionGenerations.delete(sessionId);
      this.pendingSessions.delete(sessionId);
    }

    // Clean up stale generation without peer
    if (this.sessionGenerations.has(sessionId) && !this.peers.has(sessionId)) {
      this.log(`${ts} 🧹 Cleaning stale generation for ${sessionId.slice(0, 8)}...`, 'info');
      this.sessionGenerations.delete(sessionId);
    }

    // Capacity check
    const activeCount = this.getActivePeerCount();
    if (activeCount >= this.maxConnections) {
      this.log(`${ts} ❌ Rejected offer from ${sessionId.slice(0, 8)}...: at capacity`, 'error');
      return;
    }

    const nextGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, nextGen);
    this.pendingSessions.delete(sessionId);

    this.log(
      `${ts} 🆕 Creating peer for session ${sessionId.slice(0, 8)}... (gen ${nextGen}) — ${this.peers.size + 1}/${this.maxConnections}`,
      'info',
    );

    const capturedGen = nextGen;

    const rtc = createWebRTC({
      socket: this.socket,
      sharedKey: this.sharedKey,
      sessionId,
      log: this.log,
      onOpen: () => {
        const peer = this.peers.get(sessionId);
        const currentGen = this.sessionGenerations.get(sessionId);

        if (peer && peer.generation === capturedGen && capturedGen === currentGen) {
          peer.connectedAt = new Date();
          peer.lastActivity = new Date();
          this.log(`${ts} ✅ Peer connected: ${sessionId.slice(0, 8)}... (gen ${capturedGen})`, 'success');
          this.emit('peer-connected', sessionId);
        } else {
          this.log(`${ts} ⚠️ peer-connected fired but generation is stale — ignoring`, 'warn');
        }
      },
      onClose: () => {
        const peer = this.peers.get(sessionId);
        if (peer) {
          this.log(`${ts} 🔌 Peer disconnected: ${sessionId.slice(0, 8)}...`, 'info');
          if (this.peers.get(sessionId) === peer) {
            this.peers.delete(sessionId);
          }
        }
        this.sessionGenerations.delete(sessionId);
        this.pendingSessions.delete(sessionId);

        if (!this._isClosing) {
          this.emit('peer-disconnected', sessionId);
        }
      },
      onData: (data: any) => {
        const peer = this.peers.get(sessionId);
        const currentGen = this.sessionGenerations.get(sessionId);

        if (peer && peer.generation === capturedGen && capturedGen === currentGen) {
          peer.lastActivity = new Date();
          this.emit('peer-data', sessionId, data);
        } else if (peer) {
          this.log(`${ts} ⚠️ Data from stale gen ${capturedGen} (current: ${currentGen}) — ignoring`, 'warn');
        }
      },
    });

    const peerEntry: PeerConnection = {
      sessionId,
      generation: nextGen,
      rtc,
      send: (packet: any) => rtc.send(packet),
      connectedAt: new Date(),
      lastActivity: new Date(),
    };
    this.peers.set(sessionId, peerEntry);

    try {
      rtc.signal(signalData);
    } catch (err: any) {
      this.log(`${this.ts()} ❌ Failed to deliver offer to ${sessionId.slice(0, 8)}...: ${err.message}`, 'error');
      this.peers.delete(sessionId);
      this.sessionGenerations.delete(sessionId);
      this.pendingSessions.delete(sessionId);
      try {
        rtc.close();
      } catch (_) { }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const staleTimeout = 300000; // 5 minutes
      let cleaned = 0;

      for (const [sessionId, peer] of this.peers.entries()) {
        const currentGen = this.sessionGenerations.get(sessionId);
        const timeSinceActivity = now - peer.lastActivity.getTime();

        const hasActiveInference = this.activeInferenceSessions?.has(sessionId);

        if (!hasActiveInference && timeSinceActivity > staleTimeout && peer.generation === currentGen) {
          this.log(
            `⏰ Session ${sessionId.slice(0, 8)}... stale (${Math.round(timeSinceActivity / 1000)}s) — disconnecting`,
            'warn',
          );
          this.teardownPeer(sessionId, 'heartbeat timeout');
          cleaned++;
        }
      }

      for (const sessionId of this.pendingSessions) {
        this.log(`⏰ Pending session ${sessionId.slice(0, 8)}... never sent offer — clearing`, 'warn');
        this.pendingSessions.delete(sessionId);
      }

      if (cleaned > 0) {
        this.log(`🧹 Cleaned ${cleaned} stale peers, ${this.peers.size} remaining`, 'info');
      }
    }, 30000);
  }

  private teardownPeer(sessionId: string, reason: string): void {
    const peer = this.peers.get(sessionId);
    this.log(`🔌 Tearing down ${sessionId.slice(0, 8)}... (${reason})`, 'info');

    if (peer) {
      try {
        peer.rtc?.close();
      } catch (_) { }
    } else {
      this.sessionGenerations.delete(sessionId);
      this.pendingSessions.delete(sessionId);
    }
  }

  // Public API
  public sendToPeer(sessionId: string, packet: any): boolean {
  const peer = this.peers.get(sessionId);
  const currentGen = this.sessionGenerations.get(sessionId);

  this.log(`📤 sendToPeer called for ${sessionId.slice(0, 8)}...`, 'info');
  this.log(`   Peer exists: ${!!peer}`, 'info');
  this.log(`   Peer.rtc exists: ${!!peer?.rtc}`);
  this.log(`   Peer.send exists: ${!!peer?.send}`);
  this.log(`   Generation match: ${peer?.generation === currentGen}`);

  if (peer && peer.rtc && peer.generation === currentGen) {
    try {
      if (typeof peer.send !== 'function') {
        this.log(`❌ peer.send is not a function! Type: ${typeof peer.send}`);
        return false;
      }
      peer.send(packet);
      peer.lastActivity = new Date();
      return true;
    } catch (err: any) {
      this.log(`❌ Failed to send to ${sessionId.slice(0, 8)}...: ${err.message}`);
      return false;
    }
  }
  return false;
}

  public broadcast(packet: any, excludeSessionId?: string): void {
    let sent = 0;
    for (const [sessionId, peer] of this.peers.entries()) {
      const currentGen = this.sessionGenerations.get(sessionId);
      if (sessionId !== excludeSessionId && peer.rtc && peer.generation === currentGen) {
        try {
          peer.send(packet);
          sent++;
        } catch (err: any) {
          this.log(`❌ Broadcast failed to ${sessionId.slice(0, 8)}...: ${err.message}`, 'error');
        }
      }
    }
    if (sent > 0) {
      this.log(`📡 Broadcast to ${sent} peers`, 'debug');
    }
  }

  public getPeers(): string[] {
    return Array.from(this.peers.values())
      .filter(peer => peer.generation === this.sessionGenerations.get(peer.sessionId))
      .map(peer => peer.sessionId);
  }

  public getPeerCount(): number {
    return this.getActivePeerCount();
  }

  public getMaxConnections(): number {
    return this.maxConnections;
  }

  public disconnectPeer(sessionId: string): void {
    this.teardownPeer(sessionId, 'manual disconnect');
  }

  public disconnectAll(): void {
    this.log(`🔌 Disconnecting all ${this.peers.size} peers...`, 'info');
    for (const sessionId of [...this.peers.keys()]) {
      this.teardownPeer(sessionId, 'disconnectAll');
    }
    this.pendingSessions.clear();
    this.log('✅ All peers disconnected', 'info');
  }

  public close(): void {
    this._isClosing = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.disconnectAll();
    this.socket.off('signal');
    this.socket.off('client_session');
    this.socket.off('client_disconnected');
  }
}