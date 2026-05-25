// src/commands/commandEngine.ts
// Handles non-mode commands (ping, get_logs, etc.).
// Mode commands (get_modes, upsert_mode, delete_mode, set_active_mode) are
// handled directly in App.tsx so they operate on live React state.
// This engine is the fallback for everything else.

export interface CommandRequest {
    type: 'command';
    requestId: string;
    command: string;
    payload?: any;
}

export type OutgoingPacket =
    | { type: 'command_result'; requestId: string; result: any }
    | { type: 'command_error'; requestId: string; error: string };

export const handleCommand = async ({
    request,
    send,
    onLog,
}: {
    request: CommandRequest;
    send: (packet: OutgoingPacket) => void;
    onLog: (msg: string, type?: any) => void;
}) => {
    const { requestId } = request;

    try {
        let result;

        switch (request.command) {
            case 'ping':
                result = { ok: true, ts: Date.now() };
                break;

            case 'get_logs':
                result = []; // placeholder — wire up real log buffer if needed
                break;

            default:
                throw new Error(`Unknown command: ${request.command}`);
        }

        send({ type: 'command_result', requestId, result });

    } catch (e: any) {
        send({ type: 'command_error', requestId, error: e.message });
    }
};