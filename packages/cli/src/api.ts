// ─── API Server ──────────────────────────────────────────────────────────────
//
// Starts the local HTTP server that exposes Anthropic- and OpenAI-compatible
// inference endpoints, plus pairing management routes.
import http from 'http';
import { URL } from 'url';
import { generateUUID } from '@clawdaddy/core';

import {
    isConnected,
    getActiveHostId,
    pendingRequests,
    sendSecure,
    sendCommand,
} from './transport.js';
import { startClient, stopClient, connectionState } from './connection.js';
import { normalizeTarget, normalizeCode, isValidTarget, isValidCode } from './validation.js';
import type { PairedHost } from './types.js';

// ─── CORS ─────────────────────────────────────────────────────────────────────

function setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key, anthropic-version, Accept, *, ' +
        'anthropic-beta, anthropic-dangerous-direct-browser-access, ' +
        'x-claude-code-session-id, x-stainless-*',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── Body helper ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => resolve(body));
    });
}

function parseBody(body: string, res: http.ServerResponse): any | null {
    try {
        return JSON.parse(body);
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return null;
    }
}

// ─── Guard helper ─────────────────────────────────────────────────────────────

function requirePeer(res: http.ServerResponse): boolean {
    if (!isConnected()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error:  'No active transport',
            status: connectionState.status,
        }));
        return false;
    }
    return true;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

function handleStatus(
    res: http.ServerResponse,
    pairedHosts: Map<string, PairedHost>,
    INITIATOR_ID: string,
    SIGNAL_SERVER: string,
): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        connection:  connectionState,
        pairedHosts: Array.from(pairedHosts.values()),
        initiatorId: INITIATOR_ID,
        signalServer: SIGNAL_SERVER,
    }));
}

function handleListHosts(res: http.ServerResponse, pairedHosts: Map<string, PairedHost>): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ hosts: Array.from(pairedHosts.values()), count: pairedHosts.size }));
}

async function handleCommand(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body   = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const { command, payload } = parsed;
    if (!command) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'command is required' }));
        return;
    }

    if (!requirePeer(res)) return;

    try {
        const result = await sendCommand(command, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
    } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
}

// Track active requests by content hash to deduplicate
const activeRequests = new Map<string, { requestId: string; subscribers: Set<http.ServerResponse> }>();

async function handleAnthropicMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body   = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const stream = parsed.stream !== false;

    if (!stream) {
        return;
    }

    if (!requirePeer(res)) return;

    const contentHash = JSON.stringify({
        messages:    parsed.messages,
        model:       parsed.model,
        max_tokens:  parsed.max_tokens,
        temperature: parsed.temperature,
    });

    const existing = activeRequests.get(contentHash);
    if (existing) {
        console.log(`🔄 Reusing existing stream for duplicate request`);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        existing.subscribers.add(res);
        req.on('close', () => {
            existing.subscribers.delete(res);
            if (existing.subscribers.size === 0) {
                pendingRequests.delete(existing.requestId);
                activeRequests.delete(contentHash);
            }
        });
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const requestId   = generateUUID();
    const inputTokens = 0;
    const subscribers = new Set<http.ServerResponse>();
    subscribers.add(res);
    activeRequests.set(contentHash, { requestId, subscribers });

    // message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
            id: requestId, type: 'message', role: 'assistant',
            content: [], model: parsed.model || 'clawdaddy',
            stop_reason: null, stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    })}\n\n`);

    // content_block_start
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: 0,
        content_block: { type: 'text', text: '' },
    })}\n\n`);

    if ((res as any).flush) (res as any).flush();

    let timeoutId: NodeJS.Timeout;

    pendingRequests.set(requestId, {
        inputTokens,
        onToken: (token) => {
            for (const sub of subscribers) {
                try {
                    sub.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta', index: 0,
                        delta: { type: 'text_delta', text: token },
                    })}\n\n`);
                } catch (err) {
                    console.error(`❌ Failed to write to subscriber: ${err}`);
                }
            }
        },
        onDone: (stats) => {
            for (const sub of subscribers) {
                sub.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
                sub.write(`event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: { stop_reason: 'end_turn', stop_sequence: null },
                    usage: { input_tokens: inputTokens, output_tokens: stats?.tokens || 0 },
                })}\n\n`);
                sub.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
                sub.end();
            }
            pendingRequests.delete(requestId);
            activeRequests.delete(contentHash);
            clearTimeout(timeoutId);
        },
        onError: (err) => {
            for (const sub of subscribers) {
                sub.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err } })}\n\n`);
                sub.end();
            }
            pendingRequests.delete(requestId);
            activeRequests.delete(contentHash);
            clearTimeout(timeoutId);
        },
    });

    timeoutId = setTimeout(() => {
        pendingRequests.get(requestId)?.onError?.('Request timeout — node may be busy or offline');
    }, 120_000);

    const messages = (parsed.messages ?? []).map((m: any) => ({
        role:    m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    sendSecure({
        type: 'inference', requestId, messages,
        options: { max_tokens: parsed.max_tokens ?? 1024, temperature: parsed.temperature ?? 0.7 },
    });
}

async function handleOpenAICompletions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body   = await readBody(req);
    const parsed = parseBody(body, res);
    if (!parsed) return;

    const stream = parsed.stream !== false;

    if (!stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: generateUUID(), object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed.model || 'clawdaddy',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Model is ready.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        return;
    }

    if (!requirePeer(res)) return;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

    const requestId  = generateUUID();
    let firstToken   = true;

    pendingRequests.set(requestId, {
        inputTokens: 0,
        onToken: (token) => {
            const delta: any = { content: token };
            if (firstToken) { delta.role = 'assistant'; firstToken = false; }
            res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: parsed.model || 'clawdaddy',
                choices: [{ delta, index: 0, finish_reason: null }],
            })}\n\n`);
            if ((res as any).flush) (res as any).flush();
        },
        onDone: () => {
            res.write(`data: ${JSON.stringify({
                id: requestId, object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: parsed.model || 'clawdaddy',
                choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
            })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
            pendingRequests.delete(requestId);
        },
        onError: (err) => {
            res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
            res.end();
            pendingRequests.delete(requestId);
        },
    });

    sendSecure({
        type: 'inference', requestId,
        messages: parsed.messages,
        options: { max_tokens: parsed.max_tokens ?? 256, temperature: parsed.temperature ?? 0.7 },
    });
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function startApiMode(
    pairedHosts:  Map<string, PairedHost>,
    mode:         string,
    onConnected:  () => void,
    INITIATOR_ID: string,
    SIGNAL_SERVER: string,
    port:         number = 3001,
): void {
    const server = http.createServer(async (req, res) => {
        setCorsHeaders(res);
        console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);

        const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
        const pathname  = parsedUrl.pathname;

        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'HEAD' && pathname === '/') { res.writeHead(200); res.end(); return; }

        if (req.method === 'GET'  && pathname === '/v1/status')           return handleStatus(res, pairedHosts, INITIATOR_ID, SIGNAL_SERVER);
        if (req.method === 'GET'  && pathname === '/v1/hosts')            return handleListHosts(res, pairedHosts);
        if (req.method === 'POST' && pathname === '/v1/command')          return handleCommand(req, res);
        if (req.method === 'POST' && pathname === '/v1/messages')         return handleAnthropicMessages(req, res);
        if (req.method === 'POST' && pathname === '/v1/chat/completions') return handleOpenAICompletions(req, res);

        if (req.method === 'GET' && pathname === '/v1/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'clawdaddy', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'clawdaddy' }] }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found', path: req.url }));
    });

    server.listen(port, '127.0.0.1', () => {
        console.log(`🌐 Clawdaddy API server ready at http://localhost:${port}`);
        console.log('');
        console.log('🔐 Security enabled: PBKDF2 + HMAC-SHA256');
        console.log('');
        console.log('📡 Endpoints:');
        console.log('   GET  /v1/status              Connection status');
        console.log('   POST /v1/messages            Anthropic-style streaming');
        console.log('   POST /v1/chat/completions    OpenAI-style streaming');
        console.log('   POST /v1/command             Send commands to paired host');
        console.log('   GET  /v1/models              List available models');
        console.log('');
    });
}