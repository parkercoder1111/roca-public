import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import PopoutPanel from './components/PopoutPanel'
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
      ;(window as any).electronAPI?.writeErrorLog?.(
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
          <button
            onClick={() => window.location.reload()}
            style={{ fontSize: 12, padding: '6px 16px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', background: 'transparent', cursor: 'pointer', color: '#555' }}
          >
            Reload ROCA
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// Detect popout mode from URL params
const params = new URLSearchParams(window.location.search)
const isPopout = params.get('popout') === '1'
const popoutTaskId = params.get('taskId') ? parseInt(params.get('taskId')!) : null
const popoutTab = params.get('tab') as 'notes' | 'terminal' | 'browser' | null

// No StrictMode — it causes double mount/unmount which kills PTY sessions
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isPopout && popoutTaskId && popoutTab
      ? <PopoutPanel taskId={popoutTaskId} tab={popoutTab} />
      : <App />}
  </ErrorBoundary>
)
