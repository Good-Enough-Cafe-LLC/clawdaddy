import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ConnMode = 'api' | 'rtc'
export type StatusState = 'connected' | 'connecting' | 'error' | ''

export interface KnownNode { id: string; addedAt: number }
export interface LogEntry {
  id: string; ts: string; msg: string
  type: 'info' | 'success' | 'error' | 'data' | 'api' | 'rtc'
}
export interface Message {
  id: string; role: 'user' | 'assistant'; content: string
  stats?: string; streaming?: boolean
}
export interface Personality {
  id: string; name: string; icon: string; systemPrompt: string; locked?: boolean
}

export const DEFAULT_PERSONALITIES: Personality[] = [
  { id: 'chat_buddy', name: 'Chat Buddy', icon: '🦞',
    systemPrompt: 'You are a helpful, friendly assistant. Be concise and conversational.',
    locked: true },
]

type State = {
  // persisted
  knownNodes: KnownNode[]; removedNodes: string[]
  apiBase: string; maxTokens: number; temperature: number
  personalities: Personality[]; activeModeId: string
  rtcDisconnected: boolean; apiDisconnected: boolean
  // runtime
  connMode: ConnMode; isPaired: boolean; activeHostId: string | null
  currentPairingCode: string | null; statusState: StatusState; statusText: string
  logs: LogEntry[]; messages: Message[]
  // actions
  addKnownNode: (id: string) => void
  removeKnownNode: (id: string) => void
  setConnMode: (m: ConnMode) => void
  setPairedState: (paired: boolean, nodeId?: string | null) => void
  setStatus: (state: StatusState, text: string) => void
  setApiBase: (url: string) => void
  setCurrentPairingCode: (code: string | null) => void
  setRtcDisconnected: (v: boolean) => void
  setApiDisconnected: (v: boolean) => void
  addLog: (msg: string, type?: LogEntry['type']) => void
  addMessage: (role: Message['role'], content: string) => Message
  updateMessage: (id: string, content: string, stats?: string, streaming?: boolean) => void
  clearMessages: () => void
  setMaxTokens: (n: number) => void
  setTemperature: (n: number) => void
  setPersonalities: (p: Personality[]) => void
  setActiveModeId: (id: string) => void
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      // persisted defaults
      knownNodes: [], removedNodes: [], apiBase: 'http://localhost:3001',
      maxTokens: 1024, temperature: 0.7, personalities: DEFAULT_PERSONALITIES,
      activeModeId: 'chat_buddy', rtcDisconnected: false, apiDisconnected: false,
      // runtime defaults
      connMode: 'api', isPaired: false, activeHostId: null, currentPairingCode: null,
      statusState: '', statusText: 'disconnected', logs: [], messages: [],

      addKnownNode: (id) => {
        const { knownNodes, removedNodes } = get()
        if (!id || removedNodes.includes(id) || knownNodes.some(n => n.id === id)) return
        set({ knownNodes: [...knownNodes, { id, addedAt: Date.now() }] })
      },
      removeKnownNode: (id) => {
        const { knownNodes, removedNodes } = get()
        set({ knownNodes: knownNodes.filter(n => n.id !== id), removedNodes: [...removedNodes, id] })
      },
      setConnMode: (connMode) => set({ connMode }),
      setPairedState: (paired, nodeId = null) => set({
        isPaired: paired, activeHostId: paired ? nodeId ?? null : null,
        currentPairingCode: paired ? get().currentPairingCode : null,
      }),
      setStatus: (statusState, statusText) => set({ statusState, statusText }),
      setApiBase: (apiBase) => set({ apiBase }),
      setCurrentPairingCode: (currentPairingCode) => set({ currentPairingCode }),
      setRtcDisconnected: (rtcDisconnected) => set({ rtcDisconnected }),
      setApiDisconnected: (apiDisconnected) => set({ apiDisconnected }),
      addLog: (msg, type = 'info') => {
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        set(s => ({ logs: [...s.logs.slice(-200), { id: crypto.randomUUID(), ts, msg, type: type! }] }))
      },
      addMessage: (role, content) => {
        const msg: Message = { id: crypto.randomUUID(), role, content, streaming: false }
        set(s => ({ messages: [...s.messages, msg] }))
        return msg
      },
      updateMessage: (id, content, stats, streaming) => set(s => ({
        messages: s.messages.map(m =>
          m.id === id ? { ...m, content, stats: stats ?? m.stats, streaming: streaming ?? m.streaming } : m
        )
      })),
      clearMessages: () => set({ messages: [] }),
      setMaxTokens: (maxTokens) => set({ maxTokens }),
      setTemperature: (temperature) => set({ temperature }),
      setPersonalities: (personalities) => set({ personalities }),
      setActiveModeId: (activeModeId) => set({ activeModeId }),
    }),
    {
      name: 'clawdaddy-store',
      partialize: (s) => ({
        knownNodes: s.knownNodes, removedNodes: s.removedNodes,
        apiBase: s.apiBase, maxTokens: s.maxTokens, temperature: s.temperature,
        personalities: s.personalities, activeModeId: s.activeModeId,
        rtcDisconnected: s.rtcDisconnected, apiDisconnected: s.apiDisconnected,
      }),
    }
  )
)
