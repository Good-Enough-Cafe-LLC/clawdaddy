import Peer from 'simple-peer';
const wrtc = require('@koush/wrtc');
import { verifyHMAC, reassemble, ChunkFrame, computeHMAC, MAX_SERIALIZED_SIZE, CHUNK_SIZE } from '@clawdaddy/core';
import { generateUUID } from '@clawdaddy/core';

// ─── Chunked send ─────────────────────────────────────────────────────────────

function sendChunked(
    peer: any,
    packet: any,
    sharedKey: string,
    log: (msg: string, type?: string) => void,
): void {
    const signature   = computeHMAC(sharedKey, packet);
    const securePacket = { payload: packet, signature };
    const serialised  = JSON.stringify(securePacket);

    if (serialised.length > MAX_SERIALIZED_SIZE) {
        log(`❌ Cannot send: message too large (${serialised.length} bytes > ${MAX_SERIALIZED_SIZE})`, 'error');
        return;
    }

    const id    = generateUUID();
    const total = Math.ceil(serialised.length / CHUNK_SIZE);

    for (let i = 0; i < total; i++) {
        const frame: ChunkFrame = {
            id,
            index: i,
            total,
            data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        };
        peer.send(JSON.stringify(frame));
    }

    if (total > 1) {
        log(`📤 Sent ${total} chunks (${serialised.length} bytes)`);
    }
}

// ─── createWebRTC ─────────────────────────────────────────────────────────────
//
// Role semantics:
//
//   initiator  — the client (connection.ts). Owns the socket signal listener.
//                Sends signals to the server using sessionId as the routing key.
//                Receives signals via the socket listener set up here.
//
//   receiver   — the server (MultiPeerManager). Does NOT set up a socket listener
//                here — MultiPeerManager owns the socket and calls rtc.signal()
//                directly when it receives a forwarded signal. Outbound signals
//                (answer, ICE candidates) are emitted with { sessionId, signalData }.

export function createWebRTC({
    socket,
    authHash,
    sharedKey,
    role,
    sessionId,
    onData,
    onOpen,
    onClose,
    log,
}: {
    socket:     any;
    authHash:   string;
    sharedKey:  string;
    role:       'initiator' | 'receiver';
    sessionId:  string;        // required for both roles; used as the switchboard routing key
    onData:     (data: any) => void;
    onOpen:     () => void;
    onClose:    () => void;
    log:        (msg: string, type?: string) => void;
}) {
    const peer = new Peer({
        initiator: role === 'initiator',
        trickle:   true,
        wrtc,
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' },
            ],
        },
    });

    // ── Outbound signals ──────────────────────────────────────────────────────
    // Both roles emit { sessionId, signalData } — the switchboard routes by
    // sessionId and the socket identity (server vs client).
    // No authHash needed on signals; the switchboard already verified it at
    // registration time.
    let answeredOnce = false;

    peer.on('signal', (data: any) => {
        // Deduplicate answers — SimplePeer can emit more than one in edge cases
        if (data.type === 'answer') {
            if (answeredOnce) {
                log(`⚠️ Skipping duplicate answer signal`, 'warn');
                return;
            }
            answeredOnce = true;
        }

        const ts = new Date().toISOString().slice(11, 19);
        //log(`${ts} 📡 Sending signal type=${data.type ?? 'candidate'} sessionId=${sessionId.slice(0, 8)}...`);
        socket.emit('signal', { sessionId, signalData: data });
    });

    // ── Inbound signals ───────────────────────────────────────────────────────
    // Initiator: listens on the socket directly (one listener per connection).
    // Receiver:  MultiPeerManager calls rtc.signal() externally — no socket
    //            listener here to avoid duplicate handlers.
    let socketSignalHandler: ((payload: any) => void) | null = null;

    if (role === 'initiator') {
        socketSignalHandler = ({ sessionId: incomingSession, signalData }: any) => {
            // Guard against signals meant for a different session
            if (incomingSession !== sessionId) return;

            const ts = new Date().toISOString().slice(11, 19);
            if (signalData.type === 'answer') {
                log(`${ts}    Answer SDP received, length: ${signalData.sdp?.length ?? 0}`);
            }
            try {
                peer.signal(signalData);
            } catch (e: any) {
                log(`❌ Signal error: ${e.message}`, 'error');
            }
        };

        socket.on('signal', socketSignalHandler);
    }

    // ── Peer events ───────────────────────────────────────────────────────────

    peer.on('connect', () => {
        log('🚀 WebRTC connected');
        onOpen();
    });

    peer.on('data', (data: Buffer) => {
        const ts        = new Date().toISOString().slice(11, 19);
        const rawString = data.toString();

        // ── Parse chunk frame ─────────────────────────────────────────────
        let frame: ChunkFrame;
        try {
            frame = JSON.parse(rawString);
        } catch (e: any) {
            log(`${ts} ❌ Failed to parse frame: ${e.message}`, 'error');
            return;
        }

        if (
            typeof frame.id    !== 'string' ||
            typeof frame.index !== 'number' ||
            typeof frame.total !== 'number'
        ) {
            log(`${ts} ❌ Unexpected frame shape — keys: ${Object.keys(frame).join(', ')}`, 'error');
            return;
        }

        if (frame.index < 0 || frame.total <= 0 || frame.index >= frame.total) {
            log(`${ts} ❌ Invalid chunk indices: index=${frame.index}, total=${frame.total}`, 'error');
            return;
        }

        // ── Reassemble ────────────────────────────────────────────────────
        const serialised = reassemble(frame);
        if (serialised === null) {
            log(`${ts} 🧩 Chunk ${frame.index + 1}/${frame.total} buffered, waiting for more...`);
            return;
        }

        // ── Parse packet ──────────────────────────────────────────────────
        let packet: any;
        try {
            packet = JSON.parse(serialised);
        } catch (e: any) {
            log(`${ts} ❌ Failed to parse reassembled packet: ${e.message}`, 'error');
            return;
        }

        // ── Verify HMAC and dispatch ──────────────────────────────────────
        if (packet.signature && packet.payload) {
            if (!verifyHMAC(sharedKey, packet.payload, packet.signature)) {
                log(`${ts} ❌ HMAC verification failed`, 'error');
                return;
            }
            try {
                onData(packet.payload);
            } catch (err: any) {
                log(`${ts} ❌ onData error: ${err.message}`, 'error');
            }
        } else {
            // Legacy / non-HMAC packet — pass through as-is
            try {
                onData(packet);
            } catch (err: any) {
                log(`${ts} ❌ onData error (non-HMAC): ${err.message}`, 'error');
            }
        }
    });

    peer.on('error', (err: any) => {
        log(`❌ WebRTC error: ${err.message}`, 'error');
        cleanup();
        onClose();
    });

    peer.on('close', () => {
        log('🔌 WebRTC closed');
        cleanup();
        onClose();
    });

    // ── Cleanup ───────────────────────────────────────────────────────────────

    let cleanedUp = false;
    function cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        if (socketSignalHandler) {
            socket.off('signal', socketSignalHandler);
            socketSignalHandler = null;
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    return {
        /** Send a packet over the data channel (chunked + HMAC-signed). */
        send: (packet: any) => {
            if (!peer.connected) {
                log('⚠️ Cannot send: peer not connected', 'warn');
                return;
            }
            sendChunked(peer, packet, sharedKey, log);
        },

        /** Deliver an inbound signal to the peer (called externally by MultiPeerManager). */
        signal: (signalData: any) => {
            try {
                peer.signal(signalData);
            } catch (e: any) {
                log(`❌ signal() error: ${e.message}`, 'error');
            }
        },

        /** Tear down the peer and remove socket listeners. */
        close: () => {
            cleanup();
            if (!peer.destroyed) peer.destroy();
        },

        /** Expose the raw peer for advanced inspection (e.g. signalingState checks). */
        peer,
    };
}