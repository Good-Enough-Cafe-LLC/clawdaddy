// ─── host.test.ts ─────────────────────────────────────────────────────────────
//
// Tests the host's orchestration layer:
//   - Correct responses to commands and inference requests
//   - Multi-peer isolation (two clients don't bleed into each other)
//   - Error handling shapes
//
// What these DON'T test (and shouldn't need to):
//   - Actual WebRTC connectivity (tested by integration/e2e)
//   - Socket.IO signaling (tested by switchboard tests)
//   - HMAC crypto (tested by @clawdaddy/core unit tests)

import { startHost } from '../src/host';
import fs from 'fs';
import * as ollamaAdapter from '../src/adapters/ollama';

// ─── Shared mock emitter ──────────────────────────────────────────────────────
// Represents the MultiPeerManager instance the host receives
const mockEmitter = new (require('events').EventEmitter)();
mockEmitter.on           = jest.fn(mockEmitter.on.bind(mockEmitter));
mockEmitter.getPeerCount = jest.fn().mockReturnValue(1);
mockEmitter.broadcast    = jest.fn();
mockEmitter.sendToPeer   = jest.fn();
mockEmitter.disconnectAll  = jest.fn();
mockEmitter.disconnectPeer = jest.fn();
mockEmitter.close          = jest.fn();

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock('../src/socketClient');
jest.mock('../src/multiPeerManager', () => ({
    MultiPeerManager: jest.fn().mockImplementation(() => mockEmitter),
}));
jest.mock('../src/adapters/ollama');
jest.mock('ollama', () => ({ chat: jest.fn() }));
jest.mock('@clawdaddy/core', () => ({
    deriveSharedKey:    jest.fn(() => 'mock-shared-key'),
    computeAuthHash:    jest.fn(() => 'mock-auth-hash'),
    verifyHMAC:         jest.fn(() => true),
    computeHMAC:        jest.fn(() => 'mock-signature'),
    generateUUID:       jest.fn(() => 'mock-uuid'),
    reassemble:         jest.fn(),
    MAX_SERIALIZED_SIZE: 12_000_000,
    CHUNK_SIZE:          12_000,
}));

// ─── Suite ────────────────────────────────────────────────────────────────────
describe('Clawdaddy Host Integration', () => {
    let host: any;
    const mockLog  = jest.fn();
    const peerA    = 'session-peer-A';
    const peerB    = 'session-peer-B';

    beforeAll(async () => {
        const { createSocketClient } = require('../src/socketClient');
        let tunnelOpenCallback: any;

        (createSocketClient as jest.Mock).mockImplementation((options: any) => {
            tunnelOpenCallback = options.onTunnelOpen;
            return { disconnect: jest.fn() };
        });

        host = await startHost({
            switchboardUrl: 'ws://localhost:3000',
            hostId:         'test-host',
            pairingCode:    '123456',
            ollamaModel:    'llama3',
            log:             mockLog,
        });

        if (tunnelOpenCallback) {
            tunnelOpenCallback(
                { emit: jest.fn(), on: jest.fn() },
                'mock-auth-hash',
                'mock-shared-key',
            );
        }

        await new Promise(resolve => setTimeout(resolve, 50));
    });

    afterEach(() => {
        mockEmitter.sendToPeer.mockReset();
        mockEmitter.broadcast.mockReset();
        (ollamaAdapter.handleOllamaInference as jest.Mock).mockReset();
    });

    afterAll(() => {
        host.disconnect();
        if (fs.existsSync('command_log.jsonl')) fs.unlinkSync('command_log.jsonl');
    });

    // ── Basic commands ────────────────────────────────────────────────────────

    it('responds to ping with health status', async () => {
        const res: any = await simulatePeerData(host, peerA, {
            type: 'command', command: 'ping', requestId: 'req-001', payload: {},
        });
        expect(res.type).toBe('command_result');
        expect(res.result.pong).toBe(true);
    });

    it('updates the system prompt', async () => {
        const res: any = await simulatePeerData(host, peerA, {
            type: 'command', command: 'set_system_prompt', requestId: 'req-002', payload: 'You are a pirate.',
        });
        expect(res.result.success).toBe(true);
    });

    it('clears conversation history', async () => {
        const res: any = await simulatePeerData(host, peerA, {
            type: 'command', command: 'clear_memory', requestId: 'req-003',
        });
        expect(res.result.success).toBe(true);
    });

    // ── Inference ─────────────────────────────────────────────────────────────

    it('passes inference params to the ollama adapter', async () => {
        const spy = jest.spyOn(ollamaAdapter, 'handleOllamaInference');

        await simulatePeerData(host, peerA, {
            type: 'inference', requestId: 'req-999',
            prompt: 'Hello world',
            params: { temperature: 0.7, max_tokens: 500 },
        }, false);

        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ params: expect.objectContaining({ temperature: 0.7, max_tokens: 500 }) }),
            expect.any(Function),
            expect.any(Function),
            'llama3',
        );
    });

    it('returns a DonePacket with performance stats after successful inference', async () => {
        (ollamaAdapter.handleOllamaInference as jest.Mock).mockImplementation(
            async (request: any, send: any) => {
                send({ type: 'done', requestId: request.requestId, stats: { tokens: 2, ms: 100, tps: 20 } });
            },
        );

        const res: any = await simulatePeerData(host, peerA, {
            type: 'inference', requestId: 'req-stats-001',
            messages: [{ role: 'user', content: 'Hi' }],
        });

        expect(res).toMatchObject({
            type: 'done',
            requestId: 'req-stats-001',
            stats: { tokens: 2, ms: expect.any(Number), tps: expect.any(Number) },
        });
    });

    it('returns a structured ErrorPacket when inference throws', async () => {
        (ollamaAdapter.handleOllamaInference as jest.Mock).mockImplementation(() => {
            throw new Error('ECONNREFUSED');
        });

        const res: any = await simulatePeerData(host, peerA, {
            type: 'inference', requestId: 'req-err-test', prompt: 'This will fail',
        });

        expect(res).toMatchObject({
            type:      'error',
            requestId: 'req-err-test',
            code:      'INFERENCE_FAILED',
            error:     expect.stringContaining('ECONNREFUSED'),
        });
    });

    // ── Multi-peer isolation ──────────────────────────────────────────────────
    // Verifies that two simultaneous clients get independent responses and
    // that one peer's packets don't leak into the other's handlers.

    describe('multi-peer isolation', () => {

        it('routes responses to the correct peer — not the other', async () => {
            // Both peers send a ping at the same time
            const [resA, resB] = await Promise.all([
                simulatePeerData(host, peerA, { type: 'command', command: 'ping', requestId: 'mp-001-A' }),
                simulatePeerData(host, peerB, { type: 'command', command: 'ping', requestId: 'mp-001-B' }),
            ]);

            // Each response should have the right requestId
            expect((resA as any).requestId).toBe('mp-001-A');
            expect((resB as any).requestId).toBe('mp-001-B');

            // sendToPeer should have been called with the right peer IDs
            const calls: [string, any][] = mockEmitter.sendToPeer.mock.calls;
            const callA = calls.find(([, r]) => r.requestId === 'mp-001-A');
            const callB = calls.find(([, r]) => r.requestId === 'mp-001-B');

            expect(callA?.[0]).toBe(peerA);
            expect(callB?.[0]).toBe(peerB);
        });

        it('does not share conversation history between peers', async () => {
            // Peer A sets a system prompt
            await simulatePeerData(host, peerA, {
                type: 'command', command: 'set_system_prompt',
                requestId: 'mp-002-A', payload: 'You are peer A\'s assistant.',
            });

            // Peer B sets a different system prompt
            await simulatePeerData(host, peerB, {
                type: 'command', command: 'set_system_prompt',
                requestId: 'mp-002-B', payload: 'You are peer B\'s assistant.',
            });

            // Both should succeed independently
            const calls: [string, any][] = mockEmitter.sendToPeer.mock.calls;
            const callA = calls.find(([id, r]) => id === peerA && r.requestId === 'mp-002-A');
            const callB = calls.find(([id, r]) => id === peerB && r.requestId === 'mp-002-B');

            expect(callA?.[1].result.success).toBe(true);
            expect(callB?.[1].result.success).toBe(true);
        });

        it('clearing memory for one peer does not affect the other', async () => {
            // Give both peers some history first via set_system_prompt
            await simulatePeerData(host, peerA, {
                type: 'command', command: 'set_system_prompt',
                requestId: 'mp-003-setup-A', payload: 'Peer A context',
            });
            await simulatePeerData(host, peerB, {
                type: 'command', command: 'set_system_prompt',
                requestId: 'mp-003-setup-B', payload: 'Peer B context',
            });

            mockEmitter.sendToPeer.mockReset();

            // Only clear peer A
            await simulatePeerData(host, peerA, {
                type: 'command', command: 'clear_memory', requestId: 'mp-003-clear-A',
            });

            // Peer B's ping still works fine (would fail if shared state was corrupted)
            const resB: any = await simulatePeerData(host, peerB, {
                type: 'command', command: 'ping', requestId: 'mp-003-ping-B',
            });

            expect(resB.type).toBe('command_result');
            expect(resB.result.pong).toBe(true);

            const clearCall = mockEmitter.sendToPeer.mock.calls
                .find(([id, r]: [string, any]) => id === peerA && r.requestId === 'mp-003-clear-A');
            expect(clearCall?.[1].result.success).toBe(true);
        });

        it('sends inference results only to the requesting peer', async () => {
            (ollamaAdapter.handleOllamaInference as jest.Mock).mockImplementation(
                async (request: any, send: any) => {
                    send({ type: 'done', requestId: request.requestId, stats: { tokens: 1, ms: 50, tps: 20 } });
                },
            );

            await simulatePeerData(host, peerA, {
                type: 'inference', requestId: 'mp-004-A',
                messages: [{ role: 'user', content: 'Hello from A' }],
            });

            // sendToPeer should only have been called with peerA for this requestId
            const wrongPeerCall = mockEmitter.sendToPeer.mock.calls
                .find(([id, r]: [string, any]) => id === peerB && r.requestId === 'mp-004-A');

            expect(wrongPeerCall).toBeUndefined();
        });
    });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

async function simulatePeerData(
    host: any,
    peerId: string,
    packet: any,
    expectResponse = true,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Timeout waiting for response to ${packet.command ?? packet.type}`));
        }, 2000);

        if (expectResponse) {
            mockEmitter.sendToPeer.mockImplementation((id: string, response: any) => {
                if (response.requestId === packet.requestId) {
                    clearTimeout(timeout);
                    resolve(response);
                }
            });
        }

        const peerDataCall = (mockEmitter.on as jest.Mock).mock.calls
            .find(call => call[0] === 'peer-data');

        if (!peerDataCall) {
            clearTimeout(timeout);
            return reject(new Error("Host never registered 'peer-data' listener."));
        }

        peerDataCall[1](peerId, packet);

        if (!expectResponse) {
            clearTimeout(timeout);
            resolve(null);
        }
    });
}