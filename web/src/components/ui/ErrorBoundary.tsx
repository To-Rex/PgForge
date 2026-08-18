import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Last line of defense: a render crash shows a recoverable error panel
 * instead of unmounting the whole app into a blank page.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ maxWidth: 560 }}>
          <div className="auth-brand">
            pg<span className="accent">forge</span>
          </div>
          <div className="auth-form">
            <div className="empty-title">Unexpected interface error</div>
            <pre className="log-view" style={{ maxHeight: 200 }}>
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                this.setState({ error: null })
                window.location.reload()
              }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
