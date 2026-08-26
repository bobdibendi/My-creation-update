import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Loader2, Package as PackageIcon, Play, Square, TriangleAlert } from 'lucide-react'
import { Sidebar } from '../layout/Sidebar'
import { EmptyState, Tooltip } from './ui'
import { cx } from './ui/cx'
import type { PackageCompletePayload } from '../shared/types'

interface Props {
  workspace: string | null
  sessionToken: string | null
}

const STAGES: Array<{ id: string; label: string }> = [
  { id: 'preparing', label: 'Preparing…' },
  { id: 'building', label: 'Building…' },
  { id: 'packaging', label: 'Packaging…' },
  { id: 'creating-installer', label: 'Creating installer…' },
]

function stageIndex(stage: string): number {
  return STAGES.findIndex(entry => entry.id === stage)
}

/** Reads the project version from the workspace manifest (informational). */
async function readVersion(workspace: string): Promise<string | null> {
  try {
    const raw = await window.electronAPI?.files.read(`${workspace}\\package.json`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? null
  } catch {
    return null
  }
}

/**
 * PACKAGE — génère un vrai installeur via le système d'empaquetage du projet
 * ouvert (npm run build + electron-builder ou script dist équivalent).
 * Aucune simulation : les logs viennent des processus réels.
 */
export function PackagePanel({ workspace, sessionToken }: Props) {
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PackageCompletePayload | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setResult(null)
    setError(null)
    setLines([])
    if (!workspace) {
      setVersion(null)
      return
    }
    void readVersion(workspace).then(value => setVersion(value))
  }, [workspace])

  const platformLabel = navigator.userAgent.includes('Win')
    ? 'Windows'
    : navigator.userAgent.includes('Mac') ? 'macOS' : 'Linux'

  const start = useCallback(async (): Promise<void> => {
    const bridge = window.electronAPI
    if (!bridge || !workspace || !sessionToken || running) return
    setRunning(true)
    setStage('preparing')
    setLines([])
    setError(null)
    setResult(null)
    try {
      await bridge.package.start(sessionToken, workspace)
    } catch (failure) {
      setError((failure as Error).message)
      setRunning(false)
      setStage('')
    }
  }, [workspace, sessionToken, running])

  const cancel = useCallback(async (): Promise<void> => {
    await window.electronAPI?.package.cancel().catch(() => undefined)
  }, [])

  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge) return

    const disposeProgress = bridge.package.onProgress(payload => {
      setStage(payload.stage)
      setLines(previous => [...previous, payload.line].slice(-400))
    })
    const disposeComplete = bridge.package.onComplete(payload => {
      setResult(payload)
      setStage('done')
      setRunning(false)
    })
    const disposeError = bridge.package.onError(payload => {
      setError(payload.message)
      setRunning(false)
    })

    return () => {
      disposeProgress()
      disposeComplete()
      disposeError()
    }
  }, [])

  // Keep the latest log line visible.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [lines])

  const activeIndex = stageIndex(stage)

  return (
    <Sidebar title="PACKAGE">
      {!workspace ? (
        <EmptyState
          icon={<PackageIcon size={22} />}
          title="Aucun projet"
          description="Ouvre le dossier du projet à empaqueter, puis reviens ici pour générer l’installeur."
        />
      ) : (
        <div className="pkg">
          <div className="pkg__meta">
            <div className="pkg__field">
              <span className="pkg__label">Projet</span>
              <span className="pkg__value" title={workspace}>{workspace.split(/[\\/]/).pop()}</span>
            </div>
            <div className="pkg__field">
              <span className="pkg__label">Version</span>
              <span className="pkg__value">{version ?? '—'}</span>
            </div>
            <div className="pkg__field">
              <span className="pkg__label">Plateforme</span>
              <span className="pkg__value">{platformLabel}</span>
            </div>
          </div>

          {!result && (
            running ? (
              <button type="button" className="sidebar__cta pkg__stop" onClick={() => void cancel()}>
                <Square size={13} /> Arrêter
              </button>
            ) : (
              <button type="button" className="sidebar__cta" onClick={() => void start()} disabled={!sessionToken}>
                <Play size={13} /> Générer l’installeur
              </button>
            )
          )}

          {(running || result) && (
            <ol className="pkg__stages" aria-label="Progression">
              {STAGES.map((entry, index) => (
                <li
                  key={entry.id}
                  className={cx(
                    'pkg__stage',
                    index < activeIndex && 'is-done',
                    index === activeIndex && !result && 'is-active',
                    Boolean(result) && 'is-done',
                  )}
                >
                  {index < activeIndex || result
                    ? <CheckCircle2 size={13} aria-hidden />
                    : index === activeIndex
                      ? <Loader2 size={13} className="spin" aria-hidden />
                      : <span className="pkg__stage-dot" aria-hidden />}
                  {entry.label}
                </li>
              ))}
            </ol>
          )}

          {lines.length > 0 && (
            <div className="pkg__log" ref={logRef} aria-label="Sortie de construction">
              {lines.map((line, index) => (
                <code key={`${index}-${line.slice(0, 12)}`} className="pkg__line">{line}</code>
              ))}
            </div>
          )}

          {error && (
            <div className="pkg__error" role="alert">
              <TriangleAlert size={14} aria-hidden />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div className="pkg__done">
              <div className="pkg__done-head">
                <CheckCircle2 size={15} aria-hidden />
                <strong>Installeur généré</strong>
              </div>
              <span className="pkg__done-name" title={result.installerPath}>
                {result.productName}
                {result.version ? ` ${result.version}` : ''} — {result.installerPath.split(/[\\/]/).pop()}
              </span>
              <div className="pkg__done-actions">
                <Tooltip content="Lancer l’installeur" side="top">
                  <button
                    type="button"
                    className="sidebar__cta"
                    onClick={() => { void window.electronAPI?.package.open(result.installerPath).catch(failure => setError((failure as Error).message)) }}
                  >
                    <Play size={13} /> Ouvrir
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className="pkg__secondary"
                  onClick={() => { window.electronAPI?.package.showInFolder(result.installerPath) }}
                >
                  <FolderOpen size={13} /> Ouvrir le dossier
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Sidebar>
  )
}
