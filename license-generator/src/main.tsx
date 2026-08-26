import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * Filet de sécurité global : toute erreur non gérée affiche un écran lisible
 * au lieu d'une page blanche silencieuse.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null }

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[license-generator] crash capté:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <div className="app">
        <header className="header">
          <h1>My Creation License Generator</h1>
          <p style={{ color: '#f87171' }}>
            Une erreur inattendue a interrompu l’interface.
          </p>
        </header>
        <section className="card">
          <span className="field-label">Détails de l’erreur</span>
          <pre className="token-box" style={{ whiteSpace: 'pre-wrap' }}>{this.state.message}</pre>
          <div className="actions">
            <button className="primary" onClick={() => this.setState({ message: null })}>
              Réessayer
            </button>
          </div>
        </section>
      </div>
    )
  }
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Élément #root introuvable')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
