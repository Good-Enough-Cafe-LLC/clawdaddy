import { LlamaContext } from 'llama.rn';

export interface Mode {
  locked: any;
  id: string;
  name: string;
  systemPrompt: string;
  icon: string;
}

export interface InferenceRequest {
  type: 'inference';
  requestId: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  activeMode: Mode;
  options?: {
    temperature?: number;
    max_tokens?: number;
  };
}

export type OutgoingPacket =
  | { type: 'token'; requestId: string; token: string }
  | { type: 'done'; requestId: string; stats: { tokens: number; ms: number; tps: number } }
  | { type: 'error'; requestId: string; error: string; code: string };

// ── Sanitize content before passing to llama.rn ──────────────────────────────
// Null bytes, stray control characters, and very long lines can crash the
// native layer. Strip them here before building the prompt.
const sanitize = (s: string): string =>
  s
    .replace(/\0/g, '')           // null bytes → crash
    .replace(/\r\n/g, '\n')       // normalize line endings
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // other control chars
    .trim();

const buildPrompt = (messages: { role: string; content: string }[], activeMode: Mode) => {
  const MAX_CHARS = 14000; // Roughly fits 4096 tokens

  const mode = activeMode || { 
    id: 'default', 
    name: 'Clawdaddy', 
    systemPrompt: 'You are a helpful assistant, but somewhat brief' 
  };

  // 1. Create the permanent System Message
  const systemMsg = `<start_of_turn>user\n[System Instruction]: ${sanitize(mode.systemPrompt)}<end_of_turn>\n`;

  // 2. Format the history (excluding old system messages)
  const historyMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      return `<start_of_turn>${role}\n${sanitize(m.content)}<end_of_turn>\n`;
    });

  // 3. The Sliding Window Logic
  // We start with the full history and keep removing the OLDEST message 
  // (index 0 of historyMessages) until the total fits our budget.
  let currentHistory = [...historyMessages];
  const suffix = '<start_of_turn>model\n';

  while (currentHistory.length > 0) {
    const fullPrompt = systemMsg + currentHistory.join('') + suffix;

    if (fullPrompt.length <= MAX_CHARS) {
      return fullPrompt;
    }

    // Remove the oldest message to make room
    currentHistory.shift();
  }

  // Fallback: If even 1 message is too long, truncate that message itself
  return systemMsg + suffix;
};

// ── Hard cap on prompt length ─────────────────────────────────────────────────
// Even after CLI-side truncation, double-check here.
// n_ctx=4096 → max ~16000 chars of prompt (4 chars per token).
const MAX_PROMPT_CHARS = 14000;

export const runInference = async ({
  request,
  llama,
  send,
  onStart,
  onEnd,
  onLog,
  isBusy,         // external busy check so App.tsx controls the guard
}: {
  request: InferenceRequest;
  llama: LlamaContext | null;
  send: (packet: OutgoingPacket) => void;
  onStart: () => void;
  onEnd: () => void;
  onLog: (msg: string, type?: any) => void;
  isBusy: () => boolean;
}) => {
  const { requestId, messages, activeMode, options } = request;

  // ── Guard: no model ───────────────────────────────────────────────────────
  if (!llama) {
    onLog(`[${requestId.slice(0, 8)}] No model loaded`, 'error');
    send({ type: 'error', requestId, error: 'No model loaded', code: 'NO_MODEL' });
    return;
  }

  // ── Guard: already inferring ──────────────────────────────────────────────
  // llama.rn is not thread-safe — two concurrent completions will crash.
  if (isBusy()) {
    onLog(`[${requestId.slice(0, 8)}] Busy — rejecting request`, 'error');
    send({ type: 'error', requestId, error: 'Node is busy with another request', code: 'BUSY' });
    return;
  }

  onStart();

  const startMs = Date.now();
  let tokenCount = 0;

  // ── Build and sanitize prompt ─────────────────────────────────────────────
  // const rawPrompt = messages
  //   .map(m => {
  //     const content = sanitize(m.content);
  //     if (m.role === 'system')    return `<start_of_turn>user\n[System: ${content}]<end_of_turn>\n`;
  //     if (m.role === 'user')      return `<start_of_turn>user\n${content}<end_of_turn>\n`;
  //     if (m.role === 'assistant') return `<start_of_turn>model\n${content}<end_of_turn>\n`;
  //     return '';
  //   })
  //   .join('') + '<start_of_turn>model\n';

  const rawPrompt = buildPrompt(messages, activeMode);
  const prompt = rawPrompt;

  // Hard cap — truncate from the front (keep the end which has the actual question)
  // const prompt = rawPrompt.length > MAX_PROMPT_CHARS
  //   ? rawPrompt.slice(rawPrompt.length - MAX_PROMPT_CHARS)
  //   : rawPrompt;

  // if (rawPrompt.length > MAX_PROMPT_CHARS) {
  //   onLog(`Prompt truncated: ${rawPrompt.length} → ${MAX_PROMPT_CHARS} chars`, 'info');
  // }

  onLog(`[${requestId.slice(0, 8)}] Inferring · ${prompt.length} chars · max=${options?.max_tokens ?? 1024}`, 'data');

  try {
    await llama.completion(
      {
        prompt,
        n_predict: Math.min(options?.max_tokens ?? 1024, 1024), // hard cap output too
        temperature: options?.temperature ?? 0.7,
        stop: ['<end_of_turn>', '<start_of_turn>'],
      },
      ({ token }: { token: string }) => {
        tokenCount++;
        send({ type: 'token', requestId, token });
      }
    );

    const ms = Date.now() - startMs;
    const tps = tokenCount / (ms / 1000);

    onLog(`[${requestId.slice(0, 8)}] Done · ${tokenCount} tok · ${tps.toFixed(1)} tok/s`, 'success');

    send({
      type: 'done',
      requestId,
      stats: { tokens: tokenCount, ms, tps },
    });

  } catch (e: any) {
    const msg = e?.message ?? 'Unknown inference error';
    onLog(`[${requestId.slice(0, 8)}] Error: ${msg}`, 'error');
    send({ type: 'error', requestId, error: msg, code: 'INFERENCE_FAILED' });
  } finally {
    onEnd();
  }
};