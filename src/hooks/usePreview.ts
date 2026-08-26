import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PreviewCapture, PreviewEvent, PreviewStatus, PreviewTab } from '../shared/types'

const IDLE_STATUS: PreviewStatus = {
  state: 'idle',
  workspace: null,
  target: null,
  url: null,
  command: null,
  pid: null,
  message: 'Aucune prévisualisation en cours.',
  log: [],
  startedAt: null,
  readyAt: null,
}

const MAX_LOG_LINES = 300
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2

function newTabId(): string {
  return `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function titleFor(url: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return last && last.length > 0 ? last : `:${parsed.port || '80'}`
  } catch {
    return 'aperçu'
  }
}

/**
 * Owns the preview lifecycle and the Preview tab strip.
 *
 * State lives here rather than in the component so the panel keeps its tabs,
 * history and zoom when it is hidden and shown again.
 */
export function usePreview(workspace: string | null) {
  const [status, setStatus] = useState<PreviewStatus>(IDLE_STATUS)
  const [log, setLog] = useState<string[]>([])
  const [tabs, setTabs] = useState<PreviewTab[]>([])
  const [activeTabId, setActiveTabId] = useState('')
  const [capture, setCapture] = useState<PreviewCapture | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  /** Bumped to force the active iframe to reload. */
  const [reloadToken, setReloadToken] = useState(0)

  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const activeTab = useMemo(
    () => tabs.find(tab => tab.id === activeTabId) ?? null,
    [tabs, activeTabId],
  )

  /** Adds a tab for `url`, or focuses the existing one. */
  const openTab = useCallback((url: string) => {
    setTabs(previous => {
      const existing = previous.find(tab => tab.url === url)
      if (existing) {
        setActiveTabId(existing.id)
        return previous
      }
      const tab: PreviewTab = {
        id: newTabId(),
        title: titleFor(url),
        url,
        history: [url],
        historyIndex: 0,
        zoom: 1,
      }
      setActiveTabId(tab.id)
      return [...previous, tab]
    })
  }, [])

  const closeTab = useCallback((id: string) => {
    setTabs(previous => {
      const index = previous.findIndex(tab => tab.id === id)
      if (index < 0) return previous
      const next = previous.filter(tab => tab.id !== id)
      setActiveTabId(current => {
        if (current !== id) return current
        const fallback = next[index] ?? next[index - 1] ?? next[0]
        return fallback?.id ?? ''
      })
      return next
    })
  }, [])

  const selectTab = useCallback((id: string) => setActiveTabId(id), [])

  /** Pushes a URL onto the active tab's history, dropping any forward entries. */
  const navigate = useCallback((url: string) => {
    setTabs(previous => previous.map(tab => {
      if (tab.id !== activeTabId) return tab
      if (tab.history[tab.historyIndex] === url) return { ...tab, url }
      const history = [...tab.history.slice(0, tab.historyIndex + 1), url].slice(-50)
      return { ...tab, url, title: titleFor(url), history, historyIndex: history.length - 1 }
    }))
  }, [activeTabId])

  const goBack = useCallback(() => {
    setTabs(previous => previous.map(tab => {
      if (tab.id !== activeTabId || tab.historyIndex <= 0) return tab
      const index = tab.historyIndex - 1
      return { ...tab, historyIndex: index, url: tab.history[index], title: titleFor(tab.history[index]) }
    }))
  }, [activeTabId])

  const goForward = useCallback(() => {
    setTabs(previous => previous.map(tab => {
      if (tab.id !== activeTabId || tab.historyIndex >= tab.history.length - 1) return tab
      const index = tab.historyIndex + 1
      return { ...tab, historyIndex: index, url: tab.history[index], title: titleFor(tab.history[index]) }
    }))
  }, [activeTabId])

  const setZoom = useCallback((zoom: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(zoom.toFixed(2))))
    setTabs(previous => previous.map(tab => (tab.id === activeTabId ? { ...tab, zoom: clamped } : tab)))
  }, [activeTabId])

  const reload = useCallback(() => setReloadToken(previous => previous + 1), [])

  // Main-process events drive the status; the tab strip follows the served URL.
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge) return

    const dispose = bridge.preview.onEvent((event: PreviewEvent) => {
      if (event.type === 'status') {
        setStatus(event.status)
        if (event.status.state === 'error' && event.status.message.length > 0) setError(event.status.message)
        if (event.status.state === 'running' && event.status.url) {
          setError('')
          openTab(event.status.url)
        }
      } else if (event.type === 'log') {
        setLog(previous => [...previous, event.line].slice(-MAX_LOG_LINES))
      } else if (event.type === 'reload') {
        reload()
      } else if (event.type === 'screenshot') {
        setCapture(event.capture)
      }
    })

    void bridge.preview.status().then(current => {
      setStatus(current)
      setLog(current.log)
      if (current.state === 'running' && current.url) openTab(current.url)
    }).catch(() => { /* the main process is not ready yet */ })

    return dispose
  }, [openTab, reload])

  // Load any capture already on disk so the Analyse tab is populated on open.
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge || !workspace) {
      setCapture(null)
      return
    }
    let cancelled = false
    void bridge.preview.latestCapture(workspace)
      .then(existing => { if (!cancelled && existing) setCapture(existing) })
      .catch(() => { /* no capture yet */ })
    return () => { cancelled = true }
  }, [workspace])

  const start = useCallback(async (relativePath = '', install = true) => {
    const bridge = window.electronAPI
    if (!bridge) return
    const root = workspaceRef.current
    if (!root) {
      setError('Ouvre un dossier avant de lancer l\'aperçu.')
      return
    }
    setError('')
    setLog([])
    try {
      const result = await bridge.preview.start(root, relativePath, install)
      setStatus(result)
      if (result.state === 'running' && result.url) openTab(result.url)
      else if (result.state === 'error') setError(result.message)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [openTab])

  const stop = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge) return
    try {
      setStatus(await bridge.preview.stop())
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [])

  const takeCapture = useCallback(async () => {
    const bridge = window.electronAPI
    const root = workspaceRef.current
    if (!bridge || !root) return
    const url = activeTab?.url ?? status.url
    if (!url) {
      setError('Démarre l\'aperçu avant de prendre une capture.')
      return
    }
    setCapturing(true)
    setError('')
    try {
      setCapture(await bridge.preview.capture({ workspace: root, url }))
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setCapturing(false)
    }
  }, [activeTab?.url, status.url])

  const openExternally = useCallback(async () => {
    const bridge = window.electronAPI
    const url = activeTab?.url ?? status.url
    if (!bridge || !url) return
    try {
      await bridge.preview.openExternal(url)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [activeTab?.url, status.url])

  // A different folder invalidates every tab: the URLs pointed at the old one.
  useEffect(() => {
    setTabs([])
    setActiveTabId('')
    setStatus(IDLE_STATUS)
    setLog([])
    setError('')
  }, [workspace])

  const busy = status.state === 'starting' || status.state === 'installing'

  return {
    status,
    log,
    tabs,
    activeTab,
    activeTabId,
    capture,
    capturing,
    error,
    busy,
    reloadToken,
    start,
    stop,
    reload,
    navigate,
    goBack,
    goForward,
    setZoom,
    openTab,
    closeTab,
    selectTab,
    takeCapture,
    openExternally,
  }
}
