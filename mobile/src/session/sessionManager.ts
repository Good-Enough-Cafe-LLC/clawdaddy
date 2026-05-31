import RNFS from 'react-native-fs';
import { estimateTokens } from './tokenEstimator';

const CLIENTS_DIR = `${RNFS.DocumentDirectoryPath}/clients`;

export interface LTMFact {
  key: string;
  value: string;
  timestamp: number;
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokenCount: number;
}

export interface ClientSession {
  clientId: string;
  systemPrompt: string;
  ltm: Record<string, string>;
  conversationHistory: ConversationEntry[];
  totalTokens: number;
  lastActivity: number;
  contextWindow: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Be conversational and remember context from our conversation. 
If you need to reference previous information, do so naturally.`;

// LTM extraction patterns (same as server)
const LTM_PATTERNS = [
  { pattern: /my name is (\w+)/i, key: 'name', template: "User's name is $1" },
  { pattern: /(?:i'?m|i am) (\d+) years? old/i, key: 'age', template: 'User is $1 years old' },
  { pattern: /i live in ([^,.]+)/i, key: 'location', template: 'User lives in $1' },
  // ... add more patterns
];

function clientDir(clientId: string): string {
  const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${CLIENTS_DIR}/${safe}`;
}

async function ensureClientDir(clientId: string): Promise<string> {
  const dir = clientDir(clientId);
  await RNFS.mkdir(dir, { NSURLIsExcludedFromBackupKey: true });
  return dir;
}

export async function loadClientSession(clientId: string): Promise<ClientSession | null> {
  const dir = clientDir(clientId);
  if (!await RNFS.exists(dir)) return null;

  let systemPrompt = DEFAULT_SYSTEM_PROMPT;
  let ltm: Record<string, string> = {};
  let conversationHistory: ConversationEntry[] = [];

  const promptFile = `${dir}/system_prompt.txt`;
  if (await RNFS.exists(promptFile)) {
    systemPrompt = await RNFS.readFile(promptFile, 'utf8');
  }

  const ltmFile = `${dir}/ltm.json`;
  if (await RNFS.exists(ltmFile)) {
    try {
      ltm = JSON.parse(await RNFS.readFile(ltmFile, 'utf8'));
    } catch (_) {}
  }

  const stmFile = `${dir}/stm.json`;
  if (await RNFS.exists(stmFile)) {
    try {
      conversationHistory = JSON.parse(await RNFS.readFile(stmFile, 'utf8'));
    } catch (_) {}
  }

  return {
    clientId,
    systemPrompt,
    ltm,
    conversationHistory,
    totalTokens: conversationHistory.reduce((sum, e) => sum + e.tokenCount, 0),
    lastActivity: Date.now(),
    contextWindow: 4096,
  };
}

export async function saveClientSession(session: ClientSession): Promise<void> {
  const dir = await ensureClientDir(session.clientId);
  await RNFS.writeFile(`${dir}/system_prompt.txt`, session.systemPrompt, 'utf8');
  await RNFS.writeFile(`${dir}/ltm.json`, JSON.stringify(session.ltm, null, 2), 'utf8');
  // Keep only last 200 messages
  const toSave = session.conversationHistory.slice(-200);
  await RNFS.writeFile(`${dir}/stm.json`, JSON.stringify(toSave, null, 2), 'utf8');
}

export function extractLTMFacts(text: string, existing: Record<string, string>): { updated: Record<string, string>; newKeys: string[] } {
  const updated = { ...existing };
  const newKeys: string[] = [];

  for (const { pattern, key, template } of LTM_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const fact = template.replace(/\$(\d+)/g, (_, n) => (match[parseInt(n)] ?? '').trim());
    if (fact && updated[key] !== fact) {
      updated[key] = fact;
      newKeys.push(key);
    }
  }
  return { updated, newKeys };
}

export function formatLTM(ltm: Record<string, string>): string {
  return Object.values(ltm).join('\n');
}
