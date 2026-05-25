import { useState } from 'react'
import { useStore, ConnMode } from '../store'
import HelpModal from './HelpModal'

interface Props {
  onModeChange: (mode: ConnMode) => void
  isMobile?: boolean
  sidebarOpen?: boolean
  onToggleSidebar?: () => void
}

export default function Topbar({ onModeChange, isMobile, sidebarOpen, onToggleSidebar }: Props) {
  const { connMode, statusState, statusText, isPaired, activeHostId, apiBase } = useStore()
  const [helpOpen, setHelpOpen] = useState(false)

  const dotClass = statusState === 'connected' ? 'bg-green shadow-[0_0_6px_#22c55e]'
    : statusState === 'connecting' ? 'bg-amber status-connecting'
    : statusState === 'error' ? 'bg-red'
    : 'bg-muted'

  const rightText = connMode === 'api'
    ? (isPaired && activeHostId ? activeHostId : apiBase.replace('http://', ''))
    : (isPaired && activeHostId ? activeHostId : 'direct p2p')

  const rightColor = connMode === 'rtc' ? 'text-purple' : 'text-blue'

  return (
    <>
      <header className="flex items-center gap-3 px-3 md:px-5 bg-bg2 border-b border-border h-12 flex-shrink-0 z-50 relative w-full"
        style={{ gridColumn: '1 / -1' }}
      >
        {isMobile && (
          <button 
            onClick={onToggleSidebar}
            className="p-1.5 rounded hover:bg-white/5 text-text-dim flex-shrink-0"
            aria-label="Toggle menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {sidebarOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        )}
        
        <span className="text-red font-semibold text-base md:text-lg tracking-widest font-mono whitespace-nowrap">🦞 CLAWDADDY</span>
        <span className="text-border hidden sm:inline">/</span>

        <div className="flex items-center gap-2 text-xs text-text-dim tracking-wide font-mono">
          <div className={`w-[7px] h-[7px] rounded-full ${dotClass}`} />
          <span className="hidden md:inline">{statusText}</span>
        </div>

        <div className="flex bg-bg3 border border-border rounded overflow-hidden ml-auto md:ml-4 flex-shrink-0">
          {(['api', 'rtc'] as ConnMode[]).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`px-2 md:px-3 py-1 font-mono text-[10px] font-medium tracking-widest uppercase transition-colors
                ${connMode === m
                  ? m === 'api' ? 'bg-bg2 text-blue' : 'bg-bg2 text-purple'
                  : 'text-muted hover:text-text-dim'
                }`}
            >
              {m === 'api' ? 'API' : 'WebRTC'}
            </button>
          ))}
        </div>

        <div className={`hidden md:block ml-auto font-mono text-[11px] text-text-dim`}>
          {connMode === 'api' ? 'api' : 'webrtc'}{' '}
          <span className={rightColor}>{rightText}</span>
        </div>

        <button
          onClick={() => setHelpOpen(v => !v)}
          className="border border-border text-text-dim font-mono text-[11px] px-[10px] py-1 rounded hover:text-text transition-colors ml-2 flex-shrink-0"
        >
          ?
        </button>
      </header>

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
    </>
  )
}