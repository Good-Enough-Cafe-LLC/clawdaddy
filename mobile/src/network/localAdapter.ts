/**
 * localAdapter.ts
 * ───────────────
 * Bridges the client UI to runInference without any network or WebRTC.
 * Presents the same packet-based interface that the P2P channel uses,
 * so the client chat component doesn't care whether it's local or remote.
 *
 * Usage:
 *   const adapter = createLocalAdapter({ llamaRef, modesRef, inferringRef, onStart, onEnd, onLog });
 *   adapter.sendPacket({ type: 'inference', requestId, messages, options });
 *   // token/done/error callbacks fire synchronously as inference runs
 */

import { runInference } from '../inference/inferenceEngine';
import { LlamaContext } from 'llama.rn';
import { Mode } from '../storage/modes';

export type AdapterPacket =
  | { type: 'token';  requestId: string; token: string }
  | { type: 'done';   requestId: string; stats: { tokens: number; ms: number; tps: number } }
  | { type: 'error';  requestId: string; error: string; code: string };

export interface LocalAdapter {
  /** Send an inference request. Responses arrive via onPacket. */
  sendPacket: (packet: InferencePacket) => void;
  /** Cancel any in-progress inference for a given requestId. */
  cancel: (requestId: string) => void;
}

export interface InferencePacket {
  type: 'inference';
  requestId: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  options?: { temperature?: number; max_tokens?: number; stream?: boolean };
}

export interface LocalAdapterOptions {
  llamaRef: React.MutableRefObject<LlamaContext | null>;
  modesRef: React.MutableRefObject<Mode[]>;
  activeModeIdRef: React.MutableRefObject<string>;
  inferringRef: React.MutableRefObject<boolean>;
  onPacket: (packet: AdapterPacket) => void;
  onStart: () => void;
  onEnd: () => void;
  onLog: (msg: string, type?: any) => void;
}

// We need React for the MutableRefObject type — import it
import React from 'react';

export function createLocalAdapter(opts: LocalAdapterOptions): LocalAdapter {
  const {
    llamaRef,
    modesRef,
    activeModeIdRef,
    inferringRef,
    onPacket,
    onStart,
    onEnd,
    onLog,
  } = opts;

  // Track active abort signal per requestId so cancel() can stop a stream
  const abortMap = new Map<string, () => void>();

  const sendPacket = (packet: InferencePacket) => {
    if (packet.type !== 'inference') return;

    const activeMode =
      modesRef.current.find(m => m.id === activeModeIdRef.current) ??
      modesRef.current[0];

    // runInference's send callback — translate outgoing packets back to our consumer
    const send = (outgoing: any) => {
      onPacket(outgoing as AdapterPacket);
    };

    // Wire up a cancel handle before starting
    let cancelled = false;
    abortMap.set(packet.requestId, () => { cancelled = true; });

    runInference({
      request: {
        ...packet,
        activeMode,
      },
      llama: llamaRef.current,
      send,
      isBusy: () => inferringRef.current,
      onStart: () => {
        onStart();
      },
      onEnd: () => {
        abortMap.delete(packet.requestId);
        onEnd();
      },
      onLog,
    });
  };

  const cancel = (requestId: string) => {
    const abort = abortMap.get(requestId);
    if (abort) {
      abort();
      abortMap.delete(requestId);
    }
  };

  return { sendPacket, cancel };
}