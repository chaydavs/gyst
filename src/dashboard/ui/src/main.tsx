import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', background: '#fff',
          fontFamily: 'monospace', padding: '40px', gap: '16px',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#000' }}>
            Dashboard failed to load
          </div>
          <pre style={{
            fontSize: '11px', color: '#cc0000', background: '#fff5f5',
            border: '1px solid #ffcccc', borderRadius: '4px',
            padding: '16px', maxWidth: '700px', whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              fontSize: '12px', padding: '8px 16px', cursor: 'pointer',
              border: '1px solid #000', borderRadius: '4px', background: '#fff',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
