import React from 'react'

interface State { hasError: boolean }

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  constructor(props: React.PropsWithChildren) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <div role="alert">
            <p>Something went wrong.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1 rounded bg-black text-white text-sm mt-2"
            >Reload</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
