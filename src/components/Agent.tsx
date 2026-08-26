import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot, Check, ChevronDown, CornerDownLeft, Key, Loader2, Plus, Settings, Sparkles,
  StopCircle, Trash2, TriangleAlert, Wrench, X,
} from 'lucide-react'
import type {
  AgentActivity,
  AgentEvent,
  AgentMode,
  AIProviderInfo,
  AIStreamEvent,
  ChatEntry,
} from '../shared/types'

interface Props {
  open: boolean
  onClose: () => void
  workspace: string | null
  activeFilePath: string
  activeFileContent: string
  sendFileContents: boolean
}

const MODE_LABEL: Record<AgentMode, string> = { chat: 'Chat', agent: 'Agent' }
const MAX_EXCERPT_CHARS = 12000
const HISTORY_TURNS = 8

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Keeps the excerpt small enough to leave room for tool traffic. */
function excerptOf(content: string): string {
  if (content.length <= MAX_EXCERPT_CHARS) return content
  return `${content.slice(0, MAX_EXCERPT_CHARS)}\n... [extrait tronqué]`
}

function describeArgs(args: unknown): string {
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

/** Renders assistant text with fenced code blocks preserved. */
function MessageBody({ content }: { content: string }) {
  const segments = useMemo(() => {
    const parts: Array<{ kind: 'text' | 'code'; language: string; value: string }> = []
    const pattern = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g
    let cursor = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(content)) !== null) {
      if (match.index > cursor) {
        parts.push({ kind: 'text', language: '', value: content.slice(cursor, match.index) })
      }
      parts.push({ kind: 'code', language: match[1] || 'code', value: match[2] })
      cursor = match.index + match[0].length
    }
    if (cursor < content.length) {
      parts.push({ kind: 'text', language: '', value: content.slice(cursor) })
    }
    return parts
  }, [content])

  return (
    <>
      {segments.map((segment, index) => (
        segment.kind === 'code' ? (
          <pre key={index} className="msg-code">
            <span className="msg-code-lang">{segment.language}</span>
            <code>{segment.value}</code>
          </pre>
        ) : (
          <p key={index} className="msg-text">{segment.value}</p>
        )
      ))}
    </>
  )
}

function ActivityList({ activities }: { activities: AgentActivity[] }) {
  if (activities.length === 0) return null
  return (
    <ul className="agent-activity">
      {activities.map(activity => (
        <li key={activity.id} className={`activity ${activity.status}`}>
          <span className="activity-icon">
            {activity.status === 'running' && <Loader2 size={11} className="spin" />}
            {activity.status === 'success' && <Check size={11} />}
            {activity.status === 'error' && <TriangleAlert size={11} />}
          </span>
          <span className="activity-tool">{activity.tool}</span>
          <span className="activity-args">{describeArgs(activity.args)}</span>
          {activity.status === 'error' && <span className="activity-error">{activity.summary}</span>}
        </li>
      ))}
    </ul>
  )
}

export default function Agent({
  open, onClose, workspace, activeFilePath, activeFileContent, sendFileContents,
}: Props) {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<AgentMode>('agent')
  const [providers, setProviders] = useState<AIProviderInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState('')
  const [streamText, setStreamText] = useState('')
  const [activities, setActivities] = useState<AgentActivity[]>([])
  const [keyMasks, setKeyMasks] = useState<Record<string, string | null>>({})
  const [keyProvider, setKeyProvider] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [showKeyInput, setShowKeyInput] = useState(false)
  const [openMenu, setOpenMenu] = useState<'mode' | 'model' | 'key' | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const topbarRef = useRef<HTMLDivElement>(null)
  const streamRef = useRef('')
  const activityRef = useRef<AgentActivity[]>([])
  const sessionRef = useRef<string | null>(null)
  const requestRef = useRef<string | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)

  const allModels = useMemo(
    () => providers.flatMap(provider => provider.models.map(model => ({ ...model, providerName: provider.name }))),
    [providers],
  )
  const currentModel = allModels.find(model => model.id === selectedModel) ?? null
  const currentProvider = providers.find(provider => provider.id === currentModel?.provider) ?? null
  const providerReady = currentProvider?.configured ?? false
  const agentCapable = currentModel?.supportsTools ?? false

  const refreshProviders = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge) return
    const list = await bridge.api.listProviders()
    setProviders(list)

    const masks: Record<string, string | null> = {}
    for (const provider of list) {
      const status = await bridge.api.checkKey(provider.id)
      masks[provider.id] = status.configured ? status.maskedKey ?? null : null
    }
    setKeyMasks(masks)

    // Prefer a configured provider so the panel is usable on first open.
    setSelectedModel(previous => {
      if (previous && list.some(provider => provider.models.some(model => model.id === previous))) return previous
      const configured = list.find(provider => provider.configured && provider.models.length > 0)
      const fallback = configured ?? list.find(provider => provider.models.length > 0)
      return fallback?.models[0]?.id ?? ''
    })
    setKeyProvider(previous => previous || list[0]?.id || '')
  }, [])

  useEffect(() => {
    void refreshProviders()
    const handler = () => { void refreshProviders() }
    document.addEventListener('api-keys-changed', handler)
    return () => document.removeEventListener('api-keys-changed', handler)
  }, [refreshProviders])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [entries, streamText, activities, statusText])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!openMenu) return
    const handler = (event: MouseEvent) => {
      if (!topbarRef.current?.contains(event.target as Node)) setOpenMenu(null)
    }
    const id = window.setTimeout(() => window.addEventListener('click', handler), 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('click', handler)
    }
  }, [openMenu])

  // Drop listeners if the panel unmounts mid-stream.
  useEffect(() => () => disposeRef.current?.(), [])

  const resetStream = useCallback(() => {
    streamRef.current = ''
    activityRef.current = []
    setStreamText('')
    setActivities([])
    setStatusText('')
    setBusy(false)
    sessionRef.current = null
    requestRef.current = null
    disposeRef.current?.()
    disposeRef.current = null
  }, [])

  const pushEntry = useCallback((entry: Omit<ChatEntry, 'id'>) => {
    setEntries(previous => [...previous, { ...entry, id: newId() }])
  }, [])

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
          break
        case 'text':
          streamRef.current += event.text
          setStreamText(streamRef.current)
          break
        case 'tool-call':
          activityRef.current = [
            ...activityRef.current,
            { id: event.id, tool: event.tool, args: event.args, status: 'running', summary: '' },
          ]
          setActivities(activityRef.current)
          setStatusText(`Outil: ${event.tool}`)
          break
        case 'tool-result':
          activityRef.current = activityRef.current.map(activity =>
            activity.id === event.id
              ? { ...activity, status: event.success ? 'success' : 'error', summary: event.summary }
              : activity)
          setActivities(activityRef.current)
          break
        case 'files-changed':
          document.dispatchEvent(new CustomEvent('workspace-files-changed', { detail: event.workspace }))
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
      })
      sessionRef.current = sessionId
    } catch (error) {
      failTurn(`Erreur: ${(error as Error).message}`)
    }
  }, [workspace, selectedModel, activeFilePath, activeFileContent, sendFileContents, failTurn, finishTurn])

  const runChat = useCallback(async (prompt: string, history: ChatEntry[]) => {
    const bridge = window.electronAPI
    if (!bridge) return

    setStatusText('Génération')
    const dispose = bridge.ai.onChunk((event: AIStreamEvent) => {
      if (requestRef.current && event.requestId !== requestRef.current) return
      if (event.type === 'text') {
        streamRef.current += event.text
        setStreamText(streamRef.current)
      } else if (event.type === 'done') {
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
      })
      requestRef.current = requestId
    } catch (error) {
      failTurn(`Erreur: ${(error as Error).message}`)
    }
  }, [selectedModel, workspace, activeFilePath, activeFileContent, sendFileContents, failTurn, finishTurn])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (prompt.length === 0 || busy) return
    if (!window.electronAPI) {
      pushEntry({ role: 'assistant', content: 'Cette fonctionnalité nécessite l\'application Electron.', error: true })
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

    const history = entries.filter(entry => !entry.error)
    setInput('')
    pushEntry({ role: 'user', content: prompt })
    streamRef.current = ''
    activityRef.current = []
    setStreamText('')
    setActivities([])
    setBusy(true)

    if (mode === 'agent') await runAgent(prompt, history)
    else await runChat(prompt, history)
  }, [input, busy, selectedModel, providerReady, currentProvider, entries, mode, pushEntry, runAgent, runChat])

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

  const saveKey = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || keyInput.trim().length === 0) return
    const result = await bridge.api.storeKey(keyProvider, keyInput.trim())
    if (!result.success || !result.configured) {
      pushEntry({ role: 'assistant', content: `Clé refusée: ${result.error ?? 'raison inconnue'}`, error: true })
      return
    }
    setKeyInput('')
    setShowKeyInput(false)
    setOpenMenu(null)
    await refreshProviders()
    document.dispatchEvent(new CustomEvent('api-keys-changed'))
    pushEntry({ role: 'assistant', content: `Clé API enregistrée pour ${keyProvider}.` })
  }, [keyInput, keyProvider, pushEntry, refreshProviders])

  const removeKey = useCallback(async (providerId: string) => {
    const bridge = window.electronAPI
    if (!bridge) return
    await bridge.api.deleteKey(providerId)
    await refreshProviders()
    document.dispatchEvent(new CustomEvent('api-keys-changed'))
  }, [refreshProviders])

  const openKeyEditor = useCallback((providerId: string) => {
    setKeyProvider(providerId)
    setShowKeyInput(true)
    setOpenMenu(null)
  }, [])

  if (!open) return null

  const composerDisabled = busy || !providerReady || !selectedModel
  const modeWarning = mode === 'agent' && selectedModel.length > 0 && !agentCapable
    ? `${currentModel?.label ?? selectedModel} ne supporte pas les outils. Choisis un autre modèle pour le mode Agent.`
    : null

  return (
    <aside className="agent-panel">
      <div className="agent-header">
        <div><Bot size={15} /> Assistant</div>
        <div className="agent-header-actions">
          {entries.length > 0 && (
            <button onClick={() => setEntries([])} title="Effacer la conversation">
              <Trash2 size={13} />
            </button>
          )}
          <button onClick={onClose} title="Fermer"><X size={14} /></button>
        </div>
      </div>

      <div className="agent-topbar" ref={topbarRef}>
        <div className="agent-select" onClick={() => setOpenMenu(previous => (previous === 'mode' ? null : 'mode'))}>
          {MODE_LABEL[mode]} <ChevronDown size={12} />
          {openMenu === 'mode' && (
            <div className="agent-dropdown">
              {(['agent', 'chat'] as const).map(value => (
                <button key={value} onClick={() => { setMode(value); setOpenMenu(null) }}>
                  {MODE_LABEL[value]}
                  {value === mode && ' ✓'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="agent-select model" onClick={() => setOpenMenu(previous => (previous === 'model' ? null : 'model'))}>
          <span className="model-select-label">{currentModel?.label ?? 'Aucun modèle'}</span>
          <ChevronDown size={12} />
          {openMenu === 'model' && (
            <div className="agent-dropdown right model-dropdown">
              {providers.map(provider => (
                <div key={provider.id}>
                  <div className="agent-dropdown-group">
                    {provider.name}
                    <span className={provider.configured ? 'key-configured' : 'key-missing'}>
                      {provider.configured ? 'clé OK' : 'clé absente'}
                    </span>
                  </div>
                  {provider.models.map(model => (
                    <button
                      key={model.id}
                      className={model.id === selectedModel ? 'selected-model' : ''}
                      onClick={() => { setSelectedModel(model.id); setOpenMenu(null) }}
                    >
                      {model.label}
                      {model.id === selectedModel && ' ✓'}
                    </button>
                  ))}
                </div>
              ))}
              {providers.length === 0 && <div className="dropdown-empty">Aucun modèle disponible</div>}
            </div>
          )}
        </div>

        <div className="key-control">
          <button
            className={`agent-key-btn ${providerReady ? 'configured' : ''}`}
            onClick={() => setOpenMenu(previous => (previous === 'key' ? null : 'key'))}
            title="Gérer les clés API"
          >
            <Key size={12} />
            {providerReady && <span className="key-dot" />}
          </button>
          {openMenu === 'key' && (
            <div className="agent-dropdown key-dropdown">
              <div className="key-dropdown-title">Clés API</div>
              {providers.map(provider => (
                <div key={provider.id}>
                  <div className="key-provider-row">
                    <span>{provider.name}</span>
                    <span className={provider.configured ? 'key-configured' : 'key-missing'}>
                      {provider.configured ? 'configurée' : 'absente'}
                    </span>
                  </div>
                  {provider.configured ? (
                    <div className="key-actions">
                      <span className="key-mask-text">{keyMasks[provider.id]}</span>
                      <button onClick={() => openKeyEditor(provider.id)}><Plus size={11} /> Remplacer</button>
                      <button className="danger-item" onClick={() => void removeKey(provider.id)}>
                        <Trash2 size={11} /> Retirer
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => openKeyEditor(provider.id)}>
                      <Plus size={11} /> Ajouter la clé {provider.name}
                    </button>
                  )}
                </div>
              ))}
              <div className="key-dropdown-divider" />
              <button onClick={() => { setOpenMenu(null); document.dispatchEvent(new CustomEvent('open-settings')) }}>
                <Settings size={12} /> Tous les paramètres
              </button>
            </div>
          )}
        </div>
      </div>

      {showKeyInput && (
        <div className="key-input-area">
          <input
            type="password"
            value={keyInput}
            onChange={event => setKeyInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') void saveKey() }}
            placeholder={`Clé API ${keyProvider}`}
            autoFocus
          />
          <button className="btn-primary" onClick={() => void saveKey()}><Key size={12} /> Enregistrer</button>
          <button onClick={() => { setShowKeyInput(false); setKeyInput('') }}><X size={12} /></button>
        </div>
      )}

      {modeWarning && <div className="agent-warning"><TriangleAlert size={12} /> {modeWarning}</div>}

      <div className="agent-body" ref={bodyRef}>
        {entries.length === 0 && (
          <div className="agent-welcome">
            <div className="agent-icon"><Sparkles size={20} /></div>
            <strong>Que puis-je faire pour vous ?</strong>
            <span>
              En mode Agent, je lis et modifie les fichiers du dossier ouvert et j'exécute des commandes.
            </span>
            {!providerReady && (
              <div className="agent-setup-msg">
                <Key size={14} />
                Aucune clé API pour {currentProvider?.name ?? 'le fournisseur sélectionné'}.
                <button className="link-btn" onClick={() => openKeyEditor(currentProvider?.id ?? keyProvider)}>
                  En ajouter une
                </button>
              </div>
            )}
            {!workspace && (
              <div className="agent-setup-msg">
                <Wrench size={14} /> Ouvre un dossier pour activer le mode Agent.
              </div>
            )}
            <div className="agent-suggestions">
              <button onClick={() => setInput('Explique la structure de ce projet.')}>Structure du projet</button>
              <button onClick={() => setInput('Analyse le projet et corrige les erreurs.')}>Analyser et corriger</button>
              <button onClick={() => setInput('Crée un site moderne sur les sushis.')}>Créer un site</button>
            </div>
          </div>
        )}

        {entries.map(entry => (
          <div key={entry.id} className={`agent-msg ${entry.role}${entry.error ? ' failed' : ''}`}>
            <div className="agent-msg-label">{entry.role === 'user' ? 'Vous' : 'Assistant'}</div>
            {entry.activities && <ActivityList activities={entry.activities} />}
            <div className="agent-msg-content"><MessageBody content={entry.content} /></div>
          </div>
        ))}

        {busy && (
          <div className="agent-msg assistant">
            <div className="agent-msg-label">Assistant</div>
            <ActivityList activities={activities} />
            {statusText && (
              <div className="agent-progress"><Loader2 size={11} className="spin" /> {statusText}</div>
            )}
            {streamText && (
              <div className="agent-msg-content streaming">
                <MessageBody content={streamText} />
                <span className="cursor-blink">▊</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="agent-composer">
        <textarea
          ref={inputRef}
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={
            !providerReady ? 'Configure une clé API pour commencer'
              : mode === 'agent' ? 'Décris la tâche à réaliser...'
                : 'Pose une question...'
          }
          disabled={composerDisabled}
          rows={2}
        />
        <div className="c-footer">
          <span className="c-footer-model">
            {currentModel?.label ?? 'aucun modèle'} · {MODE_LABEL[mode]}
            {workspace ? '' : ' · aucun dossier'}
          </span>
          <div className="c-footer-actions">
            {busy ? (
              <button className="btn-send stop" onClick={stop} title="Arrêter"><StopCircle size={14} /></button>
            ) : (
              <button
                className="btn-send"
                onClick={() => void send()}
                disabled={composerDisabled || input.trim().length === 0}
                title="Envoyer"
              >
                <CornerDownLeft size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}
