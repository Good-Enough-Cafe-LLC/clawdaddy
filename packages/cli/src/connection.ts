// ─── Connection ──────────────────────────────────────────────────────────────
//
// Manages the Socket.IO signaling connection, WebRTC peer lifecycle,
// and reconnect back-off.
//
// Secure messaging (sendSecure, sendCommand, sendInference, pendingRequests)
// lives in transport.ts so the local Unix socket transport shares the same
// interface without any duplication.

import { io } from 'socket.io-client';
import Peer from 'simple-peer';
import wrtc from '@koush/wrtc';
import { randomUUID } from 'node:crypto';

import {
    deriveSharedKey,
    computeAuthHash,
    computeHMAC,
    verifyHMAC,
    ClawdaddyMessage,
    SecurePacket,
    reassemble,
    ChunkFrame,
    MAX_SERIALIZED_SIZE,
    CHUNK_SIZE,
} from '@clawdaddy/core';

import {
    setTransport,
    clearTransport,
    handleInboundPacket,
} from './transport.js';

import type { PairedHost } from './types.js';
import type { ConnectionState } from './types.js';

// ─── Module-level state ───────────────────────────────────────────────────────

let activePeer: InstanceType<typeof Peer> | null = null;
let activeSocket: ReturnType<typeof io> | null = null;
let currentSharedKey: Buffer | null = null;
let currentAuthHash: string | null = null;
let activeHostId: string | null = null;

export let connectionState: ConnectionState = {
    status: 'idle',
    activeHostId: null,
    switchboardConnected: false,
    error: null,
};

let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function updateConnectionState(updates: Partial<ConnectionState>): void {
    connectionState = { ...connectionState, ...updates };
}

// ─── Reconnect back-off ───────────────────────────────────────────────────────

function scheduleReconnect(start: () => void): void {
    reconnectAttempt++;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
    console.log(`🔁 Reconnecting in ${Math.round(delay / 1000)}s...`);
    reconnectTimer = setTimeout(start, delay);
}

function clearReconnect(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempt = 0;
}

// ─── WebRTC handshake ─────────────────────────────────────────────────────────

function startHandshake(
    socket: ReturnType<typeof io>,
    sessionId: string,
    targetId: string,
    authHash: string,
    pairingCode: string,
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    SIGNAL_SERVER: string,
    INITIATOR_ID: string,
    clientId: string,
): void {
    console.log(`📡 Attempting to reach ${targetId} (session: ${sessionId.slice(0, 8)}...)`);
    updateConnectionState({ status: 'connecting', activeHostId: targetId, error: null });

    console.log('🔄 Creating SimplePeer instance (initiator: true)...');
    const peer = new Peer({
        initiator: true,
        trickle: true,
        wrtc,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        },
    });

    // ── Outbound signals ──────────────────────────────────────────────────────
    peer.on('signal', (data: any) => {
        if (data.type === 'offer') {
            console.log(`   Offer SDP created, length: ${data.sdp?.length || 0}`);
        }
        socket.emit('signal', { sessionId, signalData: data });
    });

    // ── Inbound signals ───────────────────────────────────────────────────────
    const onSignal = ({ sessionId: incomingSession, signalData }: { sessionId: string; signalData: any }) => {
        if (incomingSession !== sessionId) return;
        if (signalData.type === 'answer') {
            console.log(`   Answer SDP received, length: ${signalData.sdp?.length || 0}`);
        }
        try {
            peer.signal(signalData);
        } catch (e: any) {
            console.error('❌ Signal error:', e.message);
        }
    };
    socket.on('signal', onSignal);

    // ── Peer connected ────────────────────────────────────────────────────────
    peer.on('connect', () => {
        console.log('🚀 P2P connected (secure channel)\n');
        activePeer = peer;
        activeHostId = targetId;

        const sharedKeyHex = deriveSharedKey(pairingCode, targetId);
        currentSharedKey = Buffer.from(sharedKeyHex, 'hex');

        const now = new Date().toISOString();
        const host = pairedHosts.get(targetId);
        if (host) {
            host.connected = true;
            host.lastConnected = now;
            host.connectedAt = now;
            pairedHosts.set(targetId, host);

            import('./storage.js').then(({ updateLastConnected }) => {
                updateLastConnected(targetId);
            }).catch(err => {
                console.warn('Could not update lastConnected in storage:', err.message);
            });
        }

        updateConnectionState({ status: 'connected', activeHostId: targetId, error: null });
        clearReconnect();

        // Register with transport singleton so api.ts / interactive.ts can call
        // sendSecure() / sendCommand() etc. without touching activePeer directly.
        setTransport(
            (packet: any) => {
                if (!activePeer || activePeer.destroyed || !currentSharedKey) {
                    throw new Error('No active P2P connection or missing shared key');
                }
                const keyHex = currentSharedKey.toString('hex');
                const signature = computeHMAC(keyHex, packet);
                const secure: SecurePacket = { payload: packet, signature };
                const serialised = JSON.stringify(secure);

                if (serialised.length > MAX_SERIALIZED_SIZE) {
                    console.error(`❌ Cannot send: message too large (${serialised.length} bytes > ${MAX_SERIALIZED_SIZE})`);
                    return;
                }

                const id = randomUUID();
                const total = Math.ceil(serialised.length / CHUNK_SIZE);
                for (let i = 0; i < total; i++) {
                    const frame: ChunkFrame = {
                        id, index: i, total,
                        data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
                    };
                    activePeer.send(JSON.stringify(frame));
                }
                if (total > 1) console.log(`📤 Sent ${total} chunks (${serialised.length} bytes)`);
            },
            () => !!activePeer && !activePeer.destroyed,
            targetId,
        );

        import('./transport.js').then(({ sendCommand }) => {
            sendCommand('identify', { clientId }).then((result: any) => {
                if (result?.ltmFacts > 0) {
                    console.log(`🧠 Server loaded ${result.ltmFacts} LTM facts for this client`);
                }
            }).catch(() => {
                // Server may be older version without identify support — safe to ignore
            });
        });

        clearReconnect();
        onConnected();
    });

    // ── Inbound data ──────────────────────────────────────────────────────────
    peer.on('data', (data: Buffer) => {
        const raw = data.toString();

        let frame: ChunkFrame;
        try {
            frame = JSON.parse(raw);
        } catch {
            console.error('❌ Malformed frame (not JSON)');
            return;
        }

        if (typeof frame.id !== 'string' || typeof frame.index !== 'number' || typeof frame.total !== 'number') {
            console.error('❌ Unexpected frame shape:', Object.keys(frame));
            return;
        }

        const serialised = reassemble(frame);
        if (serialised === null) return;

        let packet: SecurePacket;
        try {
            packet = JSON.parse(serialised);
        } catch {
            console.error('❌ Malformed packet after reassembly');
            return;
        }

        if (!currentSharedKey) {
            console.error('❌ No shared key — cannot verify message');
            return;
        }

        const keyHex = currentSharedKey.toString('hex');
        if (!verifyHMAC(keyHex, packet.payload, packet.signature)) {
            console.error('❌ HMAC verification failed — possible tampering or wrong key');
            return;
        }

        handleInboundPacket(packet.payload);
    });

    // ── Cleanup ───────────────────────────────────────────────────────────────
    const cleanup = (reconnect: boolean) => {
        socket.off('signal', onSignal);
        clearTransport();
        activePeer = null;
        currentSharedKey = null;
        currentAuthHash = null;
        peer.destroy();

        if (reconnect) {
            scheduleReconnect(() =>
                startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID, clientId)
            );
        }
    };

    peer.on('error', (err: { message: any }) => {
        console.error('❌ Peer error:', err.message);
        updateConnectionState({ status: 'error', error: err.message });
        cleanup(true);
    });

    peer.on('close', () => {
        console.log('🔌 P2P connection closed');
        const host = pairedHosts.get(targetId);
        if (host) { host.connected = false; pairedHosts.set(targetId, host); }
        if (activeHostId === targetId) {
            activeHostId = null;
            updateConnectionState({ status: 'idle', activeHostId: null });
        }
        cleanup(true);
    });
}

// ─── Client lifecycle ─────────────────────────────────────────────────────────

export async function startClient(
    targetId: string,
    pairingCode: string,
    pairedHosts: Map<string, PairedHost>,
    mode: string,
    onConnected: () => void,
    SIGNAL_SERVER: string,
    INITIATOR_ID: string,
    clientId: string,
): Promise<void> {
    stopClient(pairedHosts);

    const sharedKey = deriveSharedKey(pairingCode, targetId);
    const authHash = computeAuthHash(sharedKey);

    console.log('🔐 CLIENT DEBUG:');
    console.log(`   Target ID:    ${targetId}`);
    console.log(`   Pairing Code: ${pairingCode}`);

    currentSharedKey = Buffer.from(sharedKey, 'hex');
    currentAuthHash = authHash;

    console.log('🌐 Connecting to switchboard...');
    updateConnectionState({ status: 'connecting', switchboardConnected: false });

    const socket = io(SIGNAL_SERVER, { transports: ['websocket'], reconnection: false });
    activeSocket = socket;

    socket.on('connect', () => {
        reconnectAttempt = 0;
        console.log('✅ Connected to switchboard');
        updateConnectionState({ switchboardConnected: true });

        const sessionId = randomUUID();
        console.log(`📝 Registering client session: ${sessionId.slice(0, 8)}...`);
        console.log(`🎯 Target server: ${targetId}`);
        console.log(`🔑 Auth hash: ${authHash.slice(0, 16)}...`);

        socket.emit('register', {
            role: 'client',
            sessionId,
            targetServerId: targetId,
            authHash,
        });
    });

    socket.on('registered', ({ role, sessionId }: { role: string; sessionId: string }) => {
        if (role !== 'client') return;
        console.log(`✅ Session registered: ${sessionId.slice(0, 8)}...`);
        console.log(`🚀 Starting handshake with ${targetId}`);
        startHandshake(socket, sessionId, targetId, authHash, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID, clientId);
    });

    socket.on('error', ({ code, message }: { code: string; message: string }) => {
        console.error(`❌ Switchboard error [${code}]: ${message}`);
        updateConnectionState({ status: 'error', error: message });
        if (code === 'AUTH_FAILED' || code === 'NOT_FOUND') {
            socket.close();
            return;
        }
        scheduleReconnect(() =>
            startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID, clientId)
        );
    });

    socket.on('disconnect', () => {
        console.log('⚠️ Disconnected from switchboard');
        updateConnectionState({ switchboardConnected: false });
        activePeer?.destroy();
        activePeer = null;
        scheduleReconnect(() =>
            startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID, clientId)
        );
    });

    socket.on('connect_error', (e: Error) => {
        console.error('❌ Switchboard error:', e.message);
        updateConnectionState({ status: 'error', error: e.message, switchboardConnected: false });
        socket.close();
        scheduleReconnect(() =>
            startClient(targetId, pairingCode, pairedHosts, mode, onConnected, SIGNAL_SERVER, INITIATOR_ID, clientId)
        );
    });
}

export function stopClient(pairedHosts?: Map<string, PairedHost>): void {
    clearReconnect();
    clearTransport();

    if (activePeer) { activePeer.destroy(); activePeer = null; }
    if (activeSocket) { activeSocket.close(); activeSocket = null; }

    currentSharedKey = null;
    currentAuthHash = null;

    if (activeHostId && pairedHosts) {
        const host = pairedHosts.get(activeHostId);
        if (host) { host.connected = false; pairedHosts.set(activeHostId, host); }
        activeHostId = null;
    }

    updateConnectionState({ status: 'idle', activeHostId: null });
}