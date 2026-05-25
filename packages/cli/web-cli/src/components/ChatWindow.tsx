import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useApiMode } from '../hooks/useApiMode'
import { useWebRTC } from '../hooks/useWebRTC'
import type { ClawdaddyMessage, InferenceRequest } from '@clawdaddy/core'

interface Props {
  rtc: ReturnType<typeof useWebRTC>
  apiHook: ReturnType<typeof useApiMode>
  isMobile?: boolean
}

export default function ChatWindow({ rtc, apiHook, isMobile }: Props) {
  const { messages, connMode, isPaired, maxTokens, temperature, personalities, activeModeId, addMessage, updateMessage, addLog } = useStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const getActiveSystemPrompt = () => {
    const mode = personalities.find(m => m.id === activeModeId)
    return mode?.systemPrompt || null
  }

  const canSend = connMode === 'api' ? isPaired : rtc.isConnected()

  const sendMessage = async () => {
    const text = inputRef.current?.value.trim()
    if (!text || !canSend) return
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = '' }

    if (text.startsWith('/cmd ') || text.startsWith('/')) {
      const withoutSlash = text.startsWith('/cmd ') ? text.slice(5).trim() : text.slice(1)
      const spaceIdx = withoutSlash.indexOf(' ')
      const cmdName = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)
      let payload: any = spaceIdx === -1 ? undefined : withoutSlash.slice(spaceIdx + 1).trim()
      if (payload) { try { payload = JSON.parse(payload) } catch(_) {} }
      if (connMode === 'api') apiHook.runCommand(cmdName, payload)
      else rtc.runCommand(cmdName, payload)
      return
    }

    addMessage('user', text)

    if (connMode === 'api') {
      await sendApiMessage(text)
    } else {
      await sendRtcMessage(text)
    }
  }

  const sendApiMessage = async (text: string) => {
    const msg = addMessage('assistant', '')
    updateMessage(msg.id, '', undefined, true)

    let fullText = ''
    const sysprompt = getActiveSystemPrompt()
    const body: any = {
      model: 'clawdaddy',
      messages: [{ role: 'user', content: text }],
      max_tokens: maxTokens, temperature, stream: true,
    }
    if (sysprompt) body.system = sysprompt

    if (apiHook.abortRef.current) apiHook.abortRef.current.abort()
    apiHook.abortRef.current = new AbortController()

    try {
      const base = (document.getElementById('apiBaseInput') as HTMLInputElement)?.value?.trim() || useStore.getState().apiBase
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: apiHook.abortRef.current.signal,
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error?.message || `HTTP ${res.status}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let inputTokens = 0, outputTokens = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim() || line.startsWith('event:')) continue
          if (line.startsWith('data:')) {
            const jsonStr = line.slice(5).trim()
            if (jsonStr === '[DONE]') continue
            try {
              const event = JSON.parse(jsonStr)
              if (event.type === 'content_block_delta' && event.delta?.text) {
                fullText += event.delta.text
                updateMessage(msg.id, fullText, undefined, true)
              }
              if (event.type === 'message_start') inputTokens = event.message?.usage?.input_tokens || 0
              if (event.type === 'message_delta') outputTokens = event.usage?.output_tokens || 0
              if (event.type === 'error') throw new Error(event.error?.message || 'Stream error')
            } catch (e: any) { if (e.message === 'Stream error') throw e }
          }
        }
      }
      updateMessage(msg.id, fullText, `${inputTokens} in · ${outputTokens} out tok`, false)
      addLog(`Done: ${outputTokens} tokens`, 'success')
    } catch (e: any) {
      if (e.name === 'AbortError') {
        updateMessage(msg.id, fullText + ' [cancelled]', undefined, false)
        addLog('Stream cancelled', 'info')
      } else {
        updateMessage(msg.id, `Error: ${e.message}`, undefined, false)
        addLog(`Error: ${e.message}`, 'error')
      }
    } finally {
      apiHook.abortRef.current = null
    }
  }

  const sendRtcMessage = async (text: string) => {
    const msg = addMessage('assistant', '')
    updateMessage(msg.id, '', undefined, true)
    const requestId = crypto.randomUUID()
    let fullText = ''

    rtc.pendingRef.current.set(requestId, {
      onToken: (t) => { fullText += t; updateMessage(msg.id, fullText, undefined, true) },
      onDone: (stats) => {
        updateMessage(msg.id, fullText, `${stats.tokens} tok · ${stats.tps?.toFixed(1)} tok/s · ${stats.ms}ms`, false)
        addLog(`Done: ${stats.tokens} tokens @ ${stats.tps?.toFixed(1)} tok/s`, 'success')
      },
      onError: (err) => { updateMessage(msg.id, `Error: ${err}`, undefined, false); addLog(`Error: ${err}`, 'error') },
    })

    const payload: InferenceRequest & { system?: string } = {
      type: 'inference', requestId,
      messages: [{ role: 'user', content: text }] as ClawdaddyMessage[],
      options: { temperature, max_tokens: maxTokens, stream: true }
    }
    const sysprompt = getActiveSystemPrompt()
    if (sysprompt) payload.system = sysprompt
    await rtc.sendSecure(payload)
  }

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const autoResize = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    e.target.style.height = ''
    e.target.style.height = Math.min(e.target.scrollHeight, 140) + 'px'
  }

  return (
    // flex flex-col + min-h-0 is the key: it lets this column shrink to fit
    // its grid cell rather than expanding to content height, which is what
    // pushes the input off screen when the browser is zoomed or the URL bar
    // is visible. The messages area takes all remaining space and scrolls
    // internally; the input bar never moves.
    <main className="flex flex-col h-full min-h-0 bg-bg">

      {/* Scrollable messages — takes all available space */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-7 py-4 md:py-6 flex flex-col gap-4 md:gap-5 scroll-smooth">
        {messages.length === 0 && <EmptyState isMobile={isMobile} />}
        {messages.map(m => (
          <div key={m.id} className={`flex flex-col gap-1.5 max-w-[92vw] md:max-w-[800px] ${m.role === 'user' ? 'self-end items-end' : 'self-start items-start'}`}>
            <div className={`text-[10px] tracking-[0.12em] uppercase ${m.role === 'user' ? 'text-red' : 'text-muted'}`}>
              {m.role === 'user' ? 'you' : '🦞 node'}
            </div>
            <div className={`px-3 md:px-4 py-2.5 md:py-3 rounded-lg text-[13px] leading-[1.7] font-sans whitespace-pre-wrap break-words
              ${m.role === 'user' ? 'bg-red text-white' : 'bg-bg2 border border-border text-text'}`}>
              {m.content}
              {m.streaming && <span className="cursor" />}
            </div>
            {m.stats && <div className="text-[10px] text-muted">{m.stats}</div>}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar — always at the bottom, never scrolls away */}
      <div className="flex-shrink-0 px-3 md:px-7 py-3 md:py-4 border-t border-border bg-bg2 flex gap-2">
        <textarea
          ref={inputRef}
          rows={1}
          disabled={!canSend}
          placeholder={canSend ? 'Message your node… or /cmd <command> to send a raw command' : 'Connect to a node to start chatting'}
          onKeyDown={handleKey}
          onChange={autoResize}
          className="flex-1 bg-bg3 border border-border rounded-md px-3 py-2.5 font-sans text-[14px] text-text outline-none resize-none min-h-[44px] max-h-[140px] leading-[1.5] transition-colors placeholder:text-muted focus:border-red disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ fontSize: '16px' }}
        />
        <button
          disabled={!canSend}
          onClick={sendMessage}
          className="self-end px-4 md:px-[18px] py-2.5 bg-red text-white border-none rounded-md font-mono text-[13px] font-medium cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-35 disabled:cursor-not-allowed whitespace-nowrap touch-manipulation"
        >
          Send
        </button>
      </div>
    </main>
  )
}

function EmptyState({ isMobile }: { isMobile?: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted px-4">
      <div className="text-[40px] md:text-[48px] opacity-30">🦞</div>
      <div className="text-[18px] md:text-[20px] tracking-[0.08em] text-center">connect to start chatting</div>
      <div className="mt-1 text-[11px] text-muted text-center max-w-[320px] leading-[1.8]">
        <div className="mb-2">chat normally, or prefix with <span className="text-blue font-mono">/cmd &lt;command&gt;</span> to send a raw command</div>
        <div className="text-[10px] text-text-dim mb-1"><br />to start your own node:</div>
        <div className="font-mono text-[10px] text-blue text-left inline-block leading-loose">
          <span className="text-text-dim">$ </span>ollama pull llama3.2 <span className="text-[#9ca3af]"># or whichever model you prefer</span><br />
          <span className="text-text-dim">$ </span>npm install -g clawdaddy<br />
          <span className="text-text-dim">$ </span>clawdaddy serve llama3.2
        </div>
      </div>
    </div>
  )
}