// src/transport.ts
//
// Single source of truth for the active transport on the client side.

import { generateUUID } from '@clawdaddy/core';

// ─── Handler registry ─────────────────────────────────────────────────────────
// Mirrors the pendingRequests map that was previously in connection.ts.
// Kept here so both api.ts and interactive.ts share the same map regardless
// of which transport is active.

export type PendingHandler = {
    onToken?:         (token: string) => void;
    onDone?:          (stats: any) => void;
    onError?:         (error: string) => void;
    onCommandResult?: (result: any) => void;
    inputTokens?:     number;
};

export const pendingRequests = new Map<string, PendingHandler>();

// ─── Transport slots ──────────────────────────────────────────────────────────

type SendFn      = (packet: any) => void;
type ConnectedFn = () => boolean;

let _send:        SendFn      | null = null;
let _isConnected: ConnectedFn | null = null;
let _activeHostId: string     | null = null;

// ─── Public: set by transports ────────────────────────────────────────────────

/**
 * Called by connection.ts (WebRTC) or localTransport.ts (Unix socket)
 * when a connection is established.
 */
export function setTransport(send: SendFn, isConnected: ConnectedFn, hostId: string): void {
    _send        = send;
    _isConnected = isConnected;
    _activeHostId = hostId;
}

/**
 * Called when the transport tears down (disconnect, error, etc.).
 */
export function clearTransport(): void {
    _send         = null;
    _isConnected  = null;
    _activeHostId = null;

    // Fail any in-flight requests
    for (const [id, handler] of pendingRequests.entries()) {
        handler.onError?.('Connection lost');
        pendingRequests.delete(id);
    }
}

// ─── Public: used by api.ts and interactive.ts ────────────────────────────────

export function isConnected(): boolean {
    return !!_isConnected?.();
}

export function getActiveHostId(): string | null {
    return _activeHostId;
}

/**
 * Send a raw packet over whichever transport is active.
 * Throws if no transport is connected.
 */
export function sendSecure(packet: any): void {
    if (!_send) throw new Error('No active transport');
    _send(packet);
}

/**
 * Send a command and return a promise that resolves with the result.
 */
export function sendCommand(command: string, payload?: any): Promise<any> {
    if (!_send) return Promise.reject(new Error('Not connected'));

    const requestId = generateUUID();

    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, {
            onCommandResult: (result) => {
                pendingRequests.delete(requestId);
                resolve(result);
            },
            onError: (err) => {
                pendingRequests.delete(requestId);
                reject(new Error(err));
            },
        });

        setTimeout(() => {
            if (pendingRequests.has(requestId)) {
                pendingRequests.get(requestId)?.onError?.('Timed out');
                pendingRequests.delete(requestId);
            }
        }, 10_000);

        try {
            sendSecure({ type: 'command', requestId, command, payload });
        } catch (e: any) {
            pendingRequests.delete(requestId);
            reject(e);
        }
    });
}

/**
 * Send an inference request. Tokens, done, and error come back via
 * pendingRequests handlers registered by the caller (api.ts / interactive.ts).
 */
export function sendInference(
    messages: { role: string; content: string }[],
    options?: { temperature?: number; max_tokens?: number; stream?: boolean },
): Promise<void> {
    if (!_send) return Promise.reject(new Error('Not connected'));

    const requestId = generateUUID();

    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, {
            onToken: (token) => process.stdout.write(token),
            onDone: (stats) => {
                console.log(`\n\n⚡ ${stats.tokens} tokens · ${stats.tps.toFixed(1)} tok/s · ${stats.ms}ms`);
                pendingRequests.delete(requestId);
                resolve();
            },
            onError: (err) => {
                console.error(`\n❌ ${err}`);
                pendingRequests.delete(requestId);
                reject(new Error(err));
            },
        });

        try {
            sendSecure({ type: 'inference', requestId, messages, options });
        } catch (e: any) {
            pendingRequests.delete(requestId);
            reject(e);
        }
    });
}

/**
 * Dispatch an inbound packet from the server into the pending handler registry.
 * Called by both connection.ts and localTransport.ts when data arrives.
 */
export function handleInboundPacket(packet: any): void {
    const handler = pendingRequests.get(packet.requestId);
    if (!handler) return;

    switch (packet.type) {
        case 'token':          handler.onToken?.(packet.token);               break;
        case 'done':           handler.onDone?.(packet.stats);                pendingRequests.delete(packet.requestId); break;
        case 'error':          handler.onError?.(packet.error);               pendingRequests.delete(packet.requestId); break;
        case 'command_result': handler.onCommandResult?.(packet.result);      pendingRequests.delete(packet.requestId); break;
        case 'command_error':  handler.onError?.(packet.error);               pendingRequests.delete(packet.requestId); break;
    }
}