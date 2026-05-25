import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

// Helper to convert Uint8Array to Hex string without Node's Buffer
const toHex = (Uint8Array: Uint8Array) => 
  Array.from(Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('');

// Helper to convert Hex string to Uint8Array
const fromHex = (hex: string) => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
};

export function generateUUID(): string {
  return crypto.randomUUID();
}

export function generateRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function generateRandomHex(length: number): string {
  return toHex(generateRandomBytes(length));
}

export function deriveSharedKey(pairingCode: string, salt: string): string {
  const passwordBytes = new TextEncoder().encode(pairingCode);
  const saltBytes = new TextEncoder().encode(salt);
  
  const derived = pbkdf2(sha256, passwordBytes, saltBytes, { 
    c: 100000 
  });
  
  // Note: default dkLen for SHA256 is 32 bytes, 
  // but you can specify it as the third argument if needed:
  // pbkdf2(sha256, passwordBytes, saltBytes, { c: 100000 }, 32);

  return toHex(derived);
}

export function computeAuthHash(sharedKeyHex: string): string {
  const digest = sha256(new TextEncoder().encode(sharedKeyHex));
  return toHex(digest);
}

export function computeHMAC(sharedKeyHex: string, payload: unknown): string {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const key = fromHex(sharedKeyHex);
  const sig = hmac(sha256, key, new TextEncoder().encode(data));
  return toHex(sig);
}

export function verifyHMAC(sharedKeyHex: string, payload: unknown, signature: string): boolean {
  const expected = computeHMAC(sharedKeyHex, payload);
  if (expected.length !== signature.length) return false;
  
  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}