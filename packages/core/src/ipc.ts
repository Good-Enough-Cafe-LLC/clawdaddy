// ─── IPC / Local Transport ────────────────────────────────────────────────────
//
// Shared utility for deriving the Unix domain socket path used when the client
// and server are on the same machine. Both sides import this so they always
// agree on the filename without any configuration.
//
// The path is derived from the hostId so multiple server instances don't
// collide with each other.

import { platform } from 'os';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Returns the Unix socket path for a given hostId.
 * Normalized so casing and punctuation differences don't create mismatches.
 *
 * Examples:
 *   getSocketPath('F2D2-76AF') → '/tmp/clawdaddy-F2D2-76AF.sock'
 *   getSocketPath('f2d2-76af') → '/tmp/clawdaddy-F2D2-76AF.sock'
 */
export function getSocketPath(hostId: string): string {
    const normalized = hostId.trim().toUpperCase().replace(/[^A-Z0-9]/g, '-');
    // macOS has a 104-char limit on Unix socket paths — use tmpdir() on all
    // platforms to stay well under it.
    return join(tmpdir(), `clawdaddy-${normalized}.sock`);
}