import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import { PopoutPanel } from './components/popout-panel'
import { ScribePill } from './components/scribe/scribe-pill'
import '@xterm/xterm/css/xterm.css'
import './styles.css'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMessage?: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ROCA] Uncaught render error:', error, info)
    this.setState({ errorMessage: `${error?.message}\n\n${error?.stack}\n\nComponent: ${info?.componentStack}` })
    // Write to file so we can debug production crashes
    try {
      // writeErrorLog is implemented in main.ts via the 'error:write-log' IPC handler
      window.electronAPI.writeErrorLog?.(
        `${new Date().toISOString()}\n${error?.message}\n${error?.stack}\n${info?.componentStack}`
      )
    } catch {}
  }
  render() {
    if (this.state.hasError) {
      const msg = this.state.errorMessage || 'Unknown error'
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, fontFamily: 'system-ui, sans-serif', color: '#888', padding: 40 }}>
          <p style={{ fontSize: 14, margin: 0 }}>Something went wrong.</p>
          <pre style={{ fontSize: 10, color: '#999', maxWidth: '80vw', maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#f5f5f5', padding: 12, borderRadius: 8, border: '1px solid #eee' }}>{msg}</pre>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => window.location.reload()}
              style={{ fontSize: 12, padding: '6px 16px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', cursor: 'pointer', color: '#555' }}
            >
              Reload ROCA
            </button>
            <button
              onClick={() => { void safeReload() }}
              title="Clear persisted tabs, panels, and active-context, then reload. Use if plain reload keeps crashing."
              style={{ fontSize: 12, padding: '6px 16px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', cursor: 'pointer', color: '#555' }}
            >
              Safe reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// Clears ROCA's persisted renderer state and the active-context file, then
// reloads. Breaks crash loops caused by a bad entry in localStorage or
// active-context.json that re-triggers the same crash on plain reload.
async function safeReload(): Promise<void> {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith('roca:')) localStorage.removeItem(key)
    }
  } catch {}
  try {
    await window.electronAPI.clearActiveContext?.()
  } catch {}
  window.location.reload()
}

// Detect popout mode from URL params
const params = new URLSearchParams(window.location.search)
const isScribePill = params.get('scribePill') === '1'
const isPopout = params.get('popout') === '1'
const popoutTaskId = params.get('taskId') ? parseInt(params.get('taskId')!) : null
const rawPopoutTab = params.get('tab')
// Legacy 'browser' popouts are no longer supported (browsers live on companion tasks now).
// Coerce stale URLs to 'terminal' so the popout still opens to something useful.
const popoutTab: 'notes' | 'terminal' | null =
  rawPopoutTab === 'notes' ? 'notes'
  : rawPopoutTab === 'terminal' ? 'terminal'
  : rawPopoutTab === 'browser' ? 'terminal'
  : null

// No StrictMode — it causes double mount/unmount which kills PTY sessions
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isScribePill
      ? <ScribePill />
      : isPopout && popoutTaskId && popoutTab
        ? <PopoutPanel taskId={popoutTaskId} tab={popoutTab} />
        : <App />}
  </ErrorBoundary>
)
