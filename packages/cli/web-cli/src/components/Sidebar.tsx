// Sidebar.tsx - Complete rewrite with simple fixed layout

import { useRef, useState, useEffect } from 'react'
import { useStore } from '../store'
import { useApiMode } from '../hooks/useApiMode'
import NodeList from './NodeList'
import PersonalityList from './PersonalityList'

interface Props {
  rtc: ReturnType<typeof import('../hooks/useWebRTC').useWebRTC>
  isMobile?: boolean
  onCloseSidebar?: () => void
}

export default function Sidebar({ rtc, isMobile, onCloseSidebar }: Props) {
  const {
    connMode, isPaired, apiBase, setApiBase, maxTokens, setMaxTokens,
    temperature, setTemperature, addLog,
  } = useStore()

  const api = useApiMode()
  const [isApiChecking, setIsApiChecking] = useState(false)
  const apiCheckAbortRef = useRef<AbortController | null>(null)
  const clientIdRef = useRef<HTMLInputElement>(null)

  const handleApiConnect = async () => {
    if (isPaired) {
      useStore.getState().setPairedState(false)
      useStore.getState().setStatus('', 'disconnected')
      addLog('Disconnected.', 'info')
      return
    }
    if (isApiChecking) {
      apiCheckAbortRef.current?.abort()
      setIsApiChecking(false)
      useStore.getState().setStatus('', 'disconnected')
      addLog('Cancelled.', 'info')
      return
    }
    setIsApiChecking(true)
    apiCheckAbortRef.current = new AbortController()
    useStore.getState().setStatus('connecting', 'checking...')
    addLog(`Checking API at ${(document.getElementById('apiBaseInput') as HTMLInputElement)?.value?.trim() || apiBase}...`, 'api')
    try {
      const base = (document.getElementById('apiBaseInput') as HTMLInputElement)?.value?.trim() || apiBase
      const res = await fetch(`${base}/v1/status`, { signal: apiCheckAbortRef.current.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      useStore.getState().setPairedState(true, data?.connection?.nodeId || 'node')
      useStore.getState().setStatus('connected', 'connected')
      addLog('Connected to API', 'success')
    } catch (e: any) {
      if (e.name === 'AbortError') return
      useStore.getState().setStatus('error', 'unreachable')
      addLog(`Cannot reach API: ${e.message}`, 'error')
    } finally {
      setIsApiChecking(false)
      apiCheckAbortRef.current = null
    }
  }

  const nodeIdRef = useRef<HTMLInputElement>(null)
  const rtcCodeRef = useRef<HTMLInputElement>(null)

  const handleRtcToggle = () => {
    if (rtc.isConnected() || rtc.isConnecting()) {
      rtc.disconnect()
    } else {
      const id = nodeIdRef.current?.value.trim() || ''
      const code = rtcCodeRef.current?.value.trim() || ''
      const cid = clientIdRef.current?.value.trim() || undefined  // ← add
      if (!id || !code) { addLog('Enter node ID and pairing code', 'error'); return }
      rtc.connect(id, code, cid)  // ← pass through
    }
  }

  const apiCmdRef = useRef<HTMLInputElement>(null)
  const rtcCmdRef = useRef<HTMLInputElement>(null)

  const runApiCustom = () => {
    const raw = apiCmdRef.current?.value.trim() || ''
    if (!raw) return
    const spaceIdx = raw.indexOf(' ')
    const name = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)
    let payload: any = spaceIdx === -1 ? undefined : raw.slice(spaceIdx + 1).trim()
    if (payload) { try { payload = JSON.parse(payload) } catch (_) { } }
    api.runCommand(name, payload)
  }

  const runRtcCustom = () => {
    const raw = rtcCmdRef.current?.value.trim() || ''
    if (!raw) return
    const spaceIdx = raw.indexOf(' ')
    const name = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)
    let payload: any = spaceIdx === -1 ? undefined : raw.slice(spaceIdx + 1).trim()
    if (payload) { try { payload = JSON.parse(payload) } catch (_) { } }
    rtc.runCommand(name, payload)
  }

  return (
    <aside className="bg-bg2 border-r border-border flex flex-col h-full" style={{ height: '100%' }}>
      {/* Fixed header - never scrolls */}
      {isMobile && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <span className="text-[10px] tracking-[0.15em] text-muted uppercase">Menu</span>
          <button
            onClick={onCloseSidebar}
            className="text-muted hover:text-red text-sm bg-none border-none cursor-pointer touch-manipulation"
          >
            ✕
          </button>
        </div>
      )}

      {/* Scrollable content area - only this part scrolls */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Connection sections */}
        {connMode === 'api' && (
          <>
            <Section label="API Server">
              <input
                id="apiBaseInput"
                defaultValue={apiBase}
                onBlur={e => setApiBase(e.target.value.trim())}
                className={inputCls}
                spellCheck={false}
              />
              <button
                onClick={handleApiConnect}
                className={`${btnCls} w-full mt-2 ${isPaired
                  ? 'bg-red-dim text-red border border-red-dim hover:bg-red hover:text-white'
                  : isApiChecking
                    ? 'bg-bg3 text-amber border border-amber hover:bg-red-dim hover:text-red hover:border-red-dim'
                    : 'bg-red text-white hover:opacity-90'
                  }`}
              >
                {isPaired ? 'Disconnect' : isApiChecking ? 'Cancel' : 'Connect'}
              </button>
            </Section>

            {isPaired && (
              <Section label="Commands">
                <div className="flex gap-1.5 mb-1.5">
                  <CmdBtn label="ping" onClick={() => api.runCommand('ping')} />
                  <CmdBtn label="clear chat" onClick={() => useStore.getState().clearMessages()} />
                </div>
                <div className="flex gap-1.5">
                  <input ref={apiCmdRef} className={`${inputCls} flex-1 text-[11px] py-1.5 px-2`} placeholder="command [payload]" onKeyDown={e => e.key === 'Enter' && runApiCustom()} />
                  <button onClick={runApiCustom} className={`${btnCls} bg-bg3 text-text-dim border border-border hover:text-text whitespace-nowrap px-2.5 text-[11px] touch-manipulation`}>run</button>
                </div>
              </Section>
            )}
          </>
        )}

        {connMode === 'rtc' && (
          <>
            <Section label="WebRTC Direct">
              <div className="flex flex-col gap-2">
                <div>
                  <div className="text-[10px] text-text-dim mb-1 tracking-[0.05em]">Node ID</div>
                  <input ref={nodeIdRef} id="nodeIdInput" className={`${inputCls} focus:border-purple`} placeholder="xxxx-xxxx (hex)" spellCheck={false} onKeyDown={e => e.key === 'Enter' && handleRtcToggle()} />
                </div>
                <div>
                  <div className="text-[10px] text-text-dim mb-1 tracking-[0.05em]">Pairing Code</div>
                  <input ref={rtcCodeRef} className={inputCls} placeholder="XXXX-XXXX" type="password" autoComplete="off" onKeyDown={e => e.key === 'Enter' && handleRtcToggle()} />
                </div>
                <div>
                  <div className="text-[10px] text-text-dim mb-1 tracking-[0.05em]">
                    Client ID <span className="text-muted">(optional — for persistent memory)</span>
                  </div>
                  <input
                    ref={clientIdRef}
                    className={`${inputCls} focus:border-purple font-mono text-[11px]`}
                    placeholder={`auto: ${rtc.getClientId()?.slice(0, 12) ?? '...'}...`}
                    spellCheck={false}
                  />
                </div>
                <button
                  id="connectBtn"
                  onClick={handleRtcToggle}
                  className={`${btnCls} w-full ${rtc.isConnected()
                    ? 'bg-red-dim text-red border border-red-dim hover:bg-red hover:text-white'
                    : rtc.isConnecting()
                      ? 'bg-bg3 text-amber border border-amber hover:bg-red-dim hover:text-red hover:border-red-dim'
                      : 'bg-purple text-[#0d0d1a] font-semibold hover:opacity-90'
                    }`}
                >
                  {rtc.isConnected() ? 'Disconnect' : rtc.isConnecting() ? 'Cancel' : 'Connect'}
                </button>
              </div>
            </Section>

            {rtc.isConnected() && (
              <Section label="Commands">
                <div className="flex gap-1.5 mb-1.5">
                  <CmdBtn label="ping" onClick={() => rtc.runCommand('ping')} />
                  <CmdBtn label="clear chat" onClick={() => useStore.getState().clearMessages()} />
                </div>
                <div className="flex gap-1.5">
                  <input ref={rtcCmdRef} className={`${inputCls} flex-1 text-[11px] py-1.5 px-2`} placeholder="command [payload]" onKeyDown={e => e.key === 'Enter' && runRtcCustom()} />
                  <button onClick={runRtcCustom} className={`${btnCls} bg-bg3 text-text-dim border border-border hover:text-text whitespace-nowrap px-2.5 text-[11px] touch-manipulation`}>run</button>
                </div>
              </Section>
            )}
          </>
        )}

        <NodeList rtc={rtc} apiHook={api} />
        <Section label="Settings">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-text-dim">Max tokens</span>
            <input type="number" value={maxTokens} onChange={e => setMaxTokens(Number(e.target.value))}
              className="text-[11px] text-text bg-bg3 border border-border rounded px-2 py-1 w-[70px] text-right font-mono focus:outline-none focus:border-red" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-dim">Temperature</span>
            <input type="number" step="0.1" min="0" max="2" value={temperature} onChange={e => setTemperature(Number(e.target.value))}
              className="text-[11px] text-text bg-bg3 border border-border rounded px-2 py-1 w-[70px] text-right font-mono focus:outline-none focus:border-red" />
          </div>
        </Section>

        {/* PersonalityList - now with its own scroll if needed */}
        <PersonalityList rtc={rtc} apiHook={api} />
      </div>

      {/* Log panel - fixed height, scrolls internally, auto-scrolls to bottom */}
      <LogPanel />
    </aside>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 border-b border-border">
      <div className="text-[10px] tracking-[0.15em] text-muted uppercase mb-2.5">{label}</div>
      {children}
    </div>
  )
}

function CmdBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="flex-1 py-1.5 px-2 bg-bg3 border border-border rounded font-mono text-[11px] text-text-dim
        hover:border-purple hover:text-text transition-colors text-center cursor-pointer touch-manipulation">
      {label}
    </button>
  )
}

function LogPanel() {
  const { logs } = useStore()
  const clearLogs = () => useStore.setState({ logs: [] })
  const filtered = logs.filter(l => !l.msg.includes('/v1/status'))
  const logContainerRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className="flex-shrink-0 flex flex-col h-[300px] bg-bg2 border-t border-border">
      <div className="px-4 py-2 flex items-center justify-between flex-shrink-0 border-b border-border">
        <span className="text-[10px] tracking-[0.15em] text-muted uppercase">Log</span>
        <button
          onClick={clearLogs}
          title="Clear log"
          className="text-muted hover:text-red text-[11px] bg-none border-none cursor-pointer leading-none transition-colors touch-manipulation"
        >
          ✕
        </button>
      </div>
      <div
        ref={logContainerRef}
        className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-0.5"
      >
        {filtered.map(l => (
          <div key={l.id} className={`text-[10px] leading-[1.6] ${logColor(l.type)}`}>
            <span className="text-muted mr-1.5">{l.ts}</span>{l.msg}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="text-[10px] text-text-dim text-center py-2">No logs yet</div>
        )}
      </div>
    </div>
  )
}

function logColor(type: string) {
  switch (type) {
    case 'success': return 'text-green'
    case 'error': return 'text-red'
    case 'data': return 'text-amber'
    case 'api': return 'text-blue'
    case 'rtc': return 'text-purple'
    default: return 'text-text-dim'
  }
}

const inputCls = 'w-full bg-bg3 border border-border rounded py-[7px] px-2.5 font-mono text-[12px] text-text outline-none transition-colors placeholder:text-muted focus:border-red'
const btnCls = 'py-2 px-3.5 font-mono text-[12px] font-medium border-none rounded cursor-pointer tracking-[0.05em] transition-all active:scale-[0.97] touch-manipulation'