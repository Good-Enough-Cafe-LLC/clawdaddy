// src/lib/crypto.ts
// Browser + Node compatible crypto utilities using @noble/hashes
// Works in Vite/React without Node.js dependencies

import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

// Helper: Uint8Array → hex string (no Node Buffer)
export const toHex = (bytes: Uint8Array): string => 
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

// Helper: hex string → Uint8Array
export const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
};

/**
 * Derives a shared key from pairing code + salt using PBKDF2-HMAC-SHA256.
 * Returns hex string for easy storage/transmission.
 */
export async function deriveSharedKey(pairingCode: string, salt: string): Promise<string> {
  const passwordBytes = new TextEncoder().encode(pairingCode);
  const saltBytes = new TextEncoder().encode(salt);
  
  const derived = pbkdf2(sha256, passwordBytes, saltBytes, { 
    c: 100000,  // iterations
    dkLen: 32   // output length (SHA256 = 32 bytes)
  });
  
  return toHex(derived);
}

/**
 * Computes a one-way auth hash from the shared key.
 * Used to register with the switchboard without revealing the key.
 */
export async function computeAuthHash(sharedKeyHex: string): Promise<string> {
  const digest = sha256(new TextEncoder().encode(sharedKeyHex));
  return toHex(digest);
}

/**
 * Computes HMAC-SHA256 signature for a payload.
 * Payload can be any JSON-serializable value.
 */
export async function computeHMAC(sharedKeyHex: string, payload: unknown): Promise<string> {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const key = fromHex(sharedKeyHex);
  const sig = hmac(sha256, key, new TextEncoder().encode(data));
  return toHex(sig);
}

/**
 * Verifies an HMAC signature in constant time.
 */
export async function verifyHMAC(
  sharedKeyHex: string, 
  payload: unknown, 
  signature: string
): Promise<boolean> {
  const expected = await computeHMAC(sharedKeyHex, payload);
  if (expected.length !== signature.length) return false;
  
  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}