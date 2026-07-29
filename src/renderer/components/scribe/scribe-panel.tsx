import { useEffect, useState, useCallback } from 'react'
import { ScribeList } from './scribe-list'
import { ScribeDetail } from './scribe-detail'
import type { ScribeRecording, CalEvent } from './types'

// Home for Scribe (meeting note-taker): recordings list on the left, transcript
// detail on the right, with a Record/Stop control. Calendar "Coming up" and the
// enhanced-notes view arrive in later phases.
export function ScribePanel() {
  const [recordings, setRecordings] = useState<ScribeRecording[]>([])
  const [upcoming, setUpcoming] = useState<CalEvent[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [status, setStatus] = useState<string>('idle')

  const refresh = useCallback(async () => {
    const list = (await window.electronAPI.scribe.list()) as ScribeRecording[]
    setRecordings(list)
    return list
  }, [])

  const refreshUpcoming = useCallback(async () => {
    try {
      setUpcoming((await window.electronAPI.scribe.upcoming()) as CalEvent[])
    } catch {
      /* calendar optional */
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    refreshUpcoming()
    const t = setInterval(refreshUpcoming, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [refreshUpcoming])

  useEffect(() => window.electronAPI.scribe.onStatus((p) => setStatus(p.state)), [])
  useEffect(
    () =>
      window.electronAPI.scribe.onDone(() => {
        setStatus('idle')
        refresh()
      }),
    [refresh]
  )
  // Notes generate asynchronously after a recording ends — refresh the list as
  // its status moves transcribed → cleaning → noting → done.
  useEffect(() => window.electronAPI.scribe.onUpdated(() => refresh()), [refresh])

  const start = useCallback(async () => {
    const title = `Meeting — ${new Date().toLocaleString()}`
    const res = await window.electronAPI.scribe.start(title)
    if ('error' in res) {
      setStatus('error')
      return
    }
    setStatus('recording')
    const list = await refresh()
    setSelectedId(res.id)
    void list
  }, [refresh])

  const stop = useCallback(async () => {
    await window.electronAPI.scribe.stop()
  }, [])

  const startEvent = useCallback(
    async (e: CalEvent) => {
      const res = await window.electronAPI.scribe.start(e.title, e.id)
      if ('error' in res) {
        setStatus('error')
        return
      }
      setStatus('recording')
      await refresh()
      setSelectedId(res.id)
    },
    [refresh]
  )

  const recording = status === 'recording' || status === 'transcribing'

  return (
    <div className="flex flex-1 min-h-0 bg-surface-0">
      <ScribeList
        recordings={recordings}
        upcoming={upcoming}
        selectedId={selectedId}
        onSelect={setSelectedId}
        status={status}
        onStart={start}
        onStop={stop}
        onStartEvent={startEvent}
      />
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {selectedId != null ? (
          <ScribeDetail id={selectedId} live={recording} />
        ) : (
          <div className="m-auto text-center px-6">
            <div className="mono-caps text-[10px] text-text-3/60 mb-1.5">Scribe</div>
            <div className="text-[12.5px] text-text-3">Record a meeting, or pick one on the left.</div>
          </div>
        )}
      </div>
    </div>
  )
}
