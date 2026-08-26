import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Monitor, Terminal as TerminalIcon, X } from 'lucide-react'
import { TerminalView } from './TerminalView'
import { Preview } from './Preview'
import { Analysis } from './Analysis'
import { IconButton, Resizer, StatusDot } from './ui'
import { transitions } from '../animations'
import { cx } from './ui/cx'
import type { DockTab } from '../shared/types'
import type { usePreview } from '../hooks/usePreview'
import type { useProjectAnalysis } from '../hooks/useProjectAnalysis'

interface Props {
  open: boolean
  activeTab: DockTab
  workspace: string | null
  height: number
  preview: ReturnType<typeof usePreview>
  analysis: ReturnType<typeof useProjectAnalysis>
  onSelectTab: (tab: DockTab) => void
  onResize: (delta: number) => void
  onClose: () => void
}

const TABS: Array<{ id: DockTab; label: string; icon: typeof TerminalIcon }> = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'preview', label: 'Aperçu', icon: Monitor },
  { id: 'analysis', label: 'Analyse', icon: BarChart3 },
]

/**
 * Dockable bottom panel hosting Terminal, Aperçu and Analyse.
 *
 * Every tab stays mounted once it has been opened: unmounting the preview would
 * reload the iframe and unmounting the terminal would kill the shell.
 */
export function DockPanel({
  open, activeTab, workspace, height, preview, analysis, onSelectTab, onResize, onClose,
}: Props) {
  const [mounted, setMounted] = useState<Set<DockTab>>(new Set())

  useEffect(() => {
    if (!open) return
    setMounted(previous => (previous.has(activeTab) ? previous : new Set(previous).add(activeTab)))
  }, [open, activeTab])

  // xterm and Monaco both need an explicit refit after a geometry change.
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(
      () => document.dispatchEvent(new CustomEvent('dock-resized')),
      40,
    )
    return () => window.clearTimeout(timer)
  }, [open, height, activeTab])

  const notifyResizeEnd = useCallback(() => {
    document.dispatchEvent(new CustomEvent('dock-resized'))
  }, [])

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="dock"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transitions.normal}
        >
          <Resizer
            axis="y"
            label="Redimensionner le panneau inférieur"
            onResize={onResize}
            onDone={notifyResizeEnd}
          />

          <div className="dock__head">
            <div className="dock__tabs" role="tablist" aria-label="Panneaux inférieurs">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === activeTab}
                  className={cx('dock__tab', id === activeTab && 'is-active')}
                  onClick={() => onSelectTab(id)}
                >
                  <Icon size={12} />
                  {label}
                  {id === 'preview' && preview.status.state === 'running' && (
                    <StatusDot tone="success" pulse size={5} />
                  )}
                  {id === activeTab && (
                    <motion.span
                      layoutId="dock-underline"
                      className="dock__tab-underline"
                      transition={{ type: 'spring', stiffness: 480, damping: 34 }}
                    />
                  )}
                </button>
              ))}
            </div>
            <IconButton
              label="Fermer le panneau"
              size="sm"
              icon={<X size={13} />}
              onClick={onClose}
            />
          </div>

          <div className="dock__body">
            {mounted.has('terminal') && (
              <div className={cx('dock__pane', activeTab === 'terminal' && 'is-visible')}>
                <TerminalView active={mounted.has('terminal')} workspace={workspace} />
              </div>
            )}

            {mounted.has('preview') && (
              <div className={cx('dock__pane', activeTab === 'preview' && 'is-visible')}>
                <Preview
                  workspace={workspace}
                  status={preview.status}
                  log={preview.log}
                  tabs={preview.tabs}
                  activeTab={preview.activeTab}
                  capturing={preview.capturing}
                  error={preview.error}
                  busy={preview.busy}
                  reloadToken={preview.reloadToken}
                  onStart={preview.start}
                  onStop={preview.stop}
                  onReload={preview.reload}
                  onNavigate={preview.navigate}
                  onBack={preview.goBack}
                  onForward={preview.goForward}
                  onZoom={preview.setZoom}
                  onSelectTab={preview.selectTab}
                  onCloseTab={preview.closeTab}
                  onOpenTab={preview.openTab}
                  onCapture={preview.takeCapture}
                  onOpenExternally={preview.openExternally}
                />
              </div>
            )}

            {mounted.has('analysis') && (
              <div className={cx('dock__pane', activeTab === 'analysis' && 'is-visible')}>
                <Analysis
                  workspace={workspace}
                  analysis={analysis.analysis}
                  graph={analysis.graph}
                  capture={preview.capture}
                  loading={analysis.loading}
                  error={analysis.error}
                  capturing={preview.capturing}
                  onRefresh={analysis.refresh}
                  onCapture={preview.takeCapture}
                />
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
