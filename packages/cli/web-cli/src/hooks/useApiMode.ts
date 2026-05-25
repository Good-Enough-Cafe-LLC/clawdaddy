import { useCallback, useRef } from 'react'
import { useStore } from '../store'

export function useApiMode() {
  const { apiBase, isPaired, addLog } = useStore()
  const abortRef = useRef<AbortController | null>(null)

  const getBase = useCallback(() =>
    (document.getElementById('apiBaseInput') as HTMLInputElement)?.value?.trim() || apiBase,
  [apiBase])

  const apiGet = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${getBase()}${path}`)
      const data = await res.json()
      return { ok: res.ok, status: res.status, data }
    } catch (e: any) {
      addLog(`Network error: ${e.message}`, 'error')
      return { ok: false, status: 0, data: { error: e.message } }
    }
  }, [addLog, getBase])

  const apiPost = useCallback(async (path: string, body: unknown) => {
    try {
      const res = await fetch(`${getBase()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      return { ok: res.ok, status: res.status, data }
    } catch (e: any) {
      addLog(`Network error: ${e.message}`, 'error')
      return { ok: false, status: 0, data: { error: e.message } }
    }
  }, [addLog, getBase])

  const stopApiMode = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    if (useStore.getState().isPaired) useStore.getState().setPairedState(false)
  }, [])

  const runCommand = useCallback(async (name: string, payload?: unknown) => {
    if (!useStore.getState().isPaired) { addLog('Not connected.', 'error'); return }
    addLog(`→ command: ${name}${payload !== undefined ? ' ' + JSON.stringify(payload) : ''}`, 'data')
    const result = await apiPost('/v1/command', { command: name, payload })
    if (result.ok) addLog(`← ${JSON.stringify(result.data)}`, 'success')
    else addLog(`← error: ${result.data?.error || 'unknown'}`, 'error')
  }, [addLog, apiPost])

  return { apiGet, apiPost, stopApiMode, runCommand, abortRef }
}