// src/localTransport.ts
//
// Client-side local transport. Connects to the server's Unix domain socket
// instead of going through the switchboard + WebRTC stack.
//
// Calls setTransport() when connected so api.ts and interactive.ts work
// identically regardless of which transport is active.

import net from 'net';
import { getSocketPath } from '@clawdaddy/core';
import { setTransport, clearTransport, handleInboundPacket } from './transport.js';
import { updateLastConnected } from './storage.js';

export interface LocalTransportOptions {
    hostId:    string;
    onConnect: () => void;
    onClose:   () => void;
    log:       (msg: string, type?: string) => void;
}

export function createLocalTransport(options: LocalTransportOptions) {
    const { hostId, onConnect, onClose, log } = options;
    const socketPath = getSocketPath(hostId);

    let socket:   net.Socket | null = null;
    let destroyed = false;
    let buffer    = '';
    let connected = false;

    // Internal send — exposed on the return value so cli.ts can call it
    // directly when wiring up the local mode, and also registered with
    // setTransport() so api.ts / interactive.ts use it transparently.
    const send = (packet: any) => {
        if (!socket || socket.destroyed) {
            log('⚠️  Cannot send: local socket not connected', 'error');
            return;
        }
        socket.write(JSON.stringify(packet) + '\n');
    };

    socket = net.createConnection(socketPath);

    socket.on('connect', () => {
        connected = true;
        log(`🔌 Local transport connected (${socketPath})`, 'success');

        setTransport(
            send,
            () => connected,
            hostId,
        );

        onConnect();
        try {            
            updateLastConnected(hostId);
        } catch (e) {
            //
        }
    });

    // Newline-delimited JSON — one packet per line
    socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const packet = JSON.parse(line);
                handleInboundPacket(packet);
            } catch (e) {
                log(`❌ Malformed packet from local server: ${e}`, 'error');
            }
        }
    });

    socket.on('close', () => {
        connected = false;
        log('🔌 Local transport closed', 'error');
        clearTransport();
        socket = null;
        if (!destroyed) onClose();
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
            log(`❌ No server socket found at ${socketPath}`, 'error');
            log(`   Is the server running with --local?`, 'error');
        } else if (err.code === 'ECONNREFUSED') {
            log(`❌ Server not accepting connections at ${socketPath}`, 'error');
        } else {
            log(`❌ Local transport error: ${err.message}`, 'error');
        }
        clearTransport();
        if (!destroyed) onClose();
    });

    return {
        send,
        disconnect: () => {
            destroyed = true;
            clearTransport();
            if (socket) { socket.destroy(); socket = null; }
        },
        socketPath,
    };
}