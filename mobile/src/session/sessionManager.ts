// src/session/sessionManager.ts - Fixed
import { 
  loadClientData, 
  saveSystemPrompt, 
  saveLTM, 
  saveSTM,
  LTMStore,
  ConversationEntry,
  ClientData
} from './persistence';
import { extractLTMFacts, formatLTM, estimateTokens } from './memoryManager';

export interface ClientSession {
  clientId: string | null;
  systemPrompt: string;
  ltm: LTMStore;
  conversationHistory: ConversationEntry[];
  totalTokens: number;
  lastActivity: number;
  contextWindow: number;
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, friendly assistant. 
Be conversational and remember context from our conversation. 
If you need to reference previous information, do so naturally.`;

const CURRENT_MSG_RESERVE = 500; // tokens reserved for the user's next message

class SessionManager {
  private sessions: Map<string, ClientSession> = new Map();

  getSession(peerId: string): ClientSession | undefined {
    return this.sessions.get(peerId);
  }

  createSession(peerId: string, contextWindow: number = 8192): ClientSession {
    const session: ClientSession = {
      clientId: null,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      ltm: {},
      conversationHistory: [],
      totalTokens: 0,
      lastActivity: Date.now(),
      contextWindow,
    };
    this.sessions.set(peerId, session);
    return session;
  }

  async identify(peerId: string, clientId: string, log: (msg: string, type?: string) => void): Promise<void> {
    const session = this.sessions.get(peerId);
    if (!session) return;
    
    session.clientId = clientId;
    const saved = await loadClientData(clientId);
    
    if (saved) {
      session.systemPrompt = saved.systemPrompt;
      session.ltm = saved.ltm;
      session.conversationHistory = saved.stm;
      session.totalTokens = saved.stm.reduce((sum, e) => sum + e.tokenCount, 0);
      log(`🪪 Identified ${clientId.slice(0, 12)}... — loaded ${Object.keys(saved.ltm).length} LTM facts`, 'info');
    } else {
      log(`🪪 Identified ${clientId.slice(0, 12)}... — new client`, 'info');
    }
  }

  addToHistory(peerId: string, role: 'user' | 'assistant' | 'system', content: string): void {
    const session = this.sessions.get(peerId);
    if (!session) return;
    
    const tokenCount = estimateTokens(content);
    session.conversationHistory.push({
      role,
      content,
      timestamp: Date.now(),
      tokenCount,
    });
    session.totalTokens += tokenCount;
    session.lastActivity = Date.now();
    
    if (session.clientId) {
      saveSTM(session.clientId, session.conversationHistory).catch(console.error);
    }
  }

  async extractAndSaveLTM(peerId: string, userText: string, log: (msg: string, type?: string) => void): Promise<void> {
    const session = this.sessions.get(peerId);
    if (!session?.clientId) return;
    
    const { updated, newKeys } = extractLTMFacts(userText, session.ltm);
    if (newKeys.length === 0) return;
    
    session.ltm = updated;
    await saveLTM(session.clientId, updated);
    log(`💡 LTM updated: ${newKeys.map(k => `${k}="${updated[k]}"`).join(', ')}`, 'info');
  }

  clearHistory(peerId: string): number {
    const session = this.sessions.get(peerId);
    if (!session) return 0;
    
    const cleared = session.conversationHistory.length;
    session.conversationHistory = [];
    session.totalTokens = 0;
    session.lastActivity = Date.now();
    
    if (session.clientId) {
      saveSTM(session.clientId, []).catch(console.error);
    }
    return cleared;
  }

  async setSystemPrompt(peerId: string, newPrompt: string): Promise<string | null> {
    const session = this.sessions.get(peerId);
    if (!session) return null;
    
    const old = session.systemPrompt;
    session.systemPrompt = newPrompt;
    session.lastActivity = Date.now();
    
    if (session.clientId) {
      await saveSystemPrompt(session.clientId, newPrompt);
    }
    return old;
  }

  getLTM(peerId: string): LTMStore {
    return this.sessions.get(peerId)?.ltm ?? {};
  }

  async setLTMFact(peerId: string, key: string, value: string): Promise<void> {
    const session = this.sessions.get(peerId);
    if (!session) return;
    
    session.ltm[key] = value;
    if (session.clientId) {
      await saveLTM(session.clientId, session.ltm);
    }
  }

  async clearLTM(peerId: string): Promise<number> {
    const session = this.sessions.get(peerId);
    if (!session) return 0;
    
    const count = Object.keys(session.ltm).length;
    session.ltm = {};
    if (session.clientId) {
      await saveLTM(session.clientId, {});
    }
    return count;
  }

  buildContextMessages(peerId: string): Array<{ role: string; content: string }> {
    const session = this.sessions.get(peerId);
    if (!session) return [];
    
    const ltmText = formatLTM(session.ltm);
    const systemContent = ltmText
      ? `${session.systemPrompt}\n\n## What I know about you:\n${ltmText}`
      : session.systemPrompt;
    
    const systemTokens = estimateTokens(systemContent);
    const available = session.contextWindow - systemTokens - CURRENT_MSG_RESERVE;
    
    const history: ConversationEntry[] = [];
    let used = 0;
    for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
      const entry = session.conversationHistory[i];
      if (used + entry.tokenCount > available) break;
      history.unshift(entry);
      used += entry.tokenCount;
    }
    
    return [
      { role: 'system', content: systemContent },
      ...history.map(e => ({ role: e.role, content: e.content })),
    ];
  }

  getMemory(peerId: string): any {
    const session = this.sessions.get(peerId);
    if (!session) return { hasSession: false };
    
    const ltmText = formatLTM(session.ltm);
    const systemTokens = estimateTokens(session.systemPrompt);
    const ltmTokens = estimateTokens(ltmText);
    const stmTokens = session.totalTokens;
    const totalUsed = systemTokens + ltmTokens + stmTokens;
    
    return {
      hasSession: true,
      clientId: session.clientId ? session.clientId.slice(0, 12) + '...' : null,
      contextWindow: session.contextWindow,
      usage: {
        systemPrompt: systemTokens,
        ltm: ltmTokens,
        stm: stmTokens,
        total: totalUsed,
        available: session.contextWindow - totalUsed - CURRENT_MSG_RESERVE,
        utilization: `${Math.round((totalUsed / session.contextWindow) * 100)}%`,
      },
      systemPrompt: session.systemPrompt,
      ltm: session.ltm,
      stm: {
        messageCount: session.conversationHistory.length,
        oldestMessage: session.conversationHistory[0]?.timestamp ?? null,
        newestMessage: session.conversationHistory[session.conversationHistory.length - 1]?.timestamp ?? null,
      },
    };
  }

  cleanup(peerId?: string): void {
    if (peerId) {
      this.sessions.delete(peerId);
    } else {
      const now = Date.now();
      const SESSION_TIMEOUT = 30 * 60 * 1000;
      for (const [pid, session] of this.sessions.entries()) {
        if (now - session.lastActivity > SESSION_TIMEOUT) {
          this.sessions.delete(pid);
        }
      }
    }
  }
}

export const sessionManager = new SessionManager();