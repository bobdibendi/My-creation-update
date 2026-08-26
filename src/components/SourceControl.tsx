import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check, FolderGit2, GitBranch, GitCommit, RefreshCw, TriangleAlert,
} from 'lucide-react'
import type { GitRepositoryInfo } from '../shared/types'
import { Sidebar, SidebarGroup } from '../layout'
import { Badge, EmptyState, IconButton, Spinner, Textarea, Tooltip } from './ui'
import { listItem, staggerContainer } from '../animations'
import { cx } from './ui/cx'

interface Props {
  cwd: string | null
  /** Changes whenever the app-level git status is refreshed. */
  statusSignal: string
  onChanged: () => void
}

interface Change {
  state: string
  file: string
}

/** Maps a porcelain code to a tone and a readable label. */
function describeState(code: string): { tone: 'success' | 'warning' | 'danger' | 'info'; label: string } {
  if (code.includes('?')) return { tone: 'info', label: 'nouveau' }
  if (code.includes('D')) return { tone: 'danger', label: 'supprimé' }
  if (code.includes('A')) return { tone: 'success', label: 'ajouté' }
  if (code.includes('R')) return { tone: 'warning', label: 'renommé' }
  if (code.includes('U')) return { tone: 'danger', label: 'conflit' }
  return { tone: 'warning', label: 'modifié' }
}

function parseChanges(status: string): Change[] {
  return status
    .split(/\r?\n/)
    .filter(line => line.length > 0 && !line.startsWith('##'))
    .map(line => ({ state: line.slice(0, 2).trim() || '·', file: line.slice(3).trim() }))
}

export function SourceControl({ cwd, statusSignal, onChanged }: Props) {
  const [status, setStatus] = useState('')
  const [repository, setRepository] = useState<GitRepositoryInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [messageError, setMessageError] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !cwd) {
      setStatus('')
      setRepository(null)
      return
    }
    setLoading(true)
    try {
      const info = await bridge.git.root(cwd)
      if (!mounted.current) return
      setRepository(info)
      setStatus(info ? await bridge.git.status(cwd) : '')
    } catch {
      if (mounted.current) setStatus('')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    void load()
  }, [load, statusSignal])

  const refresh = useCallback(async () => {
    await load()
    onChanged()
  }, [load, onChanged])

  const commit = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !cwd || commitMessage.trim().length === 0) return
    setCommitting(true)
    setMessage('')
    setMessageError(false)
    try {
      // Stage only the opened folder: the repository root may be an ancestor.
      await bridge.git.run(cwd, ['add', '--', '.'])
      const output = await bridge.git.run(cwd, ['commit', '-m', commitMessage.trim()])
      setMessage(output.split('\n').filter(Boolean)[0] ?? 'Commit créé')
      setCommitMessage('')
    } catch (error) {
      setMessage((error as Error).message)
      setMessageError(true)
    }
    setCommitting(false)
    await refresh()
  }, [cwd, commitMessage, refresh])

  const changes = useMemo(() => parseChanges(status), [status])
  const branch = useMemo(
    () => status.split(/\r?\n/).find(line => line.startsWith('##'))?.replace(/^##\s*/, '') ?? 'aucune branche',
    [status],
  )

  const refreshAction = (
    <Tooltip content="Rafraîchir" side="bottom">
      <IconButton
        label="Rafraîchir l’état Git"
        size="sm"
        icon={loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        onClick={() => void refresh()}
      />
    </Tooltip>
  )

  if (!cwd) {
    return (
      <Sidebar title="Contrôle de source">
        <EmptyState
          icon={<GitBranch size={22} />}
          title="Aucun dossier ouvert"
          description="Ouvre un dossier suivi par Git."
        />
      </Sidebar>
    )
  }

  if (!loading && !repository) {
    return (
      <Sidebar title="Contrôle de source" actions={refreshAction}>
        <EmptyState
          icon={<FolderGit2 size={22} />}
          title="Aucun dépôt Git"
          description="Ce dossier n’est pas suivi par Git."
        />
      </Sidebar>
    )
  }

  const folderName = cwd.split(/[\\/]/).pop() ?? cwd

  return (
    <Sidebar
      title="Contrôle de source"
      actions={refreshAction}
      toolbar={
        <div className="scm__branch">
          <GitBranch size={13} />
          <span title={branch}>{branch}</span>
        </div>
      }
      footer={
        <div className="scm__commit">
          <Textarea
            value={commitMessage}
            rows={2}
            placeholder="Message de commit (Ctrl+Entrée)"
            aria-label="Message de commit"
            onChange={event => setCommitMessage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void commit()
            }}
          />
          <button
            type="button"
            className="scm__commit-btn"
            onClick={() => void commit()}
            disabled={commitMessage.trim().length === 0 || committing}
          >
            {committing ? <Spinner size={12} /> : <GitCommit size={13} />}
            Valider {changes.length > 0 ? `(${changes.length})` : ''}
          </button>
          <AnimatePresence>
            {message && (
              <motion.small
                className={cx('scm__message', messageError && 'is-error')}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                {messageError && <TriangleAlert size={11} />}
                {message}
              </motion.small>
            )}
          </AnimatePresence>
        </div>
      }
    >
      {repository && !repository.isRoot && (
        <div className="scm__scope">
          Dépôt : {repository.root.split(/[\\/]/).pop()} · portée limitée à {folderName}
        </div>
      )}

      {changes.length === 0 ? (
        <EmptyState
          icon={<Check size={22} />}
          title="Aucune modification"
          description="L’arbre de travail est propre."
          compact
        />
      ) : (
        <SidebarGroup label="Modifications" aside={<Badge size="sm">{changes.length}</Badge>}>
          <motion.div variants={staggerContainer(0.025)} initial="hidden" animate="visible">
            {changes.map((change, index) => {
              const info = describeState(change.state)
              return (
                <motion.div
                  className="scm__change"
                  key={`${change.file}-${index}`}
                  title={`${info.label} · ${change.file}`}
                  variants={listItem}
                >
                  <span className={cx('scm__state', `is-${info.tone}`)}>{change.state}</span>
                  <span className="scm__file">{change.file.split(/[\\/]/).pop()}</span>
                  <span className="scm__dir">{change.file}</span>
                </motion.div>
              )
            })}
          </motion.div>
        </SidebarGroup>
      )}
    </Sidebar>
  )
}
