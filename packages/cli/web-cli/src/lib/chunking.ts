import type { ChunkFrame } from '@clawdaddy/core'

const CHUNK_SIZE = 12_000

export function buildChunks(serialised: string): ChunkFrame[] {
  const id = crypto.randomUUID()
  const total = Math.ceil(serialised.length / CHUNK_SIZE)
  return Array.from({ length: total }, (_, i) => ({
    id, index: i, total,
    data: serialised.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
  }))
}
