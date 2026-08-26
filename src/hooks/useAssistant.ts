import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentActivity, AgentEvent, AgentMode, AIProviderInfo, AIStreamEvent, ChatEntry,
  PermissionsInfo,
} from '../shared/types'

const MAX_EXCERPT_CHARS = 12000
const HISTORY_TURNS = 8

export interface AssistantInput {
  workspace: string | null
  activeFilePath: string
  activeFileContent: string
  sendFileContents: boolean
  /** Transcript of the active conversation. */
  entries: ChatEntry[]
  onEntriesChange: (update: (entries: ChatEntry[]) => ChatEntry[]) => void
  mode: AgentMode
  /** Session token sent along so the main process can account quota usage. */
  sessionToken?: string | null
  /** Fires when a turn writes files, so the shell can refresh the tree. */
  onFilesChanged?: (workspace: string) => void
}

/** One step of the agent timeline, tool calls and status lines interleaved. */
export interface TimelineStep {
  id: string
  kind: 'status' | 'tool'
  label: string
  detail: string
  status: 'running' | 'success' | 'error'
  startedAt: number
  endedAt: number | null
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Keeps the excerpt small enough to leave room for tool traffic. */
function excerptOf(content: string): string {
  if (content.length <= MAX_EXCERPT_CHARS) return content
  return `${content.slice(0, MAX_EXCERPT_CHARS)}\n... [extrait tronqué]`
}

/** Picks the most informative argument to show next to a tool name. */
export function describeArgs(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args.slice(0, 120)
  if (typeof args !== 'object') return String(args)

  const record = args as Record<string, unknown>
  for (const field of ['path', 'command', 'query', 'pattern', 'from']) {
    const value = record[field]
    if (typeof value === 'string' && value.length > 0) return value.slice(0, 120)
  }
  const keys = Object.keys(record)
  return keys.length === 0 ? '' : keys.slice(0, 3).join(', ')
}

/**
 * Assistant transport.
 *
 * The streaming protocol is unchanged from the previous implementation: Chat
 * mode consumes `ai.onChunk`, Agent mode consumes `agent.onEvent`, both are
 * filtered by request/session id, and a partial answer is preserved when the
 * user stops a turn. Only presentation moved out of this file.
 */
export function useAssistant({
  workspace, activeFilePath, activeFileContent, sendFileContents,
  entries, onEntriesChange, mode, sessionToken, onFilesChanged,
}: AssistantInput) {
  const [rawProviders, setRawProviders] = useState<AIProviderInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [streamText, setStreamText] = useState('')
  const [activities, setActivities] = useState<AgentActivity[]>([])
  const [timeline, setTimeline] = useState<TimelineStep[]>([])
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [keyMasks, setKeyMasks] = useState<Record<string, string | null>>({})
  /** Droits du compte : les modèles premium n'apparaissent que si autorisés. */
  const [permissions, setPermissions] = useState<PermissionsInfo | null>(null)

  // Modèles visibles : le catalogue est filtré côté MAIN process selon le
  // plan du compte (jeton passé à listProviders). Le renderer n'applique
  // aucun filtrage propre — la barrière réelle est aussi côté main.
  const providers = rawProviders

  const streamRef = useRef('')
  const activityRef = useRef<AgentActivity[]>([])
  const timelineRef = useRef<TimelineStep[]>([])
  const sessionRef = useRef<string | null>(null)
  const requestRef = useRef<string | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  /** rAF throttle : un seul re-render par frame, même sous forte cadence. */
  const flushHandleRef = useRef<number | null>(null)

  const scheduleStreamFlush = useCallback(() => {
    if (flushHandleRef.current !== null) return
    flushHandleRef.current = window.requestAnimationFrame(() => {
      flushHandleRef.current = null
      setStreamText(streamRef.current)
      window.electronAPI?.system.log(`[AI] renderer state update (len=${streamRef.current.length})`)
        .catch(() => undefined)
    })
  }, [])

  const allModels = useMemo(
    () => providers.flatMap(provider =>
      provider.models.map(model => ({ ...model, providerName: provider.name }))),
    [providers],
  )
  const currentModel = allModels.find(model => model.id === selectedModel) ?? null
  const currentProvider = providers.find(provider => provider.id === currentModel?.provider) ?? null
  const providerReady = currentProvider?.configured ?? false
  const agentCapable = currentModel?.supportsTools ?? false

  // Diffuse le modèle actif (affichage consommation My Creation AI).
  useEffect(() => {
    if (!currentModel) return
    document.dispatchEvent(new CustomEvent('assistant-model-changed', {
      detail: { label: currentModel.label },
    }))
  }, [currentModel?.id, currentModel?.label])

  const refreshProviders = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge) return
    // Jeton transmis : le main renvoie uniquement les modèles du plan.
    const list = await bridge.api.listProviders(sessionToken ?? null)
    setRawProviders(list)

    const masks: Record<string, string | null> = {}
    for (const provider of list) {
      if (provider.tier === 'free') continue
      const status = await bridge.api.checkKey(provider.id)
      masks[provider.id] = status.configured ? status.maskedKey ?? null : null
    }
    setKeyMasks(masks)

    // Prefer a configured provider so the panel is usable on first open.
    setSelectedModel(previous => {
      if (previous && list.some(provider => provider.models.some(model => model.id === previous))) {
        return previous
      }
      const configured = list.find(provider => provider.configured && provider.models.length > 0)
      const fallback = list.find(provider => provider.models.length > 0)
      return (configured ?? fallback)?.models[0]?.id ?? ''
    })
  }, [sessionToken])

  useEffect(() => {
    void refreshProviders()
    const handler = () => { void refreshProviders() }
    document.addEventListener('api-keys-changed', handler)
    return () => document.removeEventListener('api-keys-changed', handler)
  }, [refreshProviders])

  // Droits effectifs du compte : filtrage des modèles côté renderer,
  // décision prise côté main (jamais l'inverse).
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge || !sessionToken) {
      setPermissions(null)
      return
    }
    let cancelled = false
    void bridge.permissions.get(sessionToken)
      .then(info => { if (!cancelled) setPermissions(info) })
      .catch(() => { /* plan inconnu : liste complète, le main revalide */ })
    const handler = () => {
      void bridge.permissions.get(sessionToken)
        .then(info => { if (!cancelled) setPermissions(info) })
        .catch(() => { /* ignore */ })
    }
    document.addEventListener('api-keys-changed', handler)
    return () => {
      cancelled = true
      document.removeEventListener('api-keys-changed', handler)
    }
  }, [sessionToken])

  // Drop listeners if the owner unmounts mid-stream.
  useEffect(() => () => disposeRef.current?.(), [])

  const pushStep = useCallback((step: TimelineStep) => {
    timelineRef.current = [...timelineRef.current, step]
    setTimeline(timelineRef.current)
  }, [])

  const closeStep = useCallback((id: string, status: 'success' | 'error', detail?: string) => {
    timelineRef.current = timelineRef.current.map(step => (step.id === id
      ? { ...step, status, endedAt: Date.now(), detail: detail ?? step.detail }
      : step))
    setTimeline(timelineRef.current)
  }, [])

  const resetStream = useCallback(() => {
    if (flushHandleRef.current !== null) {
      window.cancelAnimationFrame(flushHandleRef.current)
      flushHandleRef.current = null
    }
    streamRef.current = ''
    activityRef.current = []
    timelineRef.current = []
    setStreamText('')
    setActivities([])
    setTimeline([])
    setStatusText('')
    setBusy(false)
    setStartedAt(null)
    sessionRef.current = null
    requestRef.current = null
    disposeRef.current?.()
    disposeRef.current = null
  }, [])

  const pushEntry = useCallback((entry: Omit<ChatEntry, 'id'>) => {
    onEntriesChange(previous => [...previous, { ...entry, id: newId() }])
  }, [onEntriesChange])

  const finishTurn = useCallback((text: string, toolActivities: AgentActivity[]) => {
    const trimmed = text.trim()
    if (trimmed.length > 0 || toolActivities.length > 0) {
      pushEntry({
        role: 'assistant',
        content: trimmed.length > 0 ? trimmed : 'Action terminée.',
        activities: toolActivities.length > 0 ? toolActivities : undefined,
      })
    }
    resetStream()
  }, [pushEntry, resetStream])

  const failTurn = useCallback((message: string) => {
    pushEntry({ role: 'assistant', content: message, error: true })
    resetStream()
  }, [pushEntry, resetStream])

  // ─── [DIAG] TEST STREAM ───────────────────────────────
  // Génère n tokens locaux via le MÊME pipeline que l'IA (streamRef → rAF →
  // state → append). Aucun réseau. Exposé pour les tests de stabilité :
  //   window.__mcTestStream(10000)
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__mcTestStream = (count: number) => {
      const total = Math.max(1, Math.min(50_000, Math.floor(count) || 1000))
      window.electronAPI?.system.log(`[AI] TEST-STREAM start n=${total}`).catch(() => undefined)
      streamRef.current = ''
      setBusy(true)
      setStartedAt(Date.now())
      let sent = 0
      const timer = window.setInterval(() => {
        for (let i = 0; i < 20 && sent < total; i += 1) {
          sent += 1
          streamRef.current += `token ${sent}\n`
          scheduleStreamFlush()
        }
        if (sent >= total) {
          window.clearInterval(timer)
          finishTurn(streamRef.current, [])
          window.electronAPI?.system.log(`[AI] TEST-STREAM end n=${total}`).catch(() => undefined)
        }
      }, 16)
    }
    return () => { delete (window as unknown as Record<string, unknown>).__mcTestStream }
  }, [scheduleStreamFlush, finishTurn])

  const runAgent = useCallback(async (prompt: string, history: ChatEntry[]) => {
    const bridge = window.electronAPI
    if (!bridge) return
    if (!workspace) {
      failTurn('Ouvre un dossier de travail avant d\'utiliser le mode Agent.')
      return
    }

    setStatusText('Démarrage de l\'agent')
    const dispose = bridge.agent.onEvent((event: AgentEvent) => {
      if (sessionRef.current && event.sessionId !== sessionRef.current) return

      switch (event.type) {
        case 'status':
          setStatusText(event.text)
          pushStep({
            id: `status-${newId()}`,
            kind: 'status',
            label: event.text,
            detail: '',
            status: 'success',
            startedAt: Date.now(),
            endedAt: Date.now(),
          })
          break
        case 'text':
          streamRef.current += event.text
          scheduleStreamFlush()
          break
        case 'tool-call':
          activityRef.current = [
            ...activityRef.current,
            { id: event.id, tool: event.tool, args: event.args, status: 'running', summary: '' },
          ]
          setActivities(activityRef.current)
          setStatusText(`Outil: ${event.tool}`)
          pushStep({
            id: event.id,
            kind: 'tool',
            label: event.tool,
            detail: describeArgs(event.args),
            status: 'running',
            startedAt: Date.now(),
            endedAt: null,
          })
          break
        case 'tool-result':
          activityRef.current = activityRef.current.map(activity =>
            (activity.id === event.id
              ? { ...activity, status: event.success ? 'success' : 'error', summary: event.summary }
              : activity))
          setActivities(activityRef.current)
          closeStep(event.id, event.success ? 'success' : 'error', event.summary)
          break
        case 'files-changed':
          document.dispatchEvent(new CustomEvent('workspace-files-changed', { detail: event.workspace }))
          onFilesChanged?.(event.workspace)
          break
        case 'done':
          finishTurn(event.text || streamRef.current, activityRef.current)
          break
        case 'error':
          failTurn(`Erreur: ${event.message}`)
          break
      }
    })
    disposeRef.current = dispose

    try {
      const { sessionId } = await bridge.agent.start({
        prompt,
        model: selectedModel,
        workspace,
        activeFilePath: activeFilePath || undefined,
        activeFileExcerpt: sendFileContents && activeFileContent ? excerptOf(activeFileContent) : undefined,
        history: history.slice(-HISTORY_TURNS).map(entry => ({ role: entry.role, content: entry.content })),
        sessionToken: sessionToken ?? undefined,
      })
      sessionRef.current = sessionId
    } catch (error) {
      failTurn(`Erreur: ${(error as Error).message}`)
    }
  }, [
    workspace, selectedModel, activeFilePath, activeFileContent, sendFileContents, sessionToken,
    failTurn, finishTurn, pushStep, closeStep, onFilesChanged,
  ])

  const runChat = useCallback(async (prompt: string, history: ChatEntry[]) => {
    const bridge = window.electronAPI
    if (!bridge) return

    setStatusText('Génération')
    const dispose = bridge.ai.onChunk((event: AIStreamEvent) => {
      if (requestRef.current && event.requestId !== requestRef.current) return
      if (event.type === 'text') {
        streamRef.current += event.text
        scheduleStreamFlush()
      } else if (event.type === 'reasoning') {
        // Modèle « thinking » (ex. x-preview-f-free raisonne avant de
        // répondre) : indicateur visible au lieu d'un silence trompeur.
        setStatusText(previous => (previous === 'Réflexion du modèle…' ? previous : 'Réflexion du modèle…'))
      } else if (event.type === 'done') {
        window.electronAPI?.system.log(`[AI] renderer done (len=${streamRef.current.length})`).catch(() => undefined)
        finishTurn(streamRef.current, [])
      } else if (event.type === 'error') {
        failTurn(`Erreur: ${event.message}`)
      }
    })
    disposeRef.current = dispose

    try {
      const messages = [...history.slice(-HISTORY_TURNS), { role: 'user' as const, content: prompt }]
        .map(entry => ({ role: entry.role, content: entry.content }))
      const { requestId } = await bridge.ai.chat({
        messages,
        model: selectedModel,
        workspace,
        activeFilePath: activeFilePath || undefined,
        activeFileExcerpt: sendFileContents && activeFileContent ? excerptOf(activeFileContent) : undefined,
        sessionToken: sessionToken ?? undefined,
      })
      requestRef.current = requestId
      void bridge.system?.log(`[AI] IPC sent model=${selectedModel} requestId=${requestId}`).catch(() => undefined)
    } catch (error) {
      failTurn(`Erreur: ${(error as Error).message}`)
    }
  }, [selectedModel, workspace, activeFilePath, activeFileContent, sendFileContents, sessionToken, failTurn, finishTurn])

  /** Sends `prompt`, optionally replacing the history (used by regenerate). */
  const send = useCallback(async (prompt: string, historyOverride?: ChatEntry[]) => {
    const trimmed = prompt.trim()
    if (trimmed.length === 0 || busy) return
    if (!window.electronAPI) {
      pushEntry({
        role: 'assistant',
        content: 'Cette fonctionnalité nécessite l\'application Electron.',
        error: true,
      })
      return
    }
    if (!selectedModel) {
      pushEntry({ role: 'assistant', content: 'Aucun modèle disponible.', error: true })
      return
    }
    if (!providerReady) {
      pushEntry({
        role: 'assistant',
        content: `Configure d'abord la clé API de ${currentProvider?.name ?? 'ce fournisseur'}.`,
        error: true,
      })
      return
    }

    const history = (historyOverride ?? entries).filter(entry => !entry.error)
    pushEntry({ role: 'user', content: trimmed })
    streamRef.current = ''
    activityRef.current = []
    timelineRef.current = []
    setStreamText('')
    setActivities([])
    setTimeline([])
    setBusy(true)
    setStartedAt(Date.now())

    if (mode === 'agent') await runAgent(trimmed, history)
    else await runChat(trimmed, history)
  }, [
    busy, selectedModel, providerReady, currentProvider, entries, mode,
    pushEntry, runAgent, runChat,
  ])

  const stop = useCallback(() => {
    const bridge = window.electronAPI
    if (sessionRef.current) void bridge?.agent.cancel(sessionRef.current)
    if (requestRef.current) void bridge?.ai.cancel(requestRef.current)

    const partial = streamRef.current
    const toolActivities = activityRef.current
    resetStream()
    pushEntry({
      role: 'assistant',
      content: partial.trim().length > 0 ? `${partial.trim()}\n\n[Interrompu]` : '[Interrompu]',
      activities: toolActivities.length > 0 ? toolActivities : undefined,
    })
  }, [pushEntry, resetStream])

  /** Drops the last assistant turn and replays the preceding user prompt. */
  const regenerate = useCallback(() => {
    if (busy) return
    const lastUserIndex = [...entries].reverse().findIndex(entry => entry.role === 'user')
    if (lastUserIndex < 0) return
    const index = entries.length - 1 - lastUserIndex
    const prompt = entries[index].content
    const history = entries.slice(0, index)
    onEntriesChange(() => history)
    void send(prompt, history)
  }, [busy, entries, onEntriesChange, send])

  /** Replaces a user message and discards everything after it. */
  const editAndResend = useCallback((entryId: string, content: string) => {
    if (busy) return
    const index = entries.findIndex(entry => entry.id === entryId)
    if (index < 0) return
    const history = entries.slice(0, index)
    onEntriesChange(() => history)
    void send(content, history)
  }, [busy, entries, onEntriesChange, send])

  const saveKey = useCallback(async (providerId: string, key: string) => {
    const bridge = window.electronAPI
    if (!bridge || key.trim().length === 0) return false
    const result = await bridge.api.storeKey(providerId, key.trim())
    if (!result.success || !result.configured) return false
    await refreshProviders()
    document.dispatchEvent(new CustomEvent('api-keys-changed'))
    return true
  }, [refreshProviders])

  const removeKey = useCallback(async (providerId: string) => {
    const bridge = window.electronAPI
    if (!bridge) return
    await bridge.api.deleteKey(providerId)
    await refreshProviders()
    document.dispatchEvent(new CustomEvent('api-keys-changed'))
  }, [refreshProviders])

  return {
    providers,
    allModels,
    selectedModel,
    setSelectedModel,
    currentModel,
    currentProvider,
    providerReady,
    agentCapable,
    keyMasks,
    permissions,
    busy,
    statusText,
    streamText,
    activities,
    timeline,
    startedAt,
    send,
    stop,
    regenerate,
    editAndResend,
    saveKey,
    removeKey,
    refreshProviders,
  }
}
