// src/renderer/lib/use-agent-runs.ts
import { useEffect, useState, useCallback } from 'react'
import type { AgentRun } from '@shared/types'

/**
 * Watch the sub-agents the claude session on `ptyId` spins up. The main process
 * tails the transcript; we just subscribe. Returns the run list (live) and a
 * fetcher for a single run's sub-agent transcript (for the click-into view).
 */
export function useAgentRuns(ptyId: string) {
  const [runs, setRuns] = useState<AgentRun[]>([])

  useEffect(() => {
    setRuns([])
    if (!ptyId) return
    let cancelled = false
    const api = window.electronAPI.agentRuns
    api.watch(ptyId).catch(() => {})
    api.get(ptyId).then((r) => { if (!cancelled) setRuns(r ?? []) }).catch(() => {})
    const off = api.onUpdate(ptyId, (r) => { if (!cancelled) setRuns(r) })
    return () => {
      cancelled = true
      off()
      api.unwatch(ptyId).catch(() => {})
    }
  }, [ptyId])

  const getEvents = useCallback(
    (runId: string) => window.electronAPI.agentRuns.events(ptyId, runId),
    [ptyId],
  )

  return { runs, getEvents }
}
