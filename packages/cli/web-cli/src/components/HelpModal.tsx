interface Props { onClose: () => void }

const Cmd = ({ c }: { c: string }) => <span className="text-blue">{c}</span>
const Dim = ({ c }: { c: string }) => <span className="text-muted">{c}</span>

export default function HelpModal({ onClose }: Props) {
  return (
    <div
      className="fixed top-14 right-4 w-[340px] z-50 bg-bg2 border border-border rounded-lg p-4 font-mono text-[11px] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
      onClick={e => e.stopPropagation()}
    >
      <div className="flex justify-between items-center mb-3">
        <span className="font-semibold text-blue">🦞 Help</span>
        <button onClick={onClose} className="text-muted hover:text-text bg-none border-none cursor-pointer text-sm">✕</button>
      </div>

      <Section title="Connecting">
        <div className="leading-[1.9] text-[#9ca3af] mb-3">
          <Cmd c="WebRTC tab" /> — connect directly from this browser, no install needed.<br />
          <Cmd c="API tab" /> — run a local bridge, then point this page at it:
          <div className="text-blue leading-loose mt-1 ml-2">
            <Dim c="$ " />npm install -g clawdaddy<br />
            <Dim c="$ " />clawdaddy pair &lt;nodeId&gt; &lt;pairingCode&gt;
            <Dim c="$ " />clawdaddy api &lt;nodeId&gt;
          </div>
          <span className="text-[10px] text-[#9ca3af]">then set API Server to the URL it prints (default http://localhost:3001)</span>
        </div>
      </Section>

      <Section title="Start a node">
        <div className="text-blue leading-loose mb-3">
          <Dim c="$ " />ollama pull llama3.2<br />
          <Dim c="$ " />npm install -g clawdaddy<br />
          <Dim c="$ " />clawdaddy serve llama3.2
        </div>
      </Section>

      <Section title="Available commands">
        <div className="leading-loose text-[#9ca3af]">
          {[
            ['/ping', '— check the node is alive'],
            ['/get_status', '— model, memory, connections'],
            ['/get_memory_stats', '— conversation memory usage'],
            ['/clear_memory', '— wipe conversation history'],
            ['/set_system_prompt <text>', '— swap personality'],
            ['/echo <message>', '— sanity check the tunnel'],
            ['/log <message>', '— write to server log file'],
            ['/cmd <command>', '— send any custom command'],
          ].map(([cmd, desc]) => (
            <div key={cmd}><Cmd c={cmd} /> {desc}</div>
          ))}
        </div>
      </Section>

      <div className="mt-3 pt-3 border-t border-border text-[#9ca3af] text-[10px] leading-[1.7]">
        log commands are written to <Cmd c="~/.clawdaddy/serve.log" /> — hook your agents and workflows in there.
      </div>

      <div className="mt-3 pt-3 border-t border-border text-[#9ca3af] text-[10px] leading-[1.7]">
        Clawdaddy is a constantly evolving recipe.
        Something off or have an idea? Open an issue or PR on{' '}
        <a href="https://github.com/Good-Enough-Cafe-LLC/clawdaddy/issues"
          target="_blank" rel="noreferrer" className="text-blue hover:underline">GitHub</a>.
        <br/>
         Cooked up by Good Enough Cafe, but feel free to fork it and make it your own creation.
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="text-text-dim text-[10px] uppercase tracking-[0.08em] mb-2">{title}</div>
      {children}
    </>
  )
}
