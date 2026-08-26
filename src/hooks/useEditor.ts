import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode, Tab } from '../shared/types'

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'c',
  h: 'cpp',
  hpp: 'cpp',
  php: 'php',
  rb: 'ruby',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  bat: 'bat',
  cmd: 'bat',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  toml: 'ini',
  ini: 'ini',
  txt: 'plaintext',
  log: 'plaintext',
}

const RECENT_LIMIT = 12

export function languageFor(name: string): string {
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  if (lower === 'makefile') return 'makefile'
  const ext = lower.includes('.') ? lower.split('.').pop() ?? '' : ''
  return LANGUAGE_MAP[ext] ?? 'plaintext'
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function useEditor() {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState('')
  /** Most recently opened files, newest first. Feeds the home screen. */
  const [recent, setRecent] = useState<string[]>([])
  /** Last content written to (or read from) disk, used to compute the dirty flag. */
  const savedContent = useRef<Map<string, string>>(new Map())
  /** Dernier état d'enregistrement : affiché discrètement dans la barre d'état. */
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const autosaveTimer = useRef<number | null>(null)

  const rememberRecent = useCallback((path: string) => {
    if (path.startsWith('untitled:')) return
    setRecent(previous => [path, ...previous.filter(entry => entry !== path)].slice(0, RECENT_LIMIT))
  }, [])

  const openFile = useCallback(async (node: FileNode) => {
    if (node.kind === 'directory') return

    let existing = false
    setTabs(previous => {
      existing = previous.some(tab => tab.path === node.path)
      return previous
    })
    if (existing) {
      setActivePath(node.path)
      rememberRecent(node.path)
      return
    }

    const bridge = window.electronAPI
    let content = ''
    if (bridge) {
      try {
        content = await bridge.files.read(node.path)
      } catch (error) {
        console.error(`[editor] lecture impossible: ${(error as Error).message}`)
        return
      }
    }

    savedContent.current.set(node.path, content)
    setTabs(previous => previous.some(tab => tab.path === node.path)
      ? previous
      : [...previous, {
        path: node.path,
        name: node.name,
        language: languageFor(node.name),
        content,
        dirty: false,
        untitled: false,
      }])
    setActivePath(node.path)
    rememberRecent(node.path)
  }, [rememberRecent])

  /** Opens by absolute path, deriving the display name from it. */
  const openPath = useCallback(async (path: string) => {
    await openFile({ path, name: path.split(/[\\/]/).pop() ?? path, kind: 'file' })
  }, [openFile])


  const closeTab = useCallback((target: string) => {
    setTabs(previous => {
      const remaining = previous.filter(tab => tab.path !== target)
      setActivePath(current => {
        if (current !== target) return current
        const index = previous.findIndex(tab => tab.path === target)
        const next = remaining[Math.min(index, remaining.length - 1)]
        return next?.path ?? ''
      })
      return remaining
    })
    savedContent.current.delete(target)
  }, [])

  const selectTab = useCallback((target: string) => {
    setTabs(previous => {
      if (previous.some(tab => tab.path === target)) setActivePath(target)
      return previous
    })
  }, [])

  /** Closes every tab but `keep`. */
  const closeOthers = useCallback((keep: string) => {
    setTabs(previous => {
      for (const tab of previous) {
        if (tab.path !== keep) savedContent.current.delete(tab.path)
      }
      return previous.filter(tab => tab.path === keep)
    })
    setActivePath(keep)
  }, [])

  const closeAll = useCallback(() => {
    savedContent.current.clear()
    setTabs([])
    setActivePath('')
  }, [])

  const updateContent = useCallback((target: string, value: string | undefined) => {
    if (!target) return
    const next = value ?? ''
    setTabs(previous => previous.map(tab => {
      if (tab.path !== target) return tab
      const saved = savedContent.current.get(target)
      return { ...tab, content: next, dirty: tab.untitled ? next.length > 0 : saved !== next }
    }))
  }, [])

  const saveFile = useCallback(async (): Promise<boolean> => {
    const bridge = window.electronAPI
    let tab: Tab | undefined
    setTabs(previous => {
      tab = previous.find(candidate => candidate.path === activePath)
      return previous
    })
    if (!tab || !tab.dirty) return true
    if (tab.untitled) {
      // Untitled buffers have no on-disk location yet; the explorer creates files.
      console.warn('[editor] enregistre ce fichier via l\'explorateur avant de sauvegarder')
      return false
    }
    if (!bridge) return false

    const snapshot = tab
    setSaveState('saving')
    try {
      await bridge.files.write(snapshot.path, snapshot.content)
      savedContent.current.set(snapshot.path, snapshot.content)
      setTabs(previous => previous.map(candidate =>
        candidate.path === snapshot.path ? { ...candidate, dirty: false } : candidate))
      setSaveState('saved')
      return true
    } catch (error) {
      console.error(`[editor] enregistrement impossible: ${(error as Error).message}`)
      setSaveState('error')
      return false
    }
  }, [activePath])

  /**
   * Autosave : enregistre le fichier actif après une pause de frappe.
   * L'utilisateur n'a jamais à deviner si son travail est écrit sur disque —
   * l'état est reflété dans la barre de statut (Enregistré / En cours / Échec).
   */
  const scheduleAutosave = useCallback((enabled: boolean): void => {
    if (!enabled) return
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current)
    autosaveTimer.current = window.setTimeout(() => { void saveFile() }, 1200)
  }, [saveFile])

  useEffect(() => () => {
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current)
  }, [])

  const newUntitledFile = useCallback(() => {
    const path = `untitled:${Date.now()}`
    savedContent.current.set(path, '')
    setTabs(previous => [...previous, {
      path,
      name: 'sans-titre.txt',
      language: 'plaintext',
      content: '',
      dirty: false,
      untitled: true,
    }])
    setActivePath(path)
  }, [])

  /**
   * Reloads open tabs from disk. Called after the agent writes files so the
   * editor never shows stale content. Tabs with unsaved edits are preserved.
   */
  const reloadFromDisk = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge) return

    let current: Tab[] = []
    setTabs(previous => {
      current = previous
      return previous
    })

    const updates = new Map<string, string>()
    const removed: string[] = []

    for (const tab of current) {
      if (tab.untitled || tab.dirty) continue
      try {
        const content = await bridge.files.read(tab.path)
        if (content !== tab.content) updates.set(tab.path, content)
      } catch {
        removed.push(tab.path)
      }
    }

    if (updates.size === 0 && removed.length === 0) return
    for (const [path, content] of updates) savedContent.current.set(path, content)
    for (const path of removed) savedContent.current.delete(path)

    setTabs(previous => previous
      .filter(tab => !removed.includes(tab.path))
      .map(tab => (updates.has(tab.path) ? { ...tab, content: updates.get(tab.path)!, dirty: false } : tab)))
    setActivePath(current => (removed.includes(current) ? '' : current))
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveFile()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [saveFile])

  return {
    tabs,
    activePath,
    recent,
    saveState,
    openFile,
    openPath,
    closeTab,
    closeOthers,
    closeAll,
    selectTab,
    updateContent,
    saveFile,
    scheduleAutosave,
    newUntitledFile,
    reloadFromDisk,
  }
}
