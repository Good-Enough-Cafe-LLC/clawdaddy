import { useState, useEffect } from 'react'
import { useStore, Personality } from '../store'
import { useApiMode } from '../hooks/useApiMode'
import { useWebRTC } from '../hooks/useWebRTC'

interface Props {
  rtc: ReturnType<typeof useWebRTC>
  apiHook: ReturnType<typeof useApiMode>
}

export default function PersonalityList({ rtc, apiHook }: Props) {
  const {
    personalities, setPersonalities, activeModeId, setActiveModeId,
    connMode, isPaired, addLog,
  } = useStore()

  // Track whether the active mode matches the server's current system prompt.
  // 'synced' = confirmed match, 'unsynced' = mismatch or unknown, 'custom' = server
  // has a prompt that doesn't match any local mode.
  const [serverPrompt, setServerPrompt] = useState<string | null>(null)

  const isConnected = connMode === 'api' ? isPaired : rtc.isConnected()

  // ── Fetch server's current system prompt when connection is established ──────
  // This lets us highlight the matching mode (or show none if it's a custom prompt).
  useEffect(() => {
    if (!isConnected) { setServerPrompt(null); return }

    const fetchPrompt = async () => {
      try {
        if (connMode === 'api') {
          const r = await apiHook.apiPost('/v1/command', { command: 'get_system_prompt', payload: {} })
          if (r.ok) setServerPrompt(r.data?.result?.systemPrompt ?? null)
        } else {
          const result: any = await rtc.runCommand('get_system_prompt')
          setServerPrompt(result?.systemPrompt ?? null)
        }
      } catch (_) {}
    }

    fetchPrompt()
  }, [isConnected, connMode])

  // Derive which mode is active based on what the server actually has,
  // not just local store state. If no mode matches, activeModeId stays but
  // we show it as out of sync.
  const activeMode = serverPrompt
    ? personalities.find(m => m.systemPrompt === serverPrompt)
    : personalities.find(m => m.id === activeModeId)

  // ── Send system prompt to server ──────────────────────────────────────────
  const sendSystemPrompt = async (prompt: string): Promise<boolean> => {
    try {
      if (connMode === 'api' && isPaired) {
        const r = await apiHook.apiPost('/v1/command', { command: 'set_system_prompt', payload: prompt })
        return r.ok
      } else if (connMode === 'rtc' && rtc.isConnected()) {
        await rtc.runCommand('set_system_prompt', prompt)
        return true
      }
    } catch (_) {}
    return false
  }

  // ── Select a mode ─────────────────────────────────────────────────────────
  // Updates local state AND sends the system prompt to the server.
  const selectMode = async (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode) return

    setActiveModeId(id)

    if (!isConnected) {
      addLog(`Mode → ${mode.name} (will apply on next connect)`, 'info')
      return
    }

    addLog(`Mode → ${mode.name}`, 'info')
    const ok = await sendSystemPrompt(mode.systemPrompt)
    if (ok) {
      setServerPrompt(mode.systemPrompt)
      addLog(`✓ System prompt updated`, 'success')
    } else {
      addLog(`⚠️ Could not update server system prompt`, 'error')
    }
  }

  // ── Create ────────────────────────────────────────────────────────────────
  const createMode = () => {
    const name = prompt('Mode name:')
    if (!name?.trim()) return
    const promptText = prompt('System instructions:')
    if (!promptText?.trim()) return

    const newMode: Personality = {
      id:           `mode_${Date.now()}`,
      name:         name.trim(),
      systemPrompt: promptText.trim(),
      icon:         '✨',
      locked:       false,
    }
    setPersonalities([...personalities, newMode])
    addLog(`Created mode: ${name}`, 'success')
  }

  // ── Edit ──────────────────────────────────────────────────────────────────
  const editMode = async (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode || mode.locked) return

    const name = prompt('Mode name:', mode.name)
    if (!name?.trim()) return
    const promptText = prompt('System instructions:', mode.systemPrompt)
    if (promptText === null) return

    const updated = { ...mode, name: name.trim(), systemPrompt: promptText.trim() }
    setPersonalities(personalities.map(m => m.id === id ? updated : m))
    addLog(`Updated mode: ${name}`, 'success')

    // If this was the active mode, push the updated prompt to the server
    if (id === activeMode?.id && isConnected) {
      await sendSystemPrompt(updated.systemPrompt)
      setServerPrompt(updated.systemPrompt)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const deleteMode = (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode || mode.locked) return
    if (!confirm(`Delete "${mode.name}"?`)) return
    setPersonalities(personalities.filter(m => m.id !== id))
    if (activeModeId === id) setActiveModeId('chat_buddy')
    addLog(`Deleted mode: ${mode.name}`, 'success')
  }

  return (
    <div>
      {/* Header */}
      <div className="px-4 py-4 border-b border-border">
        <div className="text-[10px] tracking-[0.15em] text-muted uppercase mb-2.5">Personalities</div>
        <button
          onClick={createMode}
          className="w-full py-1.5 px-2 bg-bg3 border border-border rounded font-mono text-[11px] text-text-dim hover:text-text transition-colors cursor-pointer touch-manipulation"
        >
          + New personality
        </button>
        {/* Show current server prompt if it doesn't match any mode */}
        {isConnected && serverPrompt && !activeMode && (
          <div className="mt-2 text-[10px] text-amber leading-relaxed">
            ⚠️ Server has a custom system prompt that doesn't match any personality.
          </div>
        )}
      </div>

      {/* Mode list */}
      <div className="px-4 py-2">
        {personalities.map(m => {
          const isActive = m.id === activeMode?.id
          const isSynced = isActive && serverPrompt === m.systemPrompt

          return (
            <div
              key={m.id}
              className={`bg-bg3 border rounded mb-1.5 overflow-hidden transition-colors
                ${isActive ? 'border-amber bg-[rgba(245,158,11,0.04)]' : 'border-border'}
                ${m.locked ? 'opacity-70' : ''}`}
            >
              <div
                className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-white/[0.02]"
                onClick={() => selectMode(m.id)}
              >
                {/* Active indicator dot */}
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 transition-all
                  ${isActive
                    ? isSynced || !isConnected
                      ? 'bg-amber shadow-[0_0_4px_#f59e0b]'
                      : 'bg-amber opacity-50'        // active locally but not confirmed on server
                    : 'bg-muted'}`}
                />
                <div className="flex-1 text-[11px] text-text truncate">{m.icon} {m.name}</div>
                {m.locked && <span className="text-[10px] text-muted">🔒</span>}
                {isActive && isConnected && !isSynced && (
                  <span className="text-[10px] text-amber" title="Not yet synced to server">↻</span>
                )}
              </div>

              {!m.locked && (
                <div className="flex border-t border-border">
                  <button
                    onClick={() => editMode(m.id)}
                    className="flex-1 py-1 font-mono text-[10px] text-text-dim hover:text-text hover:bg-white/[0.04] bg-none border-none cursor-pointer transition-colors touch-manipulation"
                  >
                    edit
                  </button>
                  <button
                    onClick={() => deleteMode(m.id)}
                    className="flex-1 py-1 font-mono text-[10px] text-text-dim hover:text-red hover:bg-white/[0.04] bg-none border-l border-border cursor-pointer transition-colors touch-manipulation"
                  >
                    delete
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}