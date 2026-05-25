import { createSocketClient } from './socketClient';
import { handleOllamaInference, registerSessionManager } from './adapters/ollama';
import { MultiPeerManager } from './multiPeerManager';
import { InferenceRequest } from './types';
import { getSocketPath } from '@clawdaddy/core';
import fs from 'fs';
import path from 'path';
import net from 'net';
import os from 'os';

export interface HostOptions {
    switchboardUrl:   string;
    hostId:           string;
    pairingCode:      string;
    ollamaModel:      string;
    maxConnections?:  number;
    allowMultiple?:   boolean;
    contextWindow?:   number;
    localOnly?:       boolean;
    log:              (msg: string, type?: string) => void;
    onReady?:         (info: { hostId: string; pairingCode: string; socketPath: string }) => void;
    onConnection?:    (peerId: string, total: number) => void;
    onDisconnection?: (peerId: string, total: number) => void;
}

// ─── Persistence ──────────────────────────────────────────────────────────────
// Per-client data lives at ~/.clawdaddy/clients/<clientId>/
// Only system_prompt.txt and ltm.json are persisted.
// STM (conversation history) is intentionally ephemeral — resets on reconnect.

const CLIENTS_DIR = path.join(os.homedir(), '.clawdaddy', 'clients');

function clientDir(clientId: string): string {
    const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    return path.join(CLIENTS_DIR, safe);
}

function ensureClientDir(clientId: string): string {
    const dir = clientDir(clientId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function loadClientData(clientId: string): { systemPrompt: string; ltm: LTMStore; stm: ConversationEntry[] } | null {
    const dir = clientDir(clientId);
    if (!fs.existsSync(dir)) return null;

    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    let ltm: LTMStore = {};
    let stm: ConversationEntry[] = [];

    const promptFile = path.join(dir, 'system_prompt.txt');
    if (fs.existsSync(promptFile)) systemPrompt = fs.readFileSync(promptFile, 'utf-8');

    const ltmFile = path.join(dir, 'ltm.json');
    if (fs.existsSync(ltmFile)) {
        try { ltm = JSON.parse(fs.readFileSync(ltmFile, 'utf-8')); } catch (_) {}
    }

    const stmFile = path.join(dir, 'stm.json');
    if (fs.existsSync(stmFile)) {
        try { stm = JSON.parse(fs.readFileSync(stmFile, 'utf-8')); } catch (_) {}
    }

    return { systemPrompt, ltm, stm };
}

function saveSystemPrompt(clientId: string, prompt: string): void {
    const dir = ensureClientDir(clientId);
    fs.writeFileSync(path.join(dir, 'system_prompt.txt'), prompt, 'utf-8');
}

function saveLTM(clientId: string, ltm: LTMStore): void {
    const dir = ensureClientDir(clientId);
    fs.writeFileSync(path.join(dir, 'ltm.json'), JSON.stringify(ltm, null, 2), 'utf-8');
}

function saveSTM(clientId: string, history: ConversationEntry[]): void {
             
    const dir = ensureClientDir(clientId);
    // Strip the Date objects for JSON — reload as strings, convert back on load
    fs.writeFileSync(path.join(dir, 'stm.json'), JSON.stringify(history, null, 2), 'utf-8');
}

function loadSTM(clientId: string): ConversationEntry[] {
    const file = path.join(clientDir(clientId), 'stm.json');
    if (!fs.existsSync(file)) return [];
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return raw.map((e: any) => ({ ...e, timestamp: new Date(e.timestamp) }));
    } catch (_) { return []; }
}

// ─── Long-term memory ─────────────────────────────────────────────────────────
// Key-value store of facts extracted from conversation via pattern matching.
// Keys are unique so facts overwrite rather than accumulate.

type LTMStore = Record<string, string>;

interface LTMPattern {
    pattern:  RegExp;
    key:      string;
    template: string;  // $1, $2 replaced with regex capture groups
}

const LTM_PATTERNS: LTMPattern[] = [
    { pattern: /my name is (\w+)/i,                                   key: 'name',       template: "User's name is $1" },
    { pattern: /(?:i'?m|i am) (\d+) years? old/i,                    key: 'age',        template: 'User is $1 years old' },
    { pattern: /i live in ([^,.]+)/i,                                 key: 'location',   template: 'User lives in $1' },
    { pattern: /i(?:'?m| am) from ([^,.]+)/i,                         key: 'origin',     template: 'User is from $1' },
    { pattern: /i work (?:at|for) ([^,.]+)/i,                         key: 'work',       template: 'User works at $1' },
    { pattern: /i(?:'?m| am) a(?:n)? ([^,.]+)/i,                      key: 'identity',   template: 'User is a $1' },
    { pattern: /(?:i'?m|i am) (?:allergic|sensitive) to ([^,.]+)/i,   key: 'allergy',    template: 'User is allergic to $1' },
    { pattern: /(?:i prefer|i like|i love) ([^,.]+)/i,                key: 'preference', template: 'User prefers $1' },
    { pattern: /(?:i don'?t like|i hate|i dislike) ([^,.]+)/i,        key: 'dislike',    template: 'User dislikes $1' },
    { pattern: /call me (\w+)/i,                                       key: 'name',       template: 'User prefers to be called $1' },
];

function extractLTMFacts(text: string, existing: LTMStore): { updated: LTMStore; newKeys: string[] } {
    const updated = { ...existing };
    const newKeys: string[] = [];

    for (const { pattern, key, template } of LTM_PATTERNS) {
        const match = text.match(pattern);
        if (!match) continue;
        const fact = template.replace(/\$(\d+)/g, (_, n) => (match[parseInt(n)] ?? '').trim()).trim();
        if (fact && updated[key] !== fact) {
            updated[key] = fact;
            newKeys.push(key);
        }
    }

    return { updated, newKeys };
}

function formatLTM(ltm: LTMStore): string {
    const facts = Object.values(ltm);
    return facts.length === 0 ? '' : facts.join('\n');
}

// ─── Context building ─────────────────────────────────────────────────────────
// Layout: [system prompt + LTM] + [recent STM filling remaining budget]
// The current user message is always added by ollama.ts on top of this.

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Be conversational and remember context from our conversation. 
If you need to reference previous information, do so naturally.`;

const CURRENT_MSG_RESERVE = 500; // tokens reserved for the user's next message

export function buildContextMessages(session: ClientSession): Array<{ role: string; content: string }> {
    const ltmText       = formatLTM(session.ltm);
    const systemContent = ltmText
        ? `${session.systemPrompt}\n\n## What I know about you:\n${ltmText}`
        : session.systemPrompt;

    const systemTokens = estimateTokens(systemContent);
    const available    = session.contextWindow - systemTokens - CURRENT_MSG_RESERVE;

    // Fill from newest → oldest so the most recent context always fits
    const history: ConversationEntry[] = [];
    let used = 0;
    for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
        const entry = session.conversationHistory[i];
        if (used + entry.tokenCount > available) break;
        history.unshift(entry);
        used += entry.tokenCount;
    }

    return [
        { role: 'system', content: systemContent },
        ...history.map(e => ({ role: e.role, content: e.content })),
    ];
}

// ─── Session types ────────────────────────────────────────────────────────────

interface ConversationEntry {
    role:       'user' | 'assistant' | 'system';
    content:    string;
    timestamp:  Date;
    tokenCount: number;
}

export interface ClientSession {
    peerId:              string;        // ephemeral — changes each reconnect
    clientId:            string | null; // stable — set via 'identify' command
    conversationHistory: ConversationEntry[];
    systemPrompt:        string;
    ltm:                 LTMStore;
    totalTokens:         number;
    lastActivity:        Date;
    contextWindow:       number;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function createClientSession(peerId: string, contextWindow: number): ClientSession {
    return {
        peerId,
        clientId:            null,
        conversationHistory: [],
        systemPrompt:        DEFAULT_SYSTEM_PROMPT,
        ltm:                 {},
        totalTokens:         0,
        lastActivity:        new Date(),
        contextWindow,
    };
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

interface RateLimitEntry {
    count:           number;
    resetTime:       number;
    tokens:          number;
    lastRequestId:   string | null;
    lastRequestTime: number;
}

class RateLimiter {
    private limits: Map<string, RateLimitEntry> = new Map();

    constructor(
        private windowMs:                number = 60000,
        private maxRequests:             number = 15,
        private maxTokensPerMinute:      number = 10000,
        private maxConcurrentInferences: number = 3,
    ) { }

    private getCurrentConcurrent(): number { return activeInferenceRequests.size; }

    checkLimit(peerId: string, requestId?: string): { allowed: boolean; reason?: string; retryAfter?: number } {
        const now = Date.now();
        let entry = this.limits.get(peerId);

        if (!entry || now > entry.resetTime) {
            entry = { count: 0, resetTime: now + this.windowMs, tokens: 0, lastRequestId: null, lastRequestTime: 0 };
            this.limits.set(peerId, entry);
        }

        if (entry.count >= this.maxRequests)                          return { allowed: false, reason: `Rate limit exceeded: ${this.maxRequests} req/${this.windowMs / 1000}s`, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
        if (entry.tokens >= this.maxTokensPerMinute)                  return { allowed: false, reason: `Token rate limit exceeded`, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
        if (this.getCurrentConcurrent() >= this.maxConcurrentInferences) return { allowed: false, reason: `Max concurrent inferences reached`, retryAfter: 5 };
        if (entry.lastRequestId === requestId && requestId) {
            const timeSinceLast = now - entry.lastRequestTime;
            if (timeSinceLast < 5000) return { allowed: false, reason: 'Duplicate request', retryAfter: Math.ceil((5000 - timeSinceLast) / 1000) };
        }

        entry.count++;
        if (requestId) { entry.lastRequestId = requestId; entry.lastRequestTime = now; }
        return { allowed: true };
    }

    addTokens(peerId: string, tokenCount: number) {
        const entry = this.limits.get(peerId);
        if (entry) entry.tokens += tokenCount;
    }

    cleanup() {
        const now = Date.now();
        for (const [peerId, entry] of this.limits.entries()) {
            if (now > entry.resetTime + this.windowMs) this.limits.delete(peerId);
        }
    }
}

// ─── Module-level state ───────────────────────────────────────────────────────

const activeInferenceRequests = new Set<string>();
let bytesSentThisMinute     = 0;
let bytesReceivedThisMinute = 0;
const clientSessions        = new Map<string, ClientSession>();

// ─── Session manager ──────────────────────────────────────────────────────────

const sessionManager = {
    getSession: (peerId: string): ClientSession | undefined => clientSessions.get(peerId),

    identify: (peerId: string, clientId: string, log: (m: string, t?: string) => void): void => {
        const session = clientSessions.get(peerId);
        if (!session) return;
        session.clientId = clientId;
        const saved = loadClientData(clientId);
        if (saved) {
            session.systemPrompt = saved.systemPrompt;
            session.ltm          = saved.ltm;
            session.conversationHistory           = saved.stm;
            session.totalTokens         = saved.stm.reduce((sum, e) => sum + e.tokenCount, 0);
            log(`🪪 Identified ${clientId.slice(0, 12)}... — loaded ${Object.keys(saved.ltm).length} LTM facts`, 'info');
        } else {
            log(`🪪 Identified ${clientId.slice(0, 12)}... — no prior data`, 'info');
        }
    },

    addToHistory: (peerId: string, role: 'user' | 'assistant' | 'system', content: string): void => {
        const session = clientSessions.get(peerId);
        if (!session) return;
        const tokenCount = estimateTokens(content);
        session.conversationHistory.push({ role, content, timestamp: new Date(), tokenCount });
        session.totalTokens  += tokenCount;
        session.lastActivity  = new Date();
        const MAX_SAVED_STM = 200;
        if (session.clientId) saveSTM(session.clientId, session.conversationHistory.slice(-MAX_SAVED_STM));
        
    },

    extractAndSaveLTM: (peerId: string, userText: string, log: (m: string, t?: string) => void): void => {
        const session = clientSessions.get(peerId);
        if (!session?.clientId) return;
        const { updated, newKeys } = extractLTMFacts(userText, session.ltm);
        if (newKeys.length === 0) return;
        session.ltm = updated;
        saveLTM(session.clientId, updated);
        log(`💡 LTM updated: ${newKeys.map(k => `${k}="${updated[k]}"`).join(', ')}`, 'info');
    },

    clearHistory: (peerId: string): number => {
        const session = clientSessions.get(peerId);
        if (!session) return 0;
        const cleared               = session.conversationHistory.length;
        session.conversationHistory = [];
        session.totalTokens         = 0;
        session.lastActivity        = new Date();
        if (session.clientId) saveSTM(session.clientId, []);
        return cleared;
    },

    setSystemPrompt: (peerId: string, newPrompt: string): string | null => {
        const session = clientSessions.get(peerId);
        if (!session) return null;
        const old            = session.systemPrompt;
        session.systemPrompt = newPrompt;
        session.lastActivity = new Date();
        if (session.clientId) saveSystemPrompt(session.clientId, newPrompt);
        return old;
    },

    getLTM: (peerId: string): LTMStore => clientSessions.get(peerId)?.ltm ?? {},

    setLTMFact: (peerId: string, key: string, value: string): void => {
        const session = clientSessions.get(peerId);
        if (!session) return;
        session.ltm[key] = value;
        if (session.clientId) saveLTM(session.clientId, session.ltm);
    },

    clearLTM: (peerId: string): number => {
        const session = clientSessions.get(peerId);
        if (!session) return 0;
        const count = Object.keys(session.ltm).length;
        session.ltm = {};
        if (session.clientId) saveLTM(session.clientId, {});
        return count;
    },

    // Returns the full memory picture — used by get_memory command and /v1/memory
    getMemory: (peerId: string): any => {
        const session = clientSessions.get(peerId);
        if (!session) return { hasSession: false };

        const ltmText      = formatLTM(session.ltm);
        const systemTokens = estimateTokens(session.systemPrompt);
        const ltmTokens    = estimateTokens(ltmText);
        const stmTokens    = session.totalTokens;
        const totalUsed    = systemTokens + ltmTokens + stmTokens;

        return {
            hasSession:    true,
            clientId:      session.clientId ? session.clientId.slice(0, 12) + '...' : null,
            contextWindow: session.contextWindow,
            usage: {
                systemPrompt: systemTokens,
                ltm:          ltmTokens,
                stm:          stmTokens,
                total:        totalUsed,
                available:    session.contextWindow - totalUsed - CURRENT_MSG_RESERVE,
                utilization:  `${Math.round((totalUsed / session.contextWindow) * 100)}%`,
            },
            systemPrompt: session.systemPrompt,
            ltm:          session.ltm,
            stm: {
                messageCount:  session.conversationHistory.length,
                oldestMessage: session.conversationHistory[0]?.timestamp ?? null,
                newestMessage: session.conversationHistory[session.conversationHistory.length - 1]?.timestamp ?? null,
                messages:      session.conversationHistory.map(e => ({
                    role:      e.role,
                    content:   e.content,
                    timestamp: e.timestamp,
                    tokens:    e.tokenCount,
                })),
            },
        };
    },
};

registerSessionManager(sessionManager);

// Stale session cleanup
setInterval(() => {
    const now = Date.now();
    const SESSION_TIMEOUT = 30 * 60 * 1000;
    let cleaned = 0;
    for (const [peerId, session] of clientSessions.entries()) {
        if (now - session.lastActivity.getTime() > SESSION_TIMEOUT) { clientSessions.delete(peerId); cleaned++; }
    }
    if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale sessions (${clientSessions.size} remaining)`);
}, 5 * 60 * 1000);

// Bandwidth tracking
setInterval(() => {
    if (bytesSentThisMinute     > 100 * 1024 * 1024) console.log(`⚠️ High outbound: ${(bytesSentThisMinute     / 1024 / 1024).toFixed(2)}MB/min`);
    if (bytesReceivedThisMinute > 100 * 1024 * 1024) console.log(`⚠️ High inbound:  ${(bytesReceivedThisMinute / 1024 / 1024).toFixed(2)}MB/min`);
    bytesSentThisMinute = bytesReceivedThisMinute = 0;
}, 60000);

const rateLimiter = new RateLimiter(60000, 15, 10000, 3);
setInterval(() => rateLimiter.cleanup(), 60000);

// ─── Core packet dispatcher ───────────────────────────────────────────────────

async function dispatchPacket(
    peerId:           string,
    packet:           any,
    send:             (response: any) => void,
    log:              (msg: string, type?: string) => void,
    ollamaModel:      string,
    contextWindow:    number,
    executeCommand:   (ctx: any, send: (r: any) => void) => Promise<void>,
    COMMAND_LOG_FILE: string,
): Promise<void> {
    bytesReceivedThisMinute += JSON.stringify(packet).length;
    log(`📨 [${peerId}] type=${packet.type}, requestId=${packet.requestId?.slice(0, 8)}`);

    const limit = rateLimiter.checkLimit(peerId, packet.requestId);
    if (!limit.allowed) {
        log(`🚫 Rate limit for ${peerId}: ${limit.reason}`, 'error');
        send({ type: 'error', requestId: packet.requestId, error: limit.reason, code: 'RATE_LIMITED', retryAfter: limit.retryAfter });
        return;
    }

    if (packet.type === 'inference') {
        const request = packet as InferenceRequest;
        request.peerId = peerId;

        if (activeInferenceRequests.has(request.requestId)) {
            log(`⚠️ Duplicate inference from ${peerId} — ignoring`, 'warn');
            send({ type: 'error', requestId: request.requestId, error: 'Duplicate request already processing', code: 'DUPLICATE_REQUEST' });
            return;
        }

        if (!clientSessions.has(peerId)) clientSessions.set(peerId, createClientSession(peerId, contextWindow));

        activeInferenceRequests.add(request.requestId);

        const sendTracked = (response: any) => {
            bytesSentThisMinute += JSON.stringify(response).length;
            if (response.type === 'token') rateLimiter.addTokens(peerId, Math.ceil(response.token.length / 4));
            send(response);
        };

        try {
            await handleOllamaInference(request, sendTracked, log, ollamaModel);
        } catch (error: any) {
            log(`❌ Inference error for ${peerId}: ${error.message}`, 'error');
            send({ type: 'error', requestId: request.requestId, error: error.message, code: 'INFERENCE_FAILED' });
        } finally {
            activeInferenceRequests.delete(request.requestId);
        }

    } else if (packet.type === 'command') {
        log(`📟 Command from ${peerId}: ${packet.command}`, 'info');
        const commandCtx = { peerId, command: packet.command, payload: packet.payload, requestId: packet.requestId, timestamp: new Date() };

        try {
            fs.appendFileSync(COMMAND_LOG_FILE, JSON.stringify({ type: 'command_received', timestamp: commandCtx.timestamp.toISOString(), peerId, command: packet.command, payload: packet.payload, requestId: packet.requestId }) + '\n');
        } catch (err) {
            log(`⚠️ Failed to log command: ${err}`, 'warn');
        }

        const sendCommandResponse = (response: any) => {
            send(response);
            try { fs.appendFileSync(COMMAND_LOG_FILE, JSON.stringify({ type: 'command_response', timestamp: new Date().toISOString(), peerId, requestId: packet.requestId, command: packet.command, response }) + '\n'); } catch (_) {}
        };

        await executeCommand(commandCtx, sendCommandResponse);
    } else {
        log(`⚠️ Unknown packet type from ${peerId}: ${packet.type}`, 'warn');
    }
}

// ─── Host Implementation ──────────────────────────────────────────────────────

export async function startHost(options: HostOptions) {
    const {
        switchboardUrl,
        hostId,
        pairingCode,
        ollamaModel,
        maxConnections  = 3,
        allowMultiple   = true,
        contextWindow   = 8192,
        localOnly       = false,
        log,
        onReady,
        onConnection,
        onDisconnection,
    } = options;

    log(`🦞 Starting Clawdaddy host...`, 'info');
    log(`   Max Connections: ${maxConnections}`, 'info');
    log(`   Allow Multiple:  ${allowMultiple}`, 'info');
    log(`   Rate Limits:     15 req/min, 10k tokens/min, 3 concurrent`, 'info');
    log(`   Context Window:  ${contextWindow} tokens per client`, 'info');
    log(`   Local socket:    always enabled`, 'info');
    log(`   Switchboard:     ${localOnly ? 'disabled (local-only mode)' : 'enabled'}`, 'info');

    let peerManager:  MultiPeerManager | null = null;
    let socketClient: any                     = null;
    let localServer:  net.Server | null       = null;

    const COMMAND_LOG_FILE = path.join(process.cwd(), 'command_log.jsonl');

    // ── Command registry ──────────────────────────────────────────────────────

    interface CommandContext { peerId: string; command: string; payload: any; requestId: string; timestamp: Date; }
    const knownCommands = new Map<string, (ctx: CommandContext, send: (r: any) => void) => Promise<void>>();

    function registerCommand(name: string, handler: (ctx: CommandContext, send: (r: any) => void) => Promise<void>) {
        knownCommands.set(name, handler);
    }

    async function executeCommand(ctx: CommandContext, send: (r: any) => void): Promise<void> {
        const handler = knownCommands.get(ctx.command);
        if (handler) { log(`📟 Executing: ${ctx.command}`, 'info'); await handler(ctx, send); return; }

        const entry = { type: 'unknown_command', timestamp: ctx.timestamp.toISOString(), peerId: ctx.peerId, command: ctx.command, payload: ctx.payload, requestId: ctx.requestId, status: 'pending' };
        try {
            fs.appendFileSync(COMMAND_LOG_FILE, JSON.stringify(entry) + '\n');
            log(`📝 Unknown command logged: ${ctx.command}`, 'info');
            send({ type: 'command_result', requestId: ctx.requestId, result: { status: 'queued', message: `Command '${ctx.command}' queued for external agent.`, commandId: ctx.requestId, timestamp: ctx.timestamp.toISOString(), logged: true } });
        } catch (err) {
            send({ type: 'command_error', requestId: ctx.requestId, error: `Failed to queue command: ${err}` });
        }
    }

    // ── Built-in commands ─────────────────────────────────────────────────────

    registerCommand('ping', async (ctx, send) => {
        send({ type: 'command_result', requestId: ctx.requestId, result: { pong: true, timestamp: Date.now(), peerId: ctx.peerId, status: 'healthy', connections: peerManager?.getPeerCount() || 0 } });
    });

    // identify — client sends its stable secret ID right after tunnel opens.
    // Server loads persisted system prompt + LTM for this client from disk.
    registerCommand('identify', async (ctx, send) => {
        const { clientId } = ctx.payload ?? {};
        if (!clientId || typeof clientId !== 'string' || clientId.length < 8) {
            send({ type: 'command_error', requestId: ctx.requestId, error: 'clientId must be a string of at least 8 characters' });
            return;
        }
        sessionManager.identify(ctx.peerId, clientId, log);
        const memory = sessionManager.getMemory(ctx.peerId);
        send({ type: 'command_result', requestId: ctx.requestId, result: {
            success:   true,
            ltmFacts:  Object.keys(memory.ltm ?? {}).length,
            hasMemory: Object.keys(memory.ltm ?? {}).length > 0,
        }});
    });

    registerCommand('get_status', async (ctx, send) => {
        const limitEntry = (rateLimiter as any).limits.get(ctx.peerId);
        const memory     = sessionManager.getMemory(ctx.peerId);
        send({ type: 'command_result', requestId: ctx.requestId, result: {
            connections:      peerManager?.getPeerCount() || 0,
            maxConnections:   peerManager?.getMaxConnections() || maxConnections,
            peers:            peerManager?.getPeers() || [],
            activeInferences: activeInferenceRequests.size,
            memory:           { utilization: memory.usage?.utilization, contextWindow: memory.contextWindow },
            rateLimit: {
                requestsUsed: limitEntry?.count || 0, requestsLimit: 15,
                tokensUsed:   Math.ceil((limitEntry?.tokens || 0) / 1000), tokensLimit: 10,
                resetIn:      Math.ceil(((limitEntry?.resetTime || Date.now()) - Date.now()) / 1000),
            },
        }});
    });

    // get_memory — single endpoint for everything: system prompt, LTM, STM, usage
    registerCommand('get_memory', async (ctx, send) => {
        send({ type: 'command_result', requestId: ctx.requestId, result: sessionManager.getMemory(ctx.peerId) });
    });

    // Backwards compat alias
    registerCommand('get_memory_stats', async (ctx, send) => {
        send({ type: 'command_result', requestId: ctx.requestId, result: sessionManager.getMemory(ctx.peerId) });
    });

    registerCommand('get_system_prompt', async (ctx, send) => {
        const session = clientSessions.get(ctx.peerId);
        send({ type: 'command_result', requestId: ctx.requestId, result: { systemPrompt: session?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT } });
    });

    registerCommand('set_system_prompt', async (ctx, send) => {
        if (typeof ctx.payload !== 'string') {
            send({ type: 'command_error', requestId: ctx.requestId, error: 'payload must be a string' });
            return;
        }
        const old = sessionManager.setSystemPrompt(ctx.peerId, ctx.payload);
        send({ type: 'command_result', requestId: ctx.requestId, result: { success: true, message: 'System prompt updated', oldPrompt: old?.substring(0, 100) } });
    });

    registerCommand('get_ltm', async (ctx, send) => {
        send({ type: 'command_result', requestId: ctx.requestId, result: { ltm: sessionManager.getLTM(ctx.peerId) } });
    });

    registerCommand('set_ltm_fact', async (ctx, send) => {
        const { key, value } = ctx.payload ?? {};
        if (!key || typeof key !== 'string' || typeof value !== 'string') {
            send({ type: 'command_error', requestId: ctx.requestId, error: 'payload must be { key: string, value: string }' });
            return;
        }
        sessionManager.setLTMFact(ctx.peerId, key, value);
        send({ type: 'command_result', requestId: ctx.requestId, result: { success: true, key, value } });
    });

    registerCommand('clear_ltm', async (ctx, send) => {
        const count = sessionManager.clearLTM(ctx.peerId);
        send({ type: 'command_result', requestId: ctx.requestId, result: { success: true, factsCleared: count } });
    });

    registerCommand('clear_memory', async (ctx, send) => {
        const cleared = sessionManager.clearHistory(ctx.peerId);
        send({ type: 'command_result', requestId: ctx.requestId, result: { success: true, messagesCleared: cleared, message: cleared > 0 ? `Cleared ${cleared} messages` : 'No conversation history to clear' } });
    });

    registerCommand('echo', async (ctx, send) => {
        send({ type: 'command_result', requestId: ctx.requestId, result: { echo: ctx.payload, received: true, timestamp: Date.now() } });
    });

    registerCommand('get_command_history', async (ctx, send) => {
        try {
            const logs = fs.existsSync(COMMAND_LOG_FILE)
                ? fs.readFileSync(COMMAND_LOG_FILE, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)).slice(-50)
                : [];
            send({ type: 'command_result', requestId: ctx.requestId, result: { count: logs.length, commands: logs } });
        } catch (err) {
            send({ type: 'command_error', requestId: ctx.requestId, error: `Failed to read command history: ${err}` });
        }
    });

    // ── Local Unix socket server ──────────────────────────────────────────────

    const socketPath = getSocketPath(hostId);

    if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
        log(`🧹 Removed stale socket: ${socketPath}`, 'info');
    }

    localServer = net.createServer((conn) => {
        const localPeerId = `local-${Date.now()}`;
        let buffer = '';

        log(`🔌 Local client connected (${localPeerId})`, 'info');
        if (!clientSessions.has(localPeerId)) clientSessions.set(localPeerId, createClientSession(localPeerId, contextWindow));
        onConnection?.(localPeerId, (peerManager?.getPeerCount() ?? 0) + 1);

        const send = (response: any) => { if (!conn.destroyed) conn.write(JSON.stringify(response) + '\n'); };

        conn.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const packet = JSON.parse(line);
                    dispatchPacket(localPeerId, packet, send, log, ollamaModel, contextWindow, executeCommand, COMMAND_LOG_FILE)
                        .catch(err => log(`❌ Local dispatch error: ${err.message}`, 'error'));
                } catch (e) {
                    log(`❌ Malformed local packet: ${e}`, 'error');
                }
            }
        });

        conn.on('close', () => {
            log(`🔌 Local client disconnected (${localPeerId})`, 'info');
            onDisconnection?.(localPeerId, peerManager?.getPeerCount() ?? 0);
        });

        conn.on('error', (err) => { log(`❌ Local connection error: ${err.message}`, 'error'); });
    });

    localServer.listen(socketPath, () => { log(`🔌 Local socket listening: ${socketPath}`, 'success'); });
    localServer.on('error', (err: NodeJS.ErrnoException) => { log(`❌ Local server error: ${err.message}`, 'error'); });

    const cleanup = () => { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); };
    process.on('exit',    cleanup);
    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    // ── WebRTC / switchboard stack ────────────────────────────────────────────

    if (!localOnly) {
        const client = createSocketClient({
            url: switchboardUrl, hostId, pairingCode, createWebRTC: false,
            onConnect:    () => log(`Connected to switchboard`, 'success'),
            onDisconnect: () => log(`Disconnected from switchboard`, 'error'),

            onTunnelOpen: (socket: any, authHash: string, sharedKey: string) => {
                log(`WebRTC layer ready, initializing peer manager...`, 'info');

                if (!peerManager) {
                    peerManager = new MultiPeerManager({ socket, authHash, sharedKey, maxConnections: allowMultiple ? maxConnections : 1, log });

                    peerManager.on('peer-connected', (peerId: string) => {
                        const count = peerManager!.getPeerCount();
                        log(`🎉 Client connected: ${peerId} (${count}/${peerManager!.getMaxConnections()})`, 'success');
                        if (!clientSessions.has(peerId)) clientSessions.set(peerId, createClientSession(peerId, contextWindow));
                        onConnection?.(peerId, count);
                    });

                    peerManager.on('peer-disconnected', (peerId: string) => {
                        const count = peerManager!.getPeerCount();
                        log(`👋 Client disconnected: ${peerId} (${count}/${peerManager!.getMaxConnections()})`, 'info');
                        onDisconnection?.(peerId, count);
                    });

                    peerManager.on('peer-data', async (peerId: string, packet: any) => {
                        const send = (response: any) => peerManager?.sendToPeer(peerId, response);
                        await dispatchPacket(peerId, packet, send, log, ollamaModel, contextWindow, executeCommand, COMMAND_LOG_FILE)
                            .catch(err => log(`❌ Dispatch error: ${err.message}`, 'error'));
                    });

                    log(`✅ Peer manager initialized, ready for connections`, 'success');
                }
            },

            onTunnelClose: () => {
                if (peerManager) { peerManager.close(); peerManager = null; }
                log(`All client connections closed`, 'info');
            },

            log,
        });

        socketClient = client;
    }

    onReady?.({ hostId, pairingCode, socketPath });

    return {
        disconnect: () => {
            if (peerManager)  { peerManager.close();      peerManager  = null; }
            if (socketClient) { socketClient.disconnect(); socketClient = null; }
            if (localServer)  { localServer.close();       localServer  = null; }
            activeInferenceRequests.clear();
            clientSessions.clear();
        },
        getPeerCount:        () => peerManager?.getPeerCount() || 0,
        getPeers:            () => peerManager?.getPeers()     || [],
        getActiveInferences: () => activeInferenceRequests.size,
        getSessionStats:     (peerId?: string) => peerId ? sessionManager.getMemory(peerId) : { totalSessions: clientSessions.size, activeInferences: activeInferenceRequests.size, totalConnections: peerManager?.getPeerCount() || 0 },
        clearSession:        (peerId: string) => sessionManager.clearHistory(peerId),
        disconnectPeer:      (peerId: string) => peerManager?.disconnectPeer(peerId),
        broadcast:           (packet: any)    => peerManager?.broadcast(packet),
        sendToPeer:          (peerId: string, packet: any) => peerManager?.sendToPeer(peerId, packet),
        getRateLimitStats:   (peerId?: string) => {
            if (peerId) {
                const entry = (rateLimiter as any).limits.get(peerId);
                return entry ? { requestsUsed: entry.count, requestsLimit: 15, tokensUsed: Math.ceil(entry.tokens / 1000), tokensLimit: 10, resetIn: Math.ceil((entry.resetTime - Date.now()) / 1000) } : null;
            }
            return { totalActiveInferences: activeInferenceRequests.size, totalConnections: peerManager?.getPeerCount() || 0 };
        },
    };
}