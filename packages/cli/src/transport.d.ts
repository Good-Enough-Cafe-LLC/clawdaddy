export type PendingHandler = {
    onToken?: (token: string) => void;
    onDone?: (stats: any) => void;
    onError?: (error: string) => void;
    onCommandResult?: (result: any) => void;
    inputTokens?: number;
};
export declare const pendingRequests: Map<string, PendingHandler>;
type SendFn = (packet: any) => void;
type ConnectedFn = () => boolean;
/**
 * Called by connection.ts (WebRTC) or localTransport.ts (Unix socket)
 * when a connection is established.
 */
export declare function setTransport(send: SendFn, isConnected: ConnectedFn, hostId: string): void;
/**
 * Called when the transport tears down (disconnect, error, etc.).
 */
export declare function clearTransport(): void;
export declare function isConnected(): boolean;
export declare function getActiveHostId(): string | null;
/**
 * Send a raw packet over whichever transport is active.
 * Throws if no transport is connected.
 */
export declare function sendSecure(packet: any): void;
/**
 * Send a command and return a promise that resolves with the result.
 */
export declare function sendCommand(command: string, payload?: any): Promise<any>;
/**
 * Send an inference request. Tokens, done, and error come back via
 * pendingRequests handlers registered by the caller (api.ts / interactive.ts).
 */
export declare function sendInference(messages: {
    role: string;
    content: string;
}[], options?: {
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
}): Promise<void>;
/**
 * Dispatch an inbound packet from the server into the pending handler registry.
 * Called by both connection.ts and localTransport.ts when data arrives.
 */
export declare function handleInboundPacket(packet: any): void;
export {};
