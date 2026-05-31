// src/session/persistence.ts
import RNFS from 'react-native-fs';
import { Platform } from 'react-native';

// Get the app's document directory for storing client data
const getClientsDir = async (): Promise<string> => {
  const baseDir = RNFS.DocumentDirectoryPath;
  const clientsDir = `${baseDir}/clients`;
  
  const exists = await RNFS.exists(clientsDir);
  if (!exists) {
    await RNFS.mkdir(clientsDir);
  }
  
  return clientsDir;
};

const getClientDir = async (clientId: string): Promise<string> => {
  const safe = clientId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const clientsDir = await getClientsDir();
  const clientDir = `${clientsDir}/${safe}`;
  
  const exists = await RNFS.exists(clientDir);
  if (!exists) {
    await RNFS.mkdir(clientDir);
  }
  
  return clientDir;
};

export interface LTMStore {
  [key: string]: string;
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokenCount: number;
}

export interface ClientData {
  systemPrompt: string;
  ltm: LTMStore;
  stm: ConversationEntry[];
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Be conversational and remember context from our conversation. 
If you need to reference previous information, do so naturally.`;

export const loadClientData = async (clientId: string): Promise<ClientData | null> => {
  try {
    const clientDir = await getClientDir(clientId);
    
    // Load system prompt
    const promptFile = `${clientDir}/system_prompt.txt`;
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;
    if (await RNFS.exists(promptFile)) {
      systemPrompt = await RNFS.readFile(promptFile, 'utf8');
    }
    
    // Load LTM
    const ltmFile = `${clientDir}/ltm.json`;
    let ltm: LTMStore = {};
    if (await RNFS.exists(ltmFile)) {
      const ltmContent = await RNFS.readFile(ltmFile, 'utf8');
      ltm = JSON.parse(ltmContent);
    }
    
    // Load STM
    const stmFile = `${clientDir}/stm.json`;
    let stm: ConversationEntry[] = [];
    if (await RNFS.exists(stmFile)) {
      const stmContent = await RNFS.readFile(stmFile, 'utf8');
      stm = JSON.parse(stmContent);
    }
    
    return { systemPrompt, ltm, stm };
  } catch (error) {
    console.error('Failed to load client data:', error);
    return null;
  }
};

export const saveSystemPrompt = async (clientId: string, prompt: string): Promise<void> => {
  const clientDir = await getClientDir(clientId);
  await RNFS.writeFile(`${clientDir}/system_prompt.txt`, prompt, 'utf8');
};

export const saveLTM = async (clientId: string, ltm: LTMStore): Promise<void> => {
  const clientDir = await getClientDir(clientId);
  await RNFS.writeFile(`${clientDir}/ltm.json`, JSON.stringify(ltm, null, 2), 'utf8');
};

export const saveSTM = async (clientId: string, history: ConversationEntry[]): Promise<void> => {
  const clientDir = await getClientDir(clientId);
  // Keep only last 200 messages for storage
  const toSave = history.slice(-200);
  await RNFS.writeFile(`${clientDir}/stm.json`, JSON.stringify(toSave, null, 2), 'utf8');
};

export const clearClientData = async (clientId: string): Promise<void> => {
  const clientDir = await getClientDir(clientId);
  await RNFS.unlink(clientDir);
};