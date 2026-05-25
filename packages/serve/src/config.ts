import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.clawdaddy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'serve-config.json');

const SIGNAL_SERVER = 'http://clawdaddyswitch01.goodenoughcafe.com:3003';
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;


export interface ServeConfig {
  // ── Node identity ────────────────────────────────────────────────────────
  nodeId: string;
  pairingCode: string;
  // ── Inference ────────────────────────────────────────────────────────────
  model: string;
  maxConnections: number;
  contextWindow: number;
  allowMultiple: boolean;
  // ── Network (tunable, fall back to core defaults) ────────────────────────
  signalServer: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

// ollama run llama3.2 --num-ctx 128000
// OLLAMA_FLASH_ATTENTION=1 \
// OLLAMA_KV_CACHE_TYPE=q8_0 \

const DEFAULT_CONFIG: ServeConfig = {
  nodeId: '',
  pairingCode: '',
  model: 'llama3.2',
  maxConnections: 3,
  contextWindow: 16000,
  allowMultiple: true,
  signalServer: SIGNAL_SERVER,
  reconnectBaseMs: RECONNECT_BASE_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
};

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): ServeConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
  return null;
}

export function saveConfig(config: ServeConfig): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

/**
 * Returns the persisted config merged over defaults. If no config file exists
 * yet, writes one with defaults so the user has a file to edit.
 */
export function getConfig(): ServeConfig {
  const fileConfig = loadConfig();

  // If no file exists → create one
  if (!fileConfig) {
    ensureConfigDir();
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  // FILE is source of truth, defaults only fill missing keys
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
  };
}