import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Must be evaluated before anything creates a Monaco editor.
import './lib/monacoEnvironment'
import App from './App'
import { ThemeProvider } from './theme'
import { MotionProvider } from './animations'
import { ToastProvider } from './components/ui'
import { I18nProvider } from './i18n'
import './styles/app.css'

// ─── Diagnostics de démarrage ──────────────────────────
// Toute erreur non catchée est affichée en overlay lisible : une page blanche
// silencieuse ne doit jamais pouvoir être confondue avec un crash perdu.
function installGlobalErrorHandlers(): void {
  const renderFatal = (title: string, detail: string): void => {
    console.error(`[MY-CREATION-STARTUP] ${title}:`, detail)
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'alert')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0d0d0f;color:#f87171;'
      + 'font:13px/1.5 monospace;padding:32px;overflow:auto;white-space:pre-wrap'
    overlay.textContent = `${title}\n\n${detail}`
    document.body.appendChild(overlay)
  }

  window.addEventListener('error', event => {
    if (event.error) renderFatal('Erreur non catchée (renderer)', String(event.error.stack ?? event.error))
  })
  window.addEventListener('unhandledrejection', event => {
    renderFatal('Promesse rejetée non gérée (renderer)', String(event.reason?.stack ?? event.reason))
  })
}

console.info('[MY-CREATION-STARTUP] renderer: main.tsx chargé')
installGlobalErrorHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <MotionProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </MotionProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
)
