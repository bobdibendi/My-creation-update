import { motion } from 'framer-motion'
import {
  BarChart3, Bell, Check, CircleDot, GitBranch, Loader2, Monitor, Terminal,
  TriangleAlert, WifiOff, XCircle,
} from 'lucide-react'
import type { DockTab, PreviewStatus, ProjectAnalysis, Tab } from '../shared/types'
import type { SaveState } from '../hooks/useEditor'
import { StatusDot, Tooltip } from '../components/ui'
import { cx } from '../components/ui/cx'

interface Props {
  branch: string | null
  changeCount: number
  activeTab: Tab | undefined
  preview: PreviewStatus
  analysis: ProjectAnalysis | null
  dockOpen: boolean
  dockTab: DockTab
  saveState: SaveState
  notificationCount: number
  onToggleDock: (tab: DockTab) => void
  onOpenNotifications: () => void
}

const PREVIEW_LABEL: Record<PreviewStatus['state'], string> = {
  idle: 'inactif',
  installing: 'installation',
  starting: 'démarrage',
  running: 'en cours',
  error: 'erreur',
  stopped: 'arrêté',
}

/**
 * Bottom status bar.
 *
 * `.statusbar` and a `.status-indicator` whose text contains "Electron" are
 * asserted by `scripts/test-renderer.cjs` and `scripts/test-app.cjs`.
 */
export function Statusbar({
  branch, changeCount, activeTab, preview, analysis, dockOpen, dockTab,
  saveState, notificationCount, onToggleDock, onOpenNotifications,
}: Props) {
  const inElectron = Boolean(window.electronAPI)
  const online = navigator.onLine
  const previewLive = preview.state === 'running'
  const analysisFailed = analysis?.state === 'FAIL'

  return (
    <footer className="statusbar">
      <button type="button" className="statusbar__item" onClick={() => onToggleDock('analysis')}>
        <GitBranch size={11} />
        <span>{branch ?? 'aucun dépôt'}</span>
        {changeCount > 0 && <span className="statusbar__count">{changeCount}</span>}
      </button>

      <button
        type="button"
        className={cx('statusbar__item', dockOpen && dockTab === 'terminal' && 'is-active')}
        onClick={() => onToggleDock('terminal')}
      >
        <Terminal size={11} />
        <span>Terminal</span>
      </button>

      <button
        type="button"
        className={cx('statusbar__item', dockOpen && dockTab === 'preview' && 'is-active')}
        onClick={() => onToggleDock('preview')}
      >
        <Monitor size={11} />
        <span>Aperçu</span>
        {previewLive
          ? <StatusDot tone="success" pulse size={6} />
          : <span className="statusbar__muted">{PREVIEW_LABEL[preview.state]}</span>}
      </button>

      <button
        type="button"
        className={cx('statusbar__item', dockOpen && dockTab === 'analysis' && 'is-active')}
        onClick={() => onToggleDock('analysis')}
      >
        <BarChart3 size={11} />
        <span>Analyse</span>
        {analysis && (
          <span className={cx('statusbar__pill', analysisFailed ? 'is-fail' : 'is-pass')}>
            {analysis.state}
          </span>
        )}
      </button>

      {/* Autosave : l'utilisateur sait toujours où en est son travail. */}
      {activeTab && (
        <span
          className={cx(
            'statusbar__save',
            saveState === 'saved' && 'is-ok',
            saveState === 'error' && 'is-error',
            saveState === 'saving' && 'is-busy',
          )}
          role="status"
        >
          {saveState === 'saving' && <Loader2 size={10} className="spin" aria-hidden />}
          {saveState === 'saved' && <Check size={10} aria-hidden />}
          {saveState === 'error' && <XCircle size={10} aria-hidden />}
          {saveState === 'saving' ? 'Enregistrement…'
            : saveState === 'saved' ? 'Enregistré'
              : saveState === 'error' ? 'Échec de l’enregistrement'
                : activeTab.dirty ? '· non enregistré' : null}
        </span>
      )}

      <span className="statusbar__fill" />

      {analysisFailed && (
        <motion.span
          className="statusbar__warn"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <TriangleAlert size={11} />
          {analysis.issues.filter(issue => issue.severity === 'error').length} erreur(s)
        </motion.span>
      )}

      <span className="statusbar__item is-static">
        {activeTab ? activeTab.language : 'Prêt'}
      </span>
      <span className="statusbar__item is-static">UTF-8</span>
      <span className="statusbar__item is-static">LF</span>

      {!online && (
        <Tooltip content="Hors ligne — les fonctionnalités locales restent disponibles." side="top">
          <span className="statusbar__item is-static is-offline">
            <WifiOff size={11} aria-hidden /> Hors ligne
          </span>
        </Tooltip>
      )}

      <Tooltip content="Notifications" side="top">
        <button type="button" className="statusbar__item" onClick={onOpenNotifications}>
          <Bell size={11} />
          {notificationCount > 0 && <span className="statusbar__count">{notificationCount}</span>}
        </button>
      </Tooltip>

      <span className={cx('status-indicator', inElectron ? 'is-online' : 'is-offline')}>
        <CircleDot size={10} />
        {inElectron ? 'Electron' : 'Navigateur'}
      </span>
    </footer>
  )
}

