import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { generateRandomHex } from '@clawdaddy/core';
import type { PairedHost } from './types.js';

const CONFIG_DIR = path.join(os.homedir(), '.clawdaddy');
export const CLIENT_ID_FILE = path.join(CONFIG_DIR, 'client-id.json');
export const PAIRING_FILE = path.join(CONFIG_DIR, 'paired.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'client-config.json');


const SIGNAL_SERVER = 'https://clawdaddyswitch01.goodenoughcafe.com';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.7;

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ─── Client config (tunable values) ──────────────────────────────────────────

export interface ClawdaddyConfig {
  signalServer: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  defaultMaxTokens: number;
  defaultTemperature: number;
}

const DEFAULT_CONFIG: ClawdaddyConfig = {
  signalServer: SIGNAL_SERVER,
  reconnectBaseMs: RECONNECT_BASE_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  defaultTemperature: DEFAULT_TEMPERATURE,
};

/**
 * Returns the persisted config merged over defaults. If no config file exists
 * yet, writes one with defaults so the user has a file to edit.
 */
export function getConfig(): ClawdaddyConfig {
  let stored: Partial<ClawdaddyConfig> = {};

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // Fall through — use defaults
  }

  const config = { ...DEFAULT_CONFIG, ...stored };

  if (!fs.existsSync(CONFIG_FILE)) {
    try {
      ensureConfigDir();
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
      console.warn('⚠️ Failed to write default config:', (e as Error).message);
    }
  }

  return config;
}

export function saveConfig(config: ClawdaddyConfig): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.warn('⚠️ Failed to save config:', (e as Error).message);
  }
}

// ─── Client identity ──────────────────────────────────────────────────────────

/**
 * Reads the persisted client ID from disk, or generates and saves a new one.
 */
export function getOrCreateClientId(): string {
  try {
    if (fs.existsSync(CLIENT_ID_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLIENT_ID_FILE, 'utf-8'));
      if (data.clientId) return data.clientId;
    }
  } catch {
    // Fall through to generate a new ID
  }

  const clientId = `client-${generateRandomHex(4)}`;

  try {
    ensureConfigDir();
    fs.writeFileSync(CLIENT_ID_FILE, JSON.stringify({ clientId }, null, 2));
  } catch (e) {
    console.warn('⚠️ Failed to save client ID:', (e as Error).message);
  }

  return clientId;
}

// ─── Paired hosts ─────────────────────────────────────────────────────────────

/**
 * Loads paired hosts from disk into the provided Map.
 * All hosts are marked as disconnected on load.
 */
export function loadPairedHosts(pairedHosts: Map<string, PairedHost>): void {
  try {
    if (fs.existsSync(PAIRING_FILE)) {
      const data = JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const p of data as PairedHost[]) {
          pairedHosts.set(p.id, { ...p, connected: false });
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ Failed to load paired hosts:', (e as Error).message);
  }
}

/**
 * Persists the current paired hosts map to disk.
 */
export function savePairedHosts(pairedHosts: Map<string, PairedHost>): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(Array.from(pairedHosts.values()), null, 2));
  } catch (e) {
    console.warn('⚠️ Failed to save paired hosts:', (e as Error).message);
  }
}