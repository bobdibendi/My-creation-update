import { useCallback, useState } from 'react'
import type { FileNode } from '../shared/types'

export function useFileSystem() {
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [files, setFiles] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dirContents, setDirContents] = useState<Record<string, FileNode[]>>({})

  const listDir = useCallback(async (dir: string): Promise<FileNode[]> => {
    const bridge = window.electronAPI
    if (!bridge) return []
    try {
      const children = await bridge.files.list(dir)
      setDirContents(previous => ({ ...previous, [dir]: children }))
      return children
    } catch {
      return []
    }
  }, [])

  const loadFolder = useCallback(async (dir: string) => {
    const bridge = window.electronAPI
    if (!bridge) {
      setFolderPath(dir)
      return
    }
    try {
      const listed = await bridge.files.list(dir)
      setFiles(listed)
      setFolderPath(dir)
      setDirContents({ [dir]: listed })
      setExpanded(new Set())
    } catch (error) {
      console.error(`[fs] dossier illisible: ${(error as Error).message}`)
    }
  }, [])

  /** Re-reads the root and every expanded directory, keeping the tree open. */
  const refreshTree = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !folderPath) return
    try {
      const listed = await bridge.files.list(folderPath)
      setFiles(listed)
      const next: Record<string, FileNode[]> = { [folderPath]: listed }
      for (const dir of expanded) {
        try { next[dir] = await bridge.files.list(dir) } catch { /* directory disappeared */ }
      }
      setDirContents(next)
      setExpanded(previous => new Set([...previous].filter(dir => next[dir] !== undefined)))
    } catch (error) {
      console.error(`[fs] rafraîchissement impossible: ${(error as Error).message}`)
    }
  }, [folderPath, expanded])

  const openFolder = useCallback(async (): Promise<string | null> => {
    const dir = await window.electronAPI?.files.openFolder()
    if (dir) await loadFolder(dir)
    return dir ?? null
  }, [loadFolder])

  const toggleDir = useCallback((target: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }, [])

  const parentOf = (target: string): string => {
    const separator = target.includes('\\') ? '\\' : '/'
    const parts = target.split(/[\\/]/)
    parts.pop()
    return parts.join(separator)
  }

  const refreshParent = useCallback(async (target: string) => {
    const parent = parentOf(target)
    if (parent.length > 0) await listDir(parent)
    if (folderPath && parent === folderPath) {
      const listed = await listDir(folderPath)
      setFiles(listed)
    }
  }, [folderPath, listDir])

  const createEntry = useCallback(async (parentPath: string, name: string, isDir: boolean) => {
    await window.electronAPI?.files.create(parentPath, name, isDir)
    const listed = await listDir(parentPath)
    if (parentPath === folderPath) setFiles(listed)
  }, [folderPath, listDir])

  const deleteEntry = useCallback(async (target: string) => {
    await window.electronAPI?.files.delete(target)
    await refreshParent(target)
  }, [refreshParent])

  const renameEntry = useCallback(async (target: string, newName: string) => {
    await window.electronAPI?.files.rename(target, newName)
    await refreshParent(target)
  }, [refreshParent])

  return {
    folderPath,
    files,
    expanded,
    dirContents,
    loadFolder,
    refreshTree,
    openFolder,
    /** Ouvre un dossier connu par chemin (projets récents). */
    openFolderPath: loadFolder,
    toggleDir,
    listDir,
    createEntry,
    deleteEntry,
    renameEntry,
  }
}
