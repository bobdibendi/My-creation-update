import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ArrowLeft, ArrowRight, Camera, ExternalLink, Laptop, Monitor, Play, Plus,
  RotateCw, ScrollText, Smartphone, Square, Tablet, TriangleAlert, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import type { DeviceMode, PreviewStatus, PreviewTab, PreviewTarget } from '../shared/types'
import { Badge, EmptyState, IconButton, Segmented, Spinner, StatusDot, Tooltip } from './ui'
import { fade, transitions } from '../animations'
import { cx } from './ui/cx'

interface Props {
  workspace: string | null
  status: PreviewStatus
  log: string[]
  tabs: PreviewTab[]
  activeTab: PreviewTab | null
  capturing: boolean
  error: string
  busy: boolean
  reloadToken: number
  onStart: (relativePath?: string, install?: boolean) => void
  onStop: () => void
  onReload: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onZoom: (zoom: number) => void
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onOpenTab: (url: string) => void
  onCapture: () => void
  onOpenExternally: () => void
}

const STATE_LABEL: Record<PreviewStatus['state'], string> = {
  idle: 'inactif',
  installing: 'installation',
  starting: 'démarrage',
  running: 'en cours',
  error: 'erreur',
  stopped: 'arrêté',
}

const STATE_TONE: Record<PreviewStatus['state'], 'neutral' | 'accent' | 'success' | 'danger' | 'warning'> = {
  idle: 'neutral',
  installing: 'warning',
  starting: 'accent',
  running: 'success',
  error: 'danger',
  stopped: 'neutral',
}

/** Viewport presets, in CSS pixels. `responsive` fills the panel. */
const DEVICES: Record<DeviceMode, { width: number; height: number; label: string }> = {
  responsive: { width: 0, height: 0, label: 'Adaptatif' },
  mobile: { width: 390, height: 844, label: 'Mobile' },
  tablet: { width: 834, height: 1112, label: 'Tablette' },
  laptop: { width: 1280, height: 800, label: 'Portable' },
  desktop: { width: 1600, height: 900, label: 'Bureau' },
}

function describeTarget(target: PreviewTarget): string {
  const where = target.relativeRoot === '.' ? 'racine' : target.relativeRoot
  const how = target.servedBy === 'command' ? target.command : 'serveur statique'
  return `${target.framework} · ${where} · ${how}`
}

/**
 * Dockable preview panel.
 *
 * An `<iframe>` is used rather than `<webview>`: the webview tag is deprecated
 * and would require `webviewTag: true`, weakening the renderer's isolation. The
 * cost is that the frame's own history is not readable cross-origin, so
 * navigation history is tracked in the parent instead.
 */
export function Preview({
  workspace, status, log, tabs, activeTab, capturing, error, busy, reloadToken,
  onStart, onStop, onReload, onNavigate, onBack, onForward, onZoom,
  onSelectTab, onCloseTab, onOpenTab, onCapture, onOpenExternally,
}: Props) {
  const [address, setAddress] = useState('')
  const [candidates, setCandidates] = useState<PreviewTarget[]>([])
  const [showLog, setShowLog] = useState(false)
  const [device, setDevice] = useState<DeviceMode>('responsive')
  const [landscape, setLandscape] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    setAddress(activeTab?.url ?? '')
  }, [activeTab?.url])

  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log, showLog])

  // Show what could be previewed before anything is started.
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge || !workspace) {
      setCandidates([])
      return
    }
    let cancelled = false
    void bridge.preview.candidates(workspace)
      .then(found => { if (!cancelled) setCandidates(found) })
      .catch(() => { if (!cancelled) setCandidates([]) })
    return () => { cancelled = true }
  }, [workspace, status.state])

  const canGoBack = (activeTab?.historyIndex ?? 0) > 0
  const canGoForward = activeTab ? activeTab.historyIndex < activeTab.history.length - 1 : false
  const zoom = activeTab?.zoom ?? 1

  // Reloading is done by reassigning src: contentWindow.location is blocked
  // cross-origin.
  const frameSrc = useMemo(
    () => (activeTab ? `${activeTab.url}${activeTab.url.includes('?') ? '&' : '?'}__r=${reloadToken}` : ''),
    [activeTab?.url, reloadToken, activeTab],
  )

  const submitAddress = useCallback(() => {
    const value = address.trim()
    if (value.length === 0) return
    try {
      const parsed = new URL(value)
      const host = parsed.hostname.toLowerCase()
      // Only loopback is reachable: the CSP frame-src forbids anything else.
      if (host !== '127.0.0.1' && host !== 'localhost') return
      onNavigate(parsed.toString())
    } catch {
      // Not a full URL: treat it as a path on the current origin.
      if (!activeTab) return
      const base = new URL(activeTab.url)
      onNavigate(new URL(value, base.origin).toString())
    }
  }, [address, activeTab, onNavigate])

  const preset = DEVICES[device]
  const frameSize = device === 'responsive'
    ? undefined
    : {
      width: landscape ? preset.height : preset.width,
      height: landscape ? preset.width : preset.height,
    }

  return (
    <div className="preview">
      <div className="preview__toolbar">
        <Tooltip content={status.state === 'running' ? 'Arrêter l’aperçu' : 'Démarrer l’aperçu'} side="top">
          <button
            type="button"
            className={cx('preview__btn', status.state === 'running' && 'is-stop')}
            onClick={() => (status.state === 'running' ? onStop() : onStart())}
            disabled={!workspace || busy}
            aria-label={status.state === 'running' ? 'Arrêter l’aperçu' : 'Démarrer l’aperçu'}
          >
            {busy ? <Spinner size={13} /> : status.state === 'running' ? <Square size={12} /> : <Play size={13} />}
          </button>
        </Tooltip>

        <span className="preview__nav">
          <IconButton label="Précédent" size="sm" icon={<ArrowLeft size={13} />} onClick={onBack} disabled={!canGoBack} />
          <IconButton label="Suivant" size="sm" icon={<ArrowRight size={13} />} onClick={onForward} disabled={!canGoForward} />
          <IconButton label="Actualiser" size="sm" icon={<RotateCw size={13} />} onClick={onReload} disabled={!activeTab} />
        </span>

        <div className="preview__address">
          <StatusDot tone={STATE_TONE[status.state]} pulse={status.state === 'running'} size={6} />
          <input
            value={address}
            onChange={event => setAddress(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submitAddress() }}
            placeholder="URL locale de l’aperçu"
            disabled={!activeTab}
            aria-label="Adresse de l’aperçu"
            spellCheck={false}
          />
          <Badge tone={STATE_TONE[status.state]} size="sm">{STATE_LABEL[status.state]}</Badge>
        </div>

        <span className="preview__zoom">
          <IconButton label="Réduire le zoom" size="sm" icon={<ZoomOut size={13} />} onClick={() => onZoom(zoom - 0.1)} disabled={!activeTab} />
          <button
            type="button"
            className="preview__zoom-value"
            onClick={() => onZoom(1)}
            title="Réinitialiser le zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton label="Augmenter le zoom" size="sm" icon={<ZoomIn size={13} />} onClick={() => onZoom(zoom + 0.1)} disabled={!activeTab} />
        </span>

        <span className="preview__tools">
          <Tooltip content="Capture d’écran" side="top">
            <IconButton
              label="Capture d’écran"
              size="sm"
              icon={capturing ? <Spinner size={13} /> : <Camera size={13} />}
              onClick={onCapture}
              disabled={!activeTab || capturing}
            />
          </Tooltip>
          <Tooltip content="Ouvrir dans le navigateur" side="top">
            <IconButton
              label="Ouvrir dans le navigateur"
              size="sm"
              icon={<ExternalLink size={13} />}
              onClick={onOpenExternally}
              disabled={!activeTab}
            />
          </Tooltip>
          <Tooltip content="Journal du serveur" side="top">
            <IconButton
              label="Journal du serveur"
              size="sm"
              active={showLog}
              icon={<ScrollText size={13} />}
              onClick={() => setShowLog(current => !current)}
            />
          </Tooltip>
        </span>
      </div>

      <div className="preview__devicebar">
        <Segmented
          size="sm"
          ariaLabel="Mode d’affichage"
          value={device}
          onChange={setDevice}
          options={[
            { value: 'responsive', label: 'Adaptatif', icon: <Monitor size={12} /> },
            { value: 'mobile', label: 'Mobile', icon: <Smartphone size={12} /> },
            { value: 'tablet', label: 'Tablette', icon: <Tablet size={12} /> },
            { value: 'laptop', label: 'Portable', icon: <Laptop size={12} /> },
            { value: 'desktop', label: 'Bureau', icon: <Monitor size={12} /> },
          ]}
        />
        {device !== 'responsive' && (
          <>
            <button
              type="button"
              className={cx('preview__rotate', landscape && 'is-active')}
              onClick={() => setLandscape(current => !current)}
            >
              {landscape ? 'Paysage' : 'Portrait'}
            </button>
            <span className="preview__dims">
              {frameSize?.width} × {frameSize?.height}
            </span>
          </>
        )}
        <span className="preview__devicebar-fill" />
        {status.target && (
          <span className="preview__target" title={describeTarget(status.target)}>
            {status.target.framework}
          </span>
        )}
      </div>

      {tabs.length > 0 && (
        <div className="preview__tabs" role="tablist" aria-label="Onglets d’aperçu">
          <AnimatePresence initial={false}>
            {tabs.map(tab => (
              <motion.div
                key={tab.id}
                role="tab"
                aria-selected={tab.id === activeTab?.id}
                className={cx('preview__tab', tab.id === activeTab?.id && 'is-active')}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={transitions.fast}
                onClick={() => onSelectTab(tab.id)}
                title={tab.url}
              >
                <span className="preview__tab-label">{tab.title}</span>
                <button
                  type="button"
                  className="preview__tab-close"
                  aria-label={`Fermer ${tab.title}`}
                  onClick={event => { event.stopPropagation(); onCloseTab(tab.id) }}
                >
                  <X size={10} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
          {status.url && (
            <IconButton
              label="Nouvel onglet"
              size="xs"
              icon={<Plus size={11} />}
              onClick={() => onOpenTab(status.url as string)}
            />
          )}
        </div>
      )}

      <AnimatePresence>
        {error.length > 0 && (
          <motion.div className="preview__error" variants={fade} initial="hidden" animate="visible" exit="exit">
            <TriangleAlert size={12} />
            <span>{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={cx('preview__body', device !== 'responsive' && 'is-framed')}>
        {activeTab ? (
          <motion.div
            className="preview__viewport"
            initial={false}
            animate={frameSize
              ? { width: frameSize.width, height: frameSize.height }
              : { width: '100%', height: '100%' }}
            transition={transitions.normal}
          >
            <iframe
              className="preview__frame"
              src={frameSrc}
              title={`Aperçu ${activeTab.title}`}
              style={{
                width: `${100 / zoom}%`,
                height: `${100 / zoom}%`,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
              // The previewed project is untrusted code: keep it out of the app's
              // origin while still allowing it to run its own scripts.
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
            />
          </motion.div>
        ) : (
          <div className="preview__empty">
            <EmptyState
              icon={<Monitor size={24} />}
              title="Aucun aperçu"
              description={
                !workspace ? 'Ouvre un dossier pour prévisualiser un projet.'
                  : candidates.length === 0
                    ? 'Aucun projet web détecté (index.html ou package.json avec un script de développement).'
                    : 'Choisis un projet à servir.'
              }
            />
            {workspace && candidates.length > 0 && (
              <div className="preview__candidates">
                {candidates.slice(0, 6).map(candidate => (
                  <button
                    key={candidate.root}
                    type="button"
                    onClick={() => onStart(candidate.relativeRoot)}
                    disabled={busy}
                  >
                    <Play size={11} />
                    {describeTarget(candidate)}
                  </button>
                ))}
              </div>
            )}
            {status.state === 'error' && status.message.length > 0 && (
              <p className="preview__empty-error">{status.message}</p>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {showLog && (
          <motion.pre
            className="preview__log"
            ref={logRef}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 148, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={transitions.normal}
          >
            {log.length === 0 ? 'Aucune sortie du serveur de développement.' : log.join('\n')}
          </motion.pre>
        )}
      </AnimatePresence>
    </div>
  )
}
