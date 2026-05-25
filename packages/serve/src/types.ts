import { ClawdaddyMessage } from '@clawdaddy/core';

export interface InferenceRequest {
    type: 'inference';
    requestId: string;
    messages: ClawdaddyMessage[];
    options?: {
        temperature?: number;
        max_tokens?: number;
        stream?: boolean;
    };
    system?: string;
    peerId?: string;  // Add this line
}

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

export type OutgoingPacket = TokenPacket | DonePacket | ErrorPacket;