import { useCallback, useState, useEffect } from 'react'
import { useStore, ConnMode } from './store'
import { useApiMode } from './hooks/useApiMode'
import { useWebRTC } from './hooks/useWebRTC'
import Topbar from './components/Topbar'
import Sidebar from './components/Sidebar'
import ChatWindow from './components/ChatWindow'

export default function App() {
  const { connMode, setConnMode, addLog, isPaired, setPairedState } = useStore()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const api = useApiMode()
  const rtc = useWebRTC()

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768
      setIsMobile(mobile)
      if (!mobile) setSidebarOpen(false)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const handleModeChange = useCallback((mode: ConnMode) => {
    if (mode === connMode) return
    if (connMode === 'api') api.stopApiMode()
    else rtc.disconnect()
    setConnMode(mode)
    setPairedState(false)
    addLog(`Switched to ${mode === 'api' ? 'API' : 'WebRTC'} mode`, mode === 'api' ? 'api' : 'rtc')
  }, [connMode, api, rtc, setConnMode, setPairedState, addLog])

  return (
    // Use fixed positioning instead of viewport height units so browser zoom
    // and mobile URL bar changes don't push the input off screen.
    <div
      className="fixed inset-0 bg-bg"
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '280px 1fr',
        gridTemplateRows: '48px 1fr',
      }}
    >
      <Topbar
        onModeChange={handleModeChange}
        isMobile={isMobile}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
      />

      {/* Mobile sidebar overlay */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        ${isMobile ? 'fixed top-12 left-0 h-[calc(100%-48px)] z-50 w-[280px] shadow-2xl bg-bg2' : 'h-full overflow-hidden'}
        ${isMobile && !sidebarOpen ? '-translate-x-full' : 'translate-x-0'}
        transition-transform duration-300 ease-in-out
      `}>
        <Sidebar rtc={rtc} isMobile={isMobile} onCloseSidebar={() => setSidebarOpen(false)} />
      </div>

      {/* Chat area — must not overflow its grid cell */}
      <div className="min-h-0 overflow-hidden flex flex-col">
        <ChatWindow rtc={rtc} apiHook={api} isMobile={isMobile} />
      </div>
    </div>
  )
}