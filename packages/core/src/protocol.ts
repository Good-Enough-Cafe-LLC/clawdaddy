// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface ClawdaddyMessage {
  role: MessageRole;
  content: string;
}

// ─── Secure Transport ────────────────────────────────────────────

export interface SecurePacket<T = any> {
  payload: T;
  signature: string;
}

// ─── Inference Request ───────────────────────────────────────────

export interface InferenceRequest {
  type: 'inference';
  requestId: string;
  messages: ClawdaddyMessage[];
  options?: {
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
}

// ─── Streaming Response Packets ──────────────────────────────────

export interface TokenPacket {
  type: 'token';
  requestId: string;
  token: string;
}

export interface DonePacket {
  type: 'done';
  requestId: string;
  stats: {
    tokens: number;
    ms: number;
    tps: number;
    inputTokens?: number;
  };
}

export interface ErrorPacket {
  type: 'error';
  requestId: string;
  error: string;
  code: string;
}

export type OutgoingPacket =
  | TokenPacket
  | DonePacket
  | ErrorPacket;