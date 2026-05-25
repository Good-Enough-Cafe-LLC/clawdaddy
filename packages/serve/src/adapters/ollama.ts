import ollama from 'ollama';
import { InferenceRequest, OutgoingPacket } from '../types';
import { buildContextMessages, ClientSession } from '../host';

// Session manager interface — registered from host.ts
let sessionManager: any = null;

export function registerSessionManager(manager: any) {
    sessionManager = manager;
}

export async function handleOllamaInference(
    request:   InferenceRequest,
    send:      (packet: OutgoingPacket) => void,
    log:       (msg: string, type?: string) => void,
    modelName: string,
) {
    const { requestId, messages, options, peerId } = request;
    const startTime = Date.now();

    log(`🦙 Running inference with Ollama (${modelName})`, 'info');

    // Pull the raw user message out of the request
    const userMessage = messages.find(m => m.role === 'user');
    if (!userMessage) {
        send({ type: 'error', requestId, error: 'No user message found', code: 'INVALID_REQUEST' });
        return;
    }

    const userContent = typeof userMessage.content === 'string'
        ? userMessage.content
        : JSON.stringify(userMessage.content);

    log(`💬 User: ${userContent.substring(0, 100)}${userContent.length > 100 ? '...' : ''}`);

    // ── Extract LTM facts from user message ───────────────────────────────────
    // Done before building context so any new fact is immediately available
    // in future turns (not this one, since context is already being built).
    if (sessionManager && peerId) {
        sessionManager.extractAndSaveLTM(peerId, userContent, log);
    }

    // ── Build context: system prompt + LTM + recent STM + user message ────────
    let contextMessages: Array<{ role: string; content: string }>;

    if (sessionManager && peerId) {
        const session: ClientSession | undefined = sessionManager.getSession(peerId);

        if (session) {
            const base = buildContextMessages(session);  // [system+LTM, ...recent STM]
            contextMessages = [...base, { role: 'user', content: userContent }];

            const ltmCount = Object.keys(session.ltm).length;
            const stmCount = session.conversationHistory.length;
            log(`📚 Context: ${ltmCount} LTM facts, ${stmCount} STM messages`, 'info');
        } else {
            contextMessages = [{ role: 'user', content: userContent }];
        }
    } else {
        contextMessages = messages.map(m => ({ role: m.role, content: m.content }));
    }

    try {
        let tokenCount   = 0;
        let fullResponse = '';

        const stream = await ollama.chat({
            model:    modelName,
            messages: contextMessages.map(m => ({ role: m.role as any, content: m.content })),
            options: {
                temperature: options?.temperature ?? 0.7,
                num_predict: options?.max_tokens  ?? 1024,
            },
            stream: true,
        });

        log(`📡 Ollama stream established...`);

        for await (const part of stream) {
            const token = part.message.content;
            tokenCount++;
            fullResponse += token;

            if (tokenCount === 1) {
                log(`📦 First token: "${token.substring(0, 50)}${token.length > 50 ? '...' : ''}"`);
            }

            send({ type: 'token', requestId, token });
        }

        const elapsed = Date.now() - startTime;
        const tps     = tokenCount / (elapsed / 1000);

        send({ type: 'done', requestId, stats: { tokens: tokenCount, ms: elapsed, tps } });

        // ── Save exchange to STM ──────────────────────────────────────────────
        if (sessionManager && peerId) {
            sessionManager.addToHistory(peerId, 'user',      userContent);
            sessionManager.addToHistory(peerId, 'assistant', fullResponse);

            const session = sessionManager.getSession(peerId);
            if (session) {
                log(`💾 STM: ${session.conversationHistory.length} messages`, 'success');
            }
        }

        log(`✅ Done: ${tokenCount} tokens, ${tps.toFixed(1)} t/s`, 'success');

    } catch (error: any) {
        log(`❌ Ollama error: ${error.message}`, 'error');
        if (error.message?.includes('not found')) {
            log(`💡 Model "${modelName}" not found. Run: ollama pull ${modelName}`, 'error');
        }
        send({ type: 'error', requestId, error: error.message, code: 'INFERENCE_FAILED' });
    }
}