import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronRight, Copy, FilePlus, FolderPlus, Loader2, PenLine, RefreshCw, Trash2, X,
} from 'lucide-react'
import type { FileNode, Tab } from '../shared/types'
import { FileIcon } from './FileIcon'
import { Sidebar, SidebarGroup } from '../layout'
import {
  ContextMenu, EmptyState, IconButton, Input, Skeleton, Tooltip, copyText, type MenuEntry,
} from './ui'
import { collapse, listItem } from '../animations'
import { cx } from './ui/cx'

interface Props {
  folderPath: string | null
  rootName: string
  files: FileNode[]
  expanded: Set<string>
  tabs: Tab[]
  activePath: string
  dirContents: Record<string, FileNode[]>
  onToggleDir: (path: string) => void
  onOpenFile: (node: FileNode) => void
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  onOpenFolder: () => void
  onRefresh: () => void
  onListDir: (dir: string) => Promise<FileNode[]>
  onCreateEntry: (parentPath: string, name: string, isDir: boolean) => Promise<void>
  onDeleteEntry: (targetPath: string) => Promise<void>
  onRenameEntry: (oldPath: string, newName: string) => Promise<void>
}

interface MenuState {
  x: number
  y: number
  path: string
  name: string
  kind: 'file' | 'directory'
}

const INDENT = 14
const BASE_PAD = 10

function parentOf(target: string): string {
  const separator = target.includes('\\') ? '\\' : '/'
  const parts = target.split(/[\\/]/)
  parts.pop()
  return parts.join(separator)
}

/** Directories first, then files, both alphabetical and case-insensitive. */
function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })
  })
}

export function Explorer({
  folderPath, rootName, files, expanded, tabs, activePath, dirContents,
  onToggleDir, onOpenFile, onSelectTab, onCloseTab, onOpenFolder, onRefresh,
  onListDir, onCreateEntry, onDeleteEntry, onRenameEntry,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'directory' } | null>(null)
  const [createValue, setCreateValue] = useState('')
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  const toggle = useCallback(async (target: string) => {
    const willExpand = !expanded.has(target)
    if (willExpand && !dirContents[target] && !loadingDirs.has(target)) {
      setLoadingDirs(previous => new Set(previous).add(target))
      await onListDir(target)
      setLoadingDirs(previous => {
        const next = new Set(previous)
        next.delete(target)
        return next
      })
    }
    onToggleDir(target)
  }, [expanded, dirContents, loadingDirs, onListDir, onToggleDir])

  const submitCreate = useCallback(async () => {
    if (!creating) return
    const name = createValue.trim()
    setCreating(null)
    setCreateValue('')
    if (name.length === 0) return
    try {
      await onCreateEntry(creating.parent, name, creating.kind === 'directory')
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [creating, createValue, onCreateEntry])

  const submitRename = useCallback(async (target: string) => {
    const name = renameValue.trim()
    setRenaming(null)
    if (name.length === 0) return
    try {
      await onRenameEntry(target, name)
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [renameValue, onRenameEntry])

  const remove = useCallback(async (target: string) => {
    try {
      await onDeleteEntry(target)
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [onDeleteEntry])

  const needle = filter.trim().toLowerCase()

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu) return []
    const parent = menu.kind === 'directory' ? menu.path : parentOf(menu.path)
    return [
      {
        id: 'new-file',
        label: 'Nouveau fichier',
        icon: <FilePlus size={13} />,
        onSelect: () => setCreating({ parent, kind: 'file' }),
      },
      {
        id: 'new-dir',
        label: 'Nouveau dossier',
        icon: <FolderPlus size={13} />,
        onSelect: () => setCreating({ parent, kind: 'directory' }),
      },
      { id: 'sep-1', separator: true },
      {
        id: 'rename',
        label: 'Renommer',
        icon: <PenLine size={13} />,
        onSelect: () => {
          setRenameValue(menu.name)
          setRenaming(menu.path)
        },
      },
      {
        id: 'copy-path',
        label: 'Copier le chemin',
        icon: <Copy size={13} />,
        onSelect: () => { void copyText(menu.path) },
      },
      { id: 'sep-2', separator: true },
      {
        id: 'delete',
        label: 'Supprimer',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => { void remove(menu.path) },
      },
    ]
  }, [menu, remove])

  const renderCreateRow = (depth: number) => (
    <div className="tree-row is-editing" style={{ paddingLeft: BASE_PAD + depth * INDENT }}>
      <span className="tree-row__twist" aria-hidden />
      {creating?.kind === 'directory'
        ? <FolderPlus size={13} className="tree-row__icon is-folder" />
        : <FilePlus size={13} className="tree-row__icon" />}
      <input
        className="tree-row__input"
        value={createValue}
        autoFocus
        placeholder={creating?.kind === 'directory' ? 'dossier' : 'fichier.ext'}
        aria-label="Nom du nouvel élément"
        onChange={event => setCreateValue(event.target.value)}
        onBlur={() => void submitCreate()}
        onKeyDown={event => {
          if (event.key === 'Enter') void submitCreate()
          if (event.key === 'Escape') { setCreating(null); setCreateValue('') }
        }}
      />
    </div>
  )

  const renderRename = (node: FileNode) => (
    <input
      className="tree-row__input"
      value={renameValue}
      autoFocus
      aria-label={`Renommer ${node.name}`}
      onChange={event => setRenameValue(event.target.value)}
      onBlur={() => void submitRename(node.path)}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Enter') void submitRename(node.path)
        if (event.key === 'Escape') setRenaming(null)
      }}
    />
  )

  const openMenuAt = (event: React.MouseEvent, node: FileNode) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, path: node.path, name: node.name, kind: node.kind })
  }

  const renderFile = (node: FileNode, depth: number) => {
    if (needle.length > 0 && !node.name.toLowerCase().includes(needle)) return null
    return (
      <motion.div
        key={node.path}
        className={cx('tree-row', activePath === node.path && 'is-active')}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        variants={listItem}
        initial="hidden"
        animate="visible"
        onClick={() => onOpenFile(node)}
        onContextMenu={event => openMenuAt(event, node)}
      >
        <span className="tree-row__twist" aria-hidden />
        <FileIcon name={node.name} size={13} />
        {renaming === node.path
          ? renderRename(node)
          : <span className="tree-row__label">{node.name}</span>}
      </motion.div>
    )
  }

  const renderDir = (node: FileNode, depth: number) => {
    const isExpanded = expanded.has(node.path)
    const children = dirContents[node.path]
    const isLoading = loadingDirs.has(node.path)
    const nameMatches = needle.length === 0 || node.name.toLowerCase().includes(needle)

    return (
      <div key={node.path} className="tree-branch">
        {nameMatches && (
          <div
            className="tree-row"
            style={{ paddingLeft: BASE_PAD + depth * INDENT }}
            onClick={event => { event.stopPropagation(); void toggle(node.path) }}
            onContextMenu={event => openMenuAt(event, node)}
          >
            <motion.span
              className="tree-row__twist"
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.14 }}
              aria-hidden
            >
              {isLoading ? <Loader2 size={11} className="is-spinning" /> : <ChevronRight size={11} />}
            </motion.span>
            <FileIcon name={node.name} size={13} directory open={isExpanded} />
            {renaming === node.path
              ? renderRename(node)
              : <span className="tree-row__label is-dir">{node.name}</span>}
          </div>
        )}

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div variants={collapse} initial="hidden" animate="visible" exit="exit">
              {creating?.parent === node.path && renderCreateRow(depth + 1)}
              {!children && isLoading && (
                <div className="tree-loading" style={{ paddingLeft: BASE_PAD + (depth + 1) * INDENT }}>
                  <Skeleton width="60%" height={10} />
                  <Skeleton width="45%" height={10} />
                </div>
              )}
              {children && sortNodes(children).map(child => (
                child.kind === 'directory'
                  ? renderDir(child, depth + 1)
                  : renderFile(child, depth + 1)
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <Sidebar
      title="Explorateur"
      actions={
        <>
          <Tooltip content="Nouveau fichier" side="bottom">
            <IconButton
              label="Nouveau fichier"
              size="sm"
              icon={<FilePlus size={13} />}
              disabled={!folderPath}
              onClick={() => { if (folderPath) setCreating({ parent: folderPath, kind: 'file' }) }}
            />
          </Tooltip>
          <Tooltip content="Nouveau dossier" side="bottom">
            <IconButton
              label="Nouveau dossier"
              size="sm"
              icon={<FolderPlus size={13} />}
              disabled={!folderPath}
              onClick={() => { if (folderPath) setCreating({ parent: folderPath, kind: 'directory' }) }}
            />
          </Tooltip>
          <Tooltip content="Rafraîchir" side="bottom">
            <IconButton
              label="Rafraîchir l’arborescence"
              size="sm"
              icon={<RefreshCw size={13} />}
              disabled={!folderPath}
              onClick={onRefresh}
            />
          </Tooltip>
        </>
      }
      toolbar={folderPath ? (
        <Input
          size="sm"
          value={filter}
          placeholder="Filtrer les fichiers"
          onChange={event => setFilter(event.target.value)}
          aria-label="Filtrer les fichiers"
        />
      ) : undefined}
    >
      {error && <div className="sidebar__error">{error}</div>}

      {tabs.length > 0 && (
        <SidebarGroup label="Éditeurs ouverts" aside={<span>{tabs.length}</span>}>
          {tabs.map(tab => (
            <div
              key={tab.path}
              className={cx('tree-row', tab.path === activePath && 'is-active')}
              style={{ paddingLeft: BASE_PAD }}
              onClick={() => onSelectTab(tab.path)}
            >
              <span className="tree-row__twist" aria-hidden />
              <FileIcon name={tab.name} size={13} />
              <span className="tree-row__label">{tab.name}</span>
              {tab.dirty && <span className="tree-row__dirty" aria-label="non enregistré" />}
              <button
                type="button"
                className="tree-row__close"
                aria-label={`Fermer ${tab.name}`}
                onClick={event => { event.stopPropagation(); onCloseTab(tab.path) }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </SidebarGroup>
      )}

      {folderPath ? (
        <SidebarGroup label={rootName}>
          {creating?.parent === folderPath && renderCreateRow(0)}
          {sortNodes(files).map(node => (
            node.kind === 'directory' ? renderDir(node, 0) : renderFile(node, 0)
          ))}
          {files.length === 0 && <div className="tree-empty">Dossier vide</div>}
        </SidebarGroup>
      ) : (
        <EmptyState
          icon={<FolderPlus size={22} />}
          title="Aucun dossier ouvert"
          description="Ouvre un projet pour explorer ses fichiers."
          action={
            <button type="button" className="sidebar__cta" onClick={onOpenFolder}>
              Ouvrir un dossier
            </button>
          }
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.name}
          entries={menuEntries}
          onClose={() => setMenu(null)}
        />
      )}
    </Sidebar>
  )
}
