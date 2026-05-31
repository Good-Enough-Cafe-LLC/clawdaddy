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
    abortSignal?: AbortSignal
) {
    const { requestId, messages, options, peerId } = request;
    const startTime = Date.now();

    // ── Find user message ────────────────────────────────────────────────────
    const userMessage = messages.find(m => m.role === 'user');
    if (!userMessage) {
        send({ type: 'error', requestId, error: 'No user message found', code: 'INVALID_REQUEST' });
        return;
    }

    const userContent = typeof userMessage.content === 'string'
        ? userMessage.content
        : JSON.stringify(userMessage.content);

    // ── Detect FIM request MORE SPECIFICALLY ─────────────────────────────────
    // FIM requests have VERY specific patterns from Continue
    const isFIMRequest = 
        userContent.includes('<fim_prefix>') && 
        userContent.includes('<fim_suffix>') ||
        userContent.startsWith('<fim_prefix>') ||
        (userContent.includes('fim_prefix') && userContent.includes('fim_suffix')) ||
        // Check if this looks like code completion (starts with code pattern)
        (userContent.includes('# Path:') && userContent.includes('class ')) ||
        // Check if the message has the typical FIM structure
        (userContent.includes('prefix') && userContent.includes('suffix'));

    // ALSO check the original request format (some Continue versions)
    const hasFimFields = 'prefix' in request || 'suffix' in request || 'fim_prefix' in request;

    // FINAL: Only treat as FIM if it REALLY looks like autocomplete
    const isDefinitelyFIM = isFIMRequest || hasFimFields;

    if (isDefinitelyFIM) {
        log(`🤖 FIM/autocomplete request detected (will use fast path)`, 'debug');
        
        // Check if already aborted
        if (abortSignal?.aborted) {
            log(`🛑 Request ${requestId} aborted before start`, 'warn');
            return;
        }

        try {
            let tokenCount = 0;
            let fullResponse = '';

            // Use raw messages directly - NO context building
            const fimMessages = messages.map(m => ({ 
                role: m.role as any, 
                content: m.content 
            }));

            log(`📡 Starting Ollama stream (FIM mode)...`, 'debug');

            const stream = await ollama.chat({
                model: modelName,
                messages: fimMessages,
                options: {
                    temperature: 0.1,
                    num_predict: Math.min(options?.max_tokens ?? 50, 100), // Max 100 tokens for autocomplete
                },
                stream: true,
            });

            for await (const part of stream) {
                if (abortSignal?.aborted) {
                    log(`🛑 FIM stream cancelled`, 'warn');
                    break;
                }

                const token = part.message.content;
                tokenCount++;
                fullResponse += token;
                send({ type: 'token', requestId, token });
            }

            if (!abortSignal?.aborted && tokenCount > 0) {
                const elapsed = Date.now() - startTime;
                const tps = tokenCount / (elapsed / 1000);
                send({ type: 'done', requestId, stats: { tokens: tokenCount, ms: elapsed, tps } });
                log(`✅ FIM done: ${tokenCount} tokens in ${elapsed}ms`, 'debug');
            } else if (!abortSignal?.aborted && tokenCount === 0) {
                // No tokens generated - send empty response so Continue doesn't hang
                send({ type: 'done', requestId, stats: { tokens: 0, ms: Date.now() - startTime, tps: 0 } });
            }

        } catch (error: any) {
            if (error.name !== 'AbortError' && !abortSignal?.aborted) {
                log(`❌ FIM error: ${error.message}`, 'error');
                send({ type: 'error', requestId, error: error.message, code: 'INFERENCE_FAILED' });
            }
        }
        return; // Early exit for FIM requests
    }

    // ── Regular chat request (non-FIM) continues below ────────────────────────
    log(`🦙 Running inference with Ollama (${modelName})`, 'info');

    // Check if already aborted
    if (abortSignal?.aborted) {
        log(`🛑 Request ${requestId} aborted before start`, 'warn');
        return;
    }

    const logContent = userContent.substring(0, 100);
    log(`💬 User: ${logContent}${userContent.length > 100 ? '...' : ''}`);

    // Extract LTM facts from user message (only for chat)
    if (sessionManager && peerId) {
        sessionManager.extractAndSaveLTM(peerId, userContent, log);
    }

    // Build context: system prompt + LTM + recent STM + user message
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

    // Set up abort handler
    let isAborted = false;
    const abortHandler = () => {
        isAborted = true;
        log(`🛑 Aborting chat inference ${requestId}`, 'warn');
    };
    
    abortSignal?.addEventListener('abort', abortHandler);

    try {
        let tokenCount = 0;
        let fullResponse = '';

        if (isAborted || abortSignal?.aborted) {
            log(`🛑 Request ${requestId} cancelled before stream start`, 'warn');
            return;
        }

        log(`📡 Starting Ollama stream...`, 'debug');

        const stream = await ollama.chat({
            model: modelName,
            messages: contextMessages.map(m => ({ role: m.role as any, content: m.content })),
            options: {
                temperature: options?.temperature ?? 0.7,
                num_predict: options?.max_tokens ?? 1024,
            },
            stream: true,
        });

        for await (const part of stream) {
            if (isAborted || abortSignal?.aborted) {
                log(`🛑 Chat stream cancelled at ${tokenCount} tokens`, 'warn');
                break;
            }

            const token = part.message.content;
            tokenCount++;
            fullResponse += token;

            if (tokenCount === 1) {
                const firstToken = token.substring(0, 50);
                log(`📦 First token: "${firstToken}${token.length > 50 ? '...' : ''}"`, 'debug');
            }

            send({ type: 'token', requestId, token });
        }

        abortSignal?.removeEventListener('abort', abortHandler);

        if (isAborted || abortSignal?.aborted) {
            log(`🛑 Chat inference ${requestId} was cancelled`, 'warn');
            return;
        }

        const elapsed = Date.now() - startTime;
        const tps = tokenCount / (elapsed / 1000);

        if (tokenCount > 0) {
            send({ type: 'done', requestId, stats: { tokens: tokenCount, ms: elapsed, tps } });
            log(`✅ Done: ${tokenCount} tokens, ${tps.toFixed(1)} t/s`, 'success');
        } else {
            log(`⚠️ No tokens generated`, 'warn');
            send({ type: 'error', requestId, error: 'No response generated', code: 'NO_OUTPUT' });
        }

        // Save exchange to STM
        if (sessionManager && peerId && tokenCount > 0 && !isAborted) {
            sessionManager.addToHistory(peerId, 'user', userContent);
            sessionManager.addToHistory(peerId, 'assistant', fullResponse);

            const session = sessionManager.getSession(peerId);
            if (session) {
                log(`💾 STM: ${session.conversationHistory.length} messages`, 'debug');
            }
        }

    } catch (error: any) {
        abortSignal?.removeEventListener('abort', abortHandler);
        
        if (error.name === 'AbortError' || isAborted || abortSignal?.aborted) {
            log(`🛑 Chat inference cancelled: ${error.message}`, 'warn');
            return;
        }
        
        log(`❌ Ollama error: ${error.message}`, 'error');
        if (error.message?.includes('not found')) {
            log(`💡 Model "${modelName}" not found. Run: ollama pull ${modelName}`, 'error');
        }
        
        if (!isAborted && !abortSignal?.aborted) {
            send({ type: 'error', requestId, error: error.message, code: 'INFERENCE_FAILED' });
        }
    }
}