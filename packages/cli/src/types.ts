// ─── Shared Types ────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface StoredNode {
  id: string;           // Node ID (xxxx-xxxx format)
  pairingCode: string;  // Pairing code (XXXX-XXXX format)
  lastConnected: string | null;  // ISO timestamp
  connectedAt: string | null;     // ISO timestamp
}

export interface PairedHost extends StoredNode {
  connected: boolean;
}

export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  activeHostId: string | null;
  switchboardConnected: boolean;
  error: string | null;
}

export interface PendingRequest {
  onToken?: (token: string) => void;
  onDone?: (stats: any) => void;
  onError?: (err: string) => void;
  onCommandResult?: (result: any) => void;
  inputTokens?: number;
}