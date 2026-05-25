// ─── Chunked framing ──────────────────────────────────────────────────────────
//
// WebRTC data channels have a ~16KB message size limit. Large messages
// (tool definitions, file context, etc.) easily exceed this.
//
// Protocol: each logical message is split into N chunks. Every chunk is a
// JSON frame sent as a single WebRTC message:
//
//   { id: string, index: number, total: number, data: string }
//
// The receiver reassembles chunks by `id` before parsing/verifying the packet.

import { CHUNK_SIZE, CHUNK_TIMEOUT_MS, MAX_TOTAL_CHUNKS, MAX_SERIALIZED_SIZE } from './constants'

export interface ChunkFrame {
    id: string;
    index: number;
    total: number;
    data: string;
}

interface ChunkEntry {
    chunks: string[];
    total: number;
    received: number;
    timeout: any;
}

const incomingChunks = new Map<string, ChunkEntry>();

/**
 * Accumulates chunk frames and returns the reassembled serialised string once
 * all chunks have arrived. Returns null if more chunks are still expected, or
 * if the frame is rejected due to validation failure.
 */
export function reassemble(frame: ChunkFrame): string | null {
    if (frame.total > MAX_TOTAL_CHUNKS) return null;
    if (frame.total * CHUNK_SIZE > MAX_SERIALIZED_SIZE) return null;
    if (frame.index < 0 || frame.total <= 0 || frame.index >= frame.total) return null;

    if (!incomingChunks.has(frame.id)) {
        const timeout = setTimeout(() => {
            incomingChunks.delete(frame.id);
        }, CHUNK_TIMEOUT_MS);

        incomingChunks.set(frame.id, {
            chunks: new Array(frame.total),
            total: frame.total,
            received: 0,
            timeout,
        });
    }

    const entry = incomingChunks.get(frame.id)!;

    // Only store and count if this index hasn't arrived yet (idempotent on retransmit)
    if (entry.chunks[frame.index] === undefined) {
        entry.chunks[frame.index] = frame.data;
        entry.received++;
    }

    if (entry.received < entry.total) return null;

    clearTimeout(entry.timeout);
    const serialised = entry.chunks.join('');
    incomingChunks.delete(frame.id);
    return serialised;
}
