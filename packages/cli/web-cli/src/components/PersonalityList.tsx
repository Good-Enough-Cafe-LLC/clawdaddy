import { useStore, Personality } from '../store'
import { useApiMode } from '../hooks/useApiMode'
import { useWebRTC } from '../hooks/useWebRTC'

interface Props {
  rtc: ReturnType<typeof useWebRTC>
  apiHook: ReturnType<typeof useApiMode>
}

export default function PersonalityList({ rtc, apiHook }: Props) {
  const { personalities, setPersonalities, activeModeId, setActiveModeId, connMode, isPaired, addLog } = useStore()

  const sendModeChange = (id: string) => {
    if (connMode === 'api' && isPaired) {
      apiHook.runCommand('set_active_mode', id)
    } else if (connMode === 'rtc' && rtc.isConnected()) {
      rtc.runCommand('set_active_mode', id)
    }
  }

  const selectMode = (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode) return
    setActiveModeId(id)
    addLog(`Mode → ${mode.name}`, 'info')
    sendModeChange(id)
  }

  const createMode = () => {
    const name = prompt('Mode Name:')
    if (!name) return
    const promptText = prompt('System Instructions:')
    if (!promptText) return
    const newMode: Personality = {
      id: `${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`,
      name, systemPrompt: promptText, icon: '✨', locked: false,
    }
    setPersonalities([...personalities, newMode])
    addLog(`Created mode: ${name}`, 'success')
  }

  const editMode = (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode || mode.locked) return
    const name = prompt('Mode name:', mode.name)
    if (!name) return
    const promptText = prompt('System instructions:', mode.systemPrompt)
    if (promptText === null) return
    setPersonalities(personalities.map(m => m.id === id ? { ...m, name, systemPrompt: promptText } : m))
    addLog(`Updated mode: ${name}`, 'success')
  }

  const deleteMode = (id: string) => {
    const mode = personalities.find(m => m.id === id)
    if (!mode || mode.locked) return
    if (!confirm(`Delete "${mode.name}"?`)) return
    setPersonalities(personalities.filter(m => m.id !== id))
    if (activeModeId === id) setActiveModeId('chat_buddy')
    addLog(`Deleted mode: ${mode.name}`, 'success')
  }

  const syncFromServer = async () => {
    const isApi = connMode === 'api' && isPaired
    const isRtc = connMode === 'rtc' && rtc.isConnected()
    if (!isApi && !isRtc) { addLog('Not connected — cannot sync from server', 'error'); return }
    addLog('Fetching modes from server...', isApi ? 'api' : 'rtc')
    if (isApi) {
      const r = await apiHook.apiPost('/v1/command', { command: 'get_modes', payload: {} })
      if (r.ok && Array.isArray(r.data?.result)) {
        let added = 0
        const updated = [...personalities]
        r.data.result.forEach((sm: Personality) => { if (!updated.some(m => m.id === sm.id)) { updated.push({ ...sm, locked: false }); added++ } })
        setPersonalities(updated)
        addLog(`Synced: ${added} new mode(s)`, 'success')
      } else addLog('Could not fetch modes from server', 'error')
    }
  }

  const pushToServer = async () => {
    const isApi = connMode === 'api' && isPaired
    if (!isApi) { addLog('Push only supported in API mode for now', 'info'); return }
    const toPush = personalities.filter(m => !m.locked)
    if (!toPush.length) { addLog('No custom modes to push', 'info'); return }
    let ok = 0
    for (const m of toPush) {
      const r = await apiHook.apiPost('/v1/command', { command: 'upsert_mode', payload: m })
      if (r.ok) ok++
    }
    addLog(`Pushed ${ok}/${toPush.length} modes`, ok === toPush.length ? 'success' : 'error')
  }

  return (
    <div>
      {/* Header */}
      <div className="px-4 py-4 border-b border-border">
        <div className="text-[10px] tracking-[0.15em] text-muted uppercase mb-2.5">Personalities</div>
        <div className="flex gap-1.5">
          <button onClick={createMode} className="flex-1 py-1.5 px-2 bg-bg3 border border-border rounded font-mono text-[11px] text-text-dim hover:text-text transition-colors cursor-pointer touch-manipulation">+ New</button>
          <button onClick={syncFromServer} title="Pull modes from server" className="py-1.5 px-2 bg-bg3 border border-border rounded font-mono text-[11px] text-text-dim hover:text-text transition-colors cursor-pointer whitespace-nowrap touch-manipulation">↓ Server</button>
          <button onClick={pushToServer} title="Push modes to server" className="py-1.5 px-2 bg-bg3 border border-border rounded font-mono text-[11px] text-text-dim hover:text-text transition-colors cursor-pointer whitespace-nowrap touch-manipulation">↑ Push</button>
        </div>
      </div>
      
      {/* List - just flows, no forced max-height */}
      <div className="px-4 py-2">
        {personalities.map(m => {
          const isActive = m.id === activeModeId
          return (
            <div key={m.id}
              className={`bg-bg3 border rounded mb-1.5 overflow-hidden transition-colors
                ${isActive ? 'border-amber bg-[rgba(245,158,11,0.04)]' : 'border-border'}
                ${m.locked ? 'opacity-70' : ''}`}
            >
              <div className="flex items-center gap-2 px-2.5 py-2 cursor-pointer hover:bg-white/[0.02]" onClick={() => selectMode(m.id)}>
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isActive ? 'bg-amber shadow-[0_0_4px_#f59e0b]' : 'bg-muted'}`} />
                <div className="flex-1 text-[11px] text-text truncate">{m.icon} {m.name}</div>
                {m.locked && <span className="text-[10px] text-muted">🔒</span>}
              </div>
              {!m.locked && (
                <div className="flex border-t border-border">
                  <button onClick={() => editMode(m.id)} className="flex-1 py-1 font-mono text-[10px] text-text-dim hover:text-text hover:bg-white/[0.04] bg-none border-none cursor-pointer transition-colors touch-manipulation">edit</button>
                  <button onClick={() => deleteMode(m.id)} className="flex-1 py-1 font-mono text-[10px] text-text-dim hover:text-red hover:bg-white/[0.04] bg-none border-l border-border cursor-pointer transition-colors touch-manipulation">delete</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}