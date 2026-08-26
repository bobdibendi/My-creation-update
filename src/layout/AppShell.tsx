import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Resizer } from '../components/ui'
import { transitions } from '../animations'

interface Props {
  titlebar: ReactNode
  commandbar: ReactNode
  rail: ReactNode
  /** Null hides the sidebar column entirely. */
  sidebar: ReactNode | null
  sidebarWidth: number
  onResizeSidebar: (delta: number) => void
  main: ReactNode
  dock: ReactNode | null
  agent: ReactNode | null
  agentWidth: number
  onResizeAgent: (delta: number) => void
  statusbar: ReactNode
  /** Modals, palettes, splash. Rendered above everything. */
  overlays?: ReactNode
}

/**
 * Application frame.
 *
 * `.app-shell` must exist exactly once: both `test-renderer.cjs` and
 * `test-app.cjs` count it to decide whether React mounted. Columns animate
 * their width rather than being unmounted, so panels keep their internal state
 * (terminal process, iframe, scroll position) across toggles.
 */
export function AppShell({
  titlebar, commandbar, rail, sidebar, sidebarWidth, onResizeSidebar,
  main, dock, agent, agentWidth, onResizeAgent, statusbar, overlays,
}: Props) {
  return (
    <div className="app-shell">
      <span className="app-shell__aurora" aria-hidden />
      {titlebar}
      {commandbar}

      <main className="workspace">
        {rail}

        <AnimatePresence initial={false} mode="wait">
          {sidebar && (
            <motion.div
              key="sidebar"
              className="workspace__sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: sidebarWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={transitions.normal}
            >
              <div className="workspace__sidebar-inner" style={{ width: sidebarWidth }}>
                {sidebar}
              </div>
              <Resizer axis="x" label="Redimensionner la barre latérale" onResize={onResizeSidebar} />
            </motion.div>
          )}
        </AnimatePresence>

        <div className="workspace__center">
          {main}
          {dock}
        </div>

        <AnimatePresence initial={false} mode="wait">
          {agent && (
            <motion.div
              key="agent"
              className="workspace__agent"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: agentWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={transitions.normal}
            >
              <Resizer axis="x" label="Redimensionner l’assistant" onResize={onResizeAgent} />
              <div className="workspace__agent-inner" style={{ width: agentWidth }}>
                {agent}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {statusbar}
      {overlays}
    </div>
  )
}
