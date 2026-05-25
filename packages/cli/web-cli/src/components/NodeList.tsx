import { useStore } from '../store'
import { useApiMode } from '../hooks/useApiMode'
import { useWebRTC } from '../hooks/useWebRTC'

interface Props {
  rtc: ReturnType<typeof useWebRTC>
  apiHook: ReturnType<typeof useApiMode>
}

export default function NodeList({ rtc, apiHook }: Props) {
  const { knownNodes, removeKnownNode, connMode, isPaired, activeHostId, addLog, setApiBase } = useStore()

  const selectNode = async (nodeId: string) => {
    if (connMode === 'api') {
      addLog(`Selected node ${nodeId} — click Connect to connect`, 'info')
    } else {
      const nodeInput = document.getElementById('nodeIdInput') as HTMLInputElement
      if (nodeInput) nodeInput.value = nodeId
      const codeInput = document.querySelector('[placeholder="XXXX-XXXX"]') as HTMLInputElement
      if (codeInput?.value.trim() && !rtc.isConnecting() && !rtc.isConnected()) {
        await rtc.connect(nodeId, codeInput.value.trim())
      } else {
        addLog(`Selected ${nodeId} — enter pairing code and click Connect`, 'info')
      }
    }
  }

  if (!knownNodes.length) {
    return (
      <div className="px-4 py-4 border-b border-border">
        <div className="text-[10px] tracking-[0.15em] text-muted uppercase mb-2.5">Known Nodes</div>
        <div className="text-[11px] text-muted">No nodes yet</div>
      </div>
    )
  }

  const activeId = connMode === 'api' && isPaired ? activeHostId : null

  return (
    <div className="px-4 py-4 border-b border-border">
      <div className="text-[10px] tracking-[0.15em] text-muted uppercase mb-2.5">Known Nodes</div>
      <div className="flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
        {knownNodes.map(n => (
          <div key={n.id}
            className={`flex items-center gap-2 px-2.5 py-2 bg-bg3 border rounded text-[11px] cursor-pointer transition-colors
              ${n.id === activeId ? 'border-green' : 'border-border hover:border-muted'}`}
          >
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${n.id === activeId ? 'bg-green shadow-[0_0_4px_#22c55e]' : 'bg-muted'}`} />
            <div className="flex-1 text-text truncate cursor-pointer" onClick={() => selectNode(n.id)}>{n.id}</div>
            <button onClick={() => removeKnownNode(n.id)}
              className="text-muted hover:text-red text-[10px] bg-none border-none cursor-pointer p-0 font-mono">
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}