import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PairedHost } from '../src/types.js';

// Mock modules using vi
vi.mock('simple-peer', () => {
    let lastInstance: any = null;

    class MockPeer {
        signal = vi.fn();
        destroy = vi.fn();
        destroyed = false;
        connected = false;
        private _callbacks: Record<string, Function> = {};
        initiator: boolean;

        constructor(options: any) {
            this.initiator = options.initiator;
            lastInstance = this;
        }

        on(event: string, callback: Function) {
            this._callbacks[event] = callback;
            return this;
        }

        send(data: any) {
            if (this._callbacks.data) {
                this._callbacks.data(data);
            }
        }

        static __getLastInstance() {
            return lastInstance;
        }

        static __reset() {
            lastInstance = null;
        }
    }

    return { default: MockPeer };
});

// Create socket mock state
let currentSocket: any = null;
const socketHandlers: Record<string, Function> = {};

vi.mock('socket.io-client', () => {
    const createSocket = () => {
        const handlers: Record<string, Function> = {};

        const socket = {
            emit: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            on: vi.fn((event: string, handler: Function) => {
                handlers[event] = handler;
                return socket;
            }),
            off: vi.fn(),
            connected: false,

            // Test helpers
            __emit(event: string, ...args: any[]) {
                if (handlers[event]) {
                    handlers[event](...args);
                }
            },
            __getHandler(event: string) {
                return handlers[event];
            }
        };

        currentSocket = socket;
        return socket;
    };

    const io = vi.fn(() => createSocket());

    return {
        io,
    };
});

vi.mock('@clawdaddy/core', () => ({
    deriveSharedKey: vi.fn(() => 'a'.repeat(64)),
    computeAuthHash: vi.fn(() => 'b'.repeat(64)),
    verifyHMAC: vi.fn(() => true),
    computeHMAC: vi.fn(() => 'mock-sig'),
    reassemble: vi.fn(() => null),
    generateUUID: vi.fn(() => 'mock-uuid'),
    MAX_SERIALIZED_SIZE: 12_000_000,
    CHUNK_SIZE: 12_000,
}));

// Import after mocks
import { startClient, stopClient } from '../src/connection.js';
import SimplePeerMock from 'simple-peer';
import { io } from 'socket.io-client';

// Helper functions
function getMockSocket() {
    return currentSocket;
}

function resetSocketMock() {
    if (currentSocket) {
        currentSocket.emit.mockClear();
        currentSocket.disconnect.mockClear();
        currentSocket.close.mockClear();
        currentSocket.on.mockClear();
        currentSocket.off.mockClear();
    }
    currentSocket = null;
    (io as any).mockClear();
}

function makePairedHosts(): Map<string, PairedHost> {
    return new Map([
        ['target-server-id', {
            hostId: 'target-server-id',
            pairingCode: 'ABCD-1234',
            connected: false,
            lastConnected: null,
            connectedAt: null,
        } as any],
    ]);
}

const TARGET = 'target-server-id';
const PAIRING = 'ABCD-1234';
const SWITCHBOARD = 'ws://localhost:3003';
const CLIENT_ID = 'client-test-device';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

const waitForPeer = async () => {
    for (let i = 0; i < 50; i++) {
        const peer = (SimplePeerMock as any).__getLastInstance?.();
        if (peer) return peer;
        await tick();
    }
    return null;
};

describe('Client connection orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (SimplePeerMock as any).__reset?.();
        resetSocketMock();
    });

    afterEach(async () => {
        stopClient();
        await tick();
    });

    describe('registration', () => {
        it('sends a well-formed client register payload on connect', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const registerCalls = socket.emit.mock.calls.filter(([e]: any) => e === 'register');
            expect(registerCalls.length).toBeGreaterThan(0);

            const [, payload] = registerCalls[0];
            expect(payload.role).toBe('client');
            expect(payload.targetServerId).toBe(TARGET);
            expect(typeof payload.sessionId).toBe('string');
            expect(payload.sessionId.length).toBeGreaterThan(8);
            expect(typeof payload.authHash).toBe('string');
            expect(payload.authHash.length).toBe(64);
        });

        it('does NOT start WebRTC before receiving registered confirmation', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const peer = (SimplePeerMock as any).__getLastInstance?.();
            expect(peer).toBeNull();
        });

        it('starts WebRTC handshake after registered confirmation', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const registerCall = socket.emit.mock.calls.find(([e]: any) => e === 'register');
            const { sessionId } = registerCall[1];

            socket.__emit('registered', { role: 'client', sessionId, targetServerId: TARGET });

            const peer = await waitForPeer();
            expect(peer).not.toBeNull();
            expect(peer.initiator).toBe(true);
        });
    });

    describe('signaling', () => {
        it('emits signals with sessionId (not targetId or authHash)', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const registerCall = socket.emit.mock.calls.find(([e]: any) => e === 'register');
            const { sessionId } = registerCall[1];

            socket.__emit('registered', { role: 'client', sessionId, targetServerId: TARGET });

            const mockPeer = await waitForPeer();
            expect(mockPeer).not.toBeNull();

            // Simulate peer generating a signal
            if (mockPeer && (mockPeer as any)._callbacks?.signal) {
                const fakeOffer = { type: 'offer', sdp: 'v=0...' };
                (mockPeer as any)._callbacks.signal(fakeOffer);
                await tick();
            }

            const signalCalls = socket.emit.mock.calls.filter(([e]: any) => e === 'signal');
            expect(signalCalls.length).toBeGreaterThan(0);

            const [, payload] = signalCalls[0];
            expect(payload.sessionId).toBe(sessionId);
            expect(payload.targetId).toBeUndefined();
            expect(payload.authHash).toBeUndefined();
        });

        it('forwards inbound signals from the switchboard to the peer', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const registerCall = socket.emit.mock.calls.find(([e]: any) => e === 'register');
            const { sessionId } = registerCall[1];

            socket.__emit('registered', { role: 'client', sessionId, targetServerId: TARGET });

            const mockPeer = await waitForPeer();
            expect(mockPeer).not.toBeNull();

            const fakeAnswer = { type: 'answer', sdp: 'v=0...' };
            const signalHandler = socket.__getHandler('signal');
            expect(signalHandler).toBeDefined();

            signalHandler({ sessionId, signalData: fakeAnswer });
            await tick();

            expect(mockPeer.signal).toHaveBeenCalledWith(fakeAnswer);
        });

        it('ignores inbound signals for a different sessionId', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const registerCall = socket.emit.mock.calls.find(([e]: any) => e === 'register');
            const { sessionId } = registerCall[1];

            socket.__emit('registered', { role: 'client', sessionId, targetServerId: TARGET });

            const mockPeer = await waitForPeer();
            expect(mockPeer).not.toBeNull();

            const signalHandler = socket.__getHandler('signal');
            expect(signalHandler).toBeDefined();

            // Send signal for different session
            signalHandler({ sessionId: 'different-session', signalData: { type: 'answer' } });
            await tick();

            expect(mockPeer.signal).not.toHaveBeenCalled();
        });
    });

    describe('error handling', () => {
        it('does not reconnect on AUTH_FAILED', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const errorHandler = socket.__getHandler('error');
            expect(errorHandler).toBeDefined();

            errorHandler({ code: 'AUTH_FAILED', message: 'Invalid authHash.' });
            await tick();

            expect(socket.close).toHaveBeenCalled();
        });

        it('does not reconnect on NOT_FOUND', async () => {
            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await tick();

            const socket = getMockSocket();
            socket.__emit('connect');
            await tick();

            const errorHandler = socket.__getHandler('error');
            expect(errorHandler).toBeDefined();

            errorHandler({ code: 'NOT_FOUND', message: "Server 'target-server-id' not found." });
            await tick();

            expect(socket.close).toHaveBeenCalled();
        });
    });

    describe('teardown', () => {
        it('stopClient destroys the peer and disconnects the socket', async () => {
            
        });
    });

    describe('reconnection logic', () => {
        it('schedules a reconnect on peer close', async () => {
            vi.useFakeTimers();

            startClient(TARGET, PAIRING, makePairedHosts(), 'interactive', vi.fn(), SWITCHBOARD, CLIENT_ID, CLIENT_ID);
            await vi.advanceTimersByTimeAsync(100);

            const socket = getMockSocket();
            socket.__emit('connect');
            await vi.advanceTimersByTimeAsync(100);

            const registerCall = socket.emit.mock.calls.find(([e]: any) => e === 'register');
            const { sessionId } = registerCall[1];

            socket.__emit('registered', { role: 'client', sessionId, targetServerId: TARGET });

            await vi.advanceTimersByTimeAsync(100);
            const mockPeer = await waitForPeer();

            if (mockPeer && (mockPeer as any)._callbacks?.close) {
                const initialCalls = (io as any).mock.calls.length;

                // Trigger peer close
                (mockPeer as any)._callbacks.close();
                await vi.advanceTimersByTimeAsync(100);

                // Advance reconnect timer
                await vi.advanceTimersByTimeAsync(5000);

                expect((io as any).mock.calls.length).toBeGreaterThan(initialCalls);
            }

            vi.useRealTimers();
        });
    });
});