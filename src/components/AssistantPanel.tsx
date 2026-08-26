import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Bot, Check, ChevronDown, CornerDownLeft, Key, MessageSquare, Paperclip, Plus,
  Settings, Sparkles, Square, Trash2, TriangleAlert, Wrench, X, Zap,
} from 'lucide-react'
import type { AgentMode, ChatEntry } from '../shared/types'
import { describeArgs, useAssistant } from '../hooks/useAssistant'
import { AgentTimeline } from './AgentTimeline'
import { ChatMessage } from './ChatMessage'
import {
  Badge, Dropdown, IconButton, Input, Markdown, MenuButton, MenuGroup,
  ScrollArea, StatusDot, Tooltip,
} from './ui'
import { fade, riseIn, staggerContainer, transitions } from '../animations'
import { cx } from './ui/cx'

interface Props {
  workspace: string | null
  activeFilePath: string
  activeFileContent: string
  sendFileContents: boolean
  mode: AgentMode
  /** Session token forwarded so the main process can account quota usage. */
  sessionToken?: string | null
  onModeChange: (mode: AgentMode) => void
  entries: ChatEntry[]
  onEntriesChange: (update: (entries: ChatEntry[]) => ChatEntry[]) => void
  conversationTitle: string
  onClose: () => void
  onNewConversation: () => void
  onClearConversation: () => void
  onOpenSettings: () => void
  /** Prompt injected from outside, e.g. a home screen card. */
  pendingPrompt: string
  onPendingPromptConsumed: () => void
  /** Reports streaming state so the shell can show a live indicator. */
  onBusyChange?: (busy: boolean) => void
}

const MODE_LABEL: Record<AgentMode, string> = { chat: 'Chat', agent: 'Agent' }
const MODE_HINT: Record<AgentMode, string> = {
  chat: 'Répond sans toucher aux fichiers.',
  agent: 'Lit, écrit et exécute dans le dossier ouvert.',
}

const SUGGESTIONS = [
  'Explique la structure de ce projet.',
  'Analyse le projet et corrige les erreurs.',
  'Crée un site moderne sur les sushis.',
  'Ajoute des tests pour le code existant.',
]

/**
 * Assistant panel.
 *
 * Test contract, do not rename: `.agent-panel`, `.agent-topbar .agent-select`,
 * `.model-select-label`, `.agent-composer textarea`, `.agent-suggestions button`.
 * `scripts/test-renderer.cjs` and `scripts/screenshot.cjs` drive the panel
 * through those selectors.
 */
export function AssistantPanel({
  workspace, activeFilePath, activeFileContent, sendFileContents,
  mode, sessionToken, onModeChange, entries, onEntriesChange, conversationTitle,
  onClose, onNewConversation, onClearConversation, onOpenSettings,
  pendingPrompt, onPendingPromptConsumed, onBusyChange,
}: Props) {
  const [input, setInput] = useState('')
  const [openMenu, setOpenMenu] = useState<'mode' | 'model' | 'key' | null>(null)
  const [keyProvider, setKeyProvider] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState('')

  const inputRef = useRef<HTMLTextAreaElement>(null)

  const assistant = useAssistant({
    workspace,
    activeFilePath,
    activeFileContent,
    sendFileContents,
    entries,
    onEntriesChange,
    mode,
    sessionToken,
  })

  const {
    providers, selectedModel, setSelectedModel, currentModel, currentProvider,
    providerReady, agentCapable, keyMasks, busy, statusText, streamText,
    timeline, startedAt, send, stop, regenerate, editAndResend, saveKey, removeKey,
  } = assistant

  useEffect(() => {
    setKeyProvider(previous => previous || providers[0]?.id || '')
  }, [providers])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  // A prompt handed over from the home screen is sent immediately.
  useEffect(() => {
    if (pendingPrompt.length === 0) return
    onPendingPromptConsumed()
    if (busy) {
      setInput(pendingPrompt)
      return
    }
    void send(pendingPrompt)
  }, [pendingPrompt, onPendingPromptConsumed, busy, send])

  const composerDisabled = busy || !providerReady || !selectedModel
  const modeWarning = mode === 'agent' && selectedModel.length > 0 && !agentCapable
    ? `${currentModel?.label ?? selectedModel} ne supporte pas les outils. Choisis un autre modèle pour le mode Agent.`
    : null

  const lastAssistantId = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === 'assistant') return entries[index].id
    }
    return ''
  }, [entries])

  const submit = useCallback(() => {
    const prompt = input.trim()
    if (prompt.length === 0) return
    setInput('')
    void send(prompt)
  }, [input, send])

  const storeKey = useCallback(async () => {
    setKeyError('')
    const ok = await saveKey(keyProvider, keyInput)
    if (!ok) {
      setKeyError('Clé refusée par le fournisseur.')
      return
    }
    setKeyInput('')
    setOpenMenu(null)
  }, [keyProvider, keyInput, saveKey])

  // Revision counter for the scroll pin: any of these growing means new content.
  const revision = entries.length * 1000 + streamText.length + timeline.length

  return (
    <aside className="agent-panel" aria-label="Assistant IA">
      <header className="agent-panel__head">
        <span className="agent-panel__brand">
          <Bot size={15} />
          <span className="agent-panel__title" title={conversationTitle}>
            {conversationTitle || 'Assistant'}
          </span>
        </span>
        <div className="agent-panel__head-actions">
          <Tooltip content="Nouvelle conversation" side="bottom">
            <IconButton label="Nouvelle conversation" size="sm" icon={<Plus size={14} />} onClick={onNewConversation} />
          </Tooltip>
          {entries.length > 0 && (
            <Tooltip content="Effacer la conversation" side="bottom">
              <IconButton
                label="Effacer la conversation"
                size="sm"
                icon={<Trash2 size={13} />}
                onClick={onClearConversation}
              />
            </Tooltip>
          )}
          <IconButton label="Fermer l’assistant" size="sm" icon={<X size={14} />} onClick={onClose} />
        </div>
      </header>

      <div className="agent-topbar">
        <Dropdown
          open={openMenu === 'mode'}
          onClose={() => setOpenMenu(null)}
          width={230}
          trigger={
            <button
              type="button"
              className="agent-select"
              onClick={() => setOpenMenu(current => (current === 'mode' ? null : 'mode'))}
            >
              {mode === 'agent' ? <Zap size={12} /> : <MessageSquare size={12} />}
              <span>{MODE_LABEL[mode]}</span>
              <ChevronDown size={12} />
            </button>
          }
        >
          {(['agent', 'chat'] as const).map(value => (
            <MenuButton
              key={value}
              icon={value === 'agent' ? <Zap size={13} /> : <MessageSquare size={13} />}
              selected={value === mode}
              hint={value === mode ? <Check size={12} /> : undefined}
              onClick={() => {
                onModeChange(value)
                setOpenMenu(null)
              }}
            >
              <span className="agent-menu__stack">
                <strong>{MODE_LABEL[value]}</strong>
                <small>{MODE_HINT[value]}</small>
              </span>
            </MenuButton>
          ))}
        </Dropdown>

        <Dropdown
          open={openMenu === 'model'}
          onClose={() => setOpenMenu(null)}
          align="end"
          width={288}
          className="agent-topbar__model"
          trigger={
            <button
              type="button"
              className="agent-select agent-select--model"
              onClick={() => setOpenMenu(current => (current === 'model' ? null : 'model'))}
            >
              <StatusDot tone={providerReady ? 'success' : 'warning'} size={6} />
              <span className="model-select-label">{currentModel?.label ?? 'Aucun modèle'}</span>
              <ChevronDown size={12} />
            </button>
          }
        >
          {providers.map(provider => (
            <MenuGroup
              key={provider.id}
              label={provider.name}
              aside={
                provider.tier === 'free'
                  ? <Badge tone="success" size="sm">INCLUS</Badge>
                  : <Badge tone={provider.configured ? 'success' : 'warning'} size="sm">
                      {provider.configured ? 'clé OK' : 'clé absente'}
                    </Badge>
              }
            >
              {provider.models.map(model => (
                <MenuButton
                  key={model.id}
                  selected={model.id === selectedModel}
                  hint={model.supportsTools ? 'outils' : 'chat'}
                  onClick={() => {
                    setSelectedModel(model.id)
                    setOpenMenu(null)
                  }}
                >
                  {model.label}
                </MenuButton>
              ))}
            </MenuGroup>
          ))}
          {providers.length === 0 && <div className="ui-menu__empty">Aucun modèle disponible</div>}
        </Dropdown>

        <Dropdown
          open={openMenu === 'key'}
          onClose={() => setOpenMenu(null)}
          align="end"
          width={300}
          trigger={
            <button
              type="button"
              className={cx('agent-key', providerReady && 'is-ready')}
              onClick={() => setOpenMenu(current => (current === 'key' ? null : 'key'))}
              aria-label="Gérer les clés API"
              title="Gérer les clés API"
            >
              <Key size={12} />
            </button>
          }
        >
          <div className="ui-menu__label">Clés API</div>
          {/* Les modèles intégrés (Kim Pro, Ox Alpha Free) sont gérés par
              My Creation : aucune clé utilisateur n'existe ni ne s'affiche.
              Ce menu liste uniquement les fournisseurs à clé personnelle. */}
          {providers.filter(provider => provider.tier === 'premium').map(provider => (
            <div className="agent-key__row" key={provider.id}>
              <div className="agent-key__row-head">
                <span>{provider.name}</span>
                <Badge tone={provider.configured ? 'success' : 'warning'} size="sm">
                  {provider.configured ? 'configurée' : 'absente'}
                </Badge>
              </div>
              {provider.configured ? (
                <div className="agent-key__row-body">
                  <code>{keyMasks[provider.id] ?? '••••'}</code>
                  <button type="button" onClick={() => setKeyProvider(provider.id)}>Remplacer</button>
                  <button type="button" className="is-danger" onClick={() => void removeKey(provider.id)}>
                    Retirer
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="agent-key__add"
                  onClick={() => setKeyProvider(provider.id)}
                >
                  <Plus size={11} /> Ajouter la clé
                </button>
              )}
            </div>
          ))}
          {providers.every(provider => provider.tier !== 'premium') && (
            <div className="ui-menu__empty">Aucune clé personnelle requise.</div>
          )}

          {keyProvider && (
            <div className="agent-key__form">
              <Input
                type="password"
                value={keyInput}
                placeholder={`Clé API ${keyProvider}`}
                onChange={event => setKeyInput(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void storeKey() }}
                invalid={keyError.length > 0}
              />
              <button type="button" className="agent-key__save" onClick={() => void storeKey()}>
                Enregistrer
              </button>
            </div>
          )}
          {keyError && <div className="agent-key__error">{keyError}</div>}

          <div className="ui-menu__sep" />
          <MenuButton
            icon={<Settings size={13} />}
            onClick={() => {
              setOpenMenu(null)
              onOpenSettings()
            }}
          >
            Tous les paramètres
          </MenuButton>
        </Dropdown>
      </div>

      <AnimatePresence>
        {modeWarning && (
          <motion.div
            className="agent-warning"
            variants={fade}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <TriangleAlert size={12} />
            {modeWarning}
          </motion.div>
        )}
      </AnimatePresence>

      <ScrollArea className="agent-body" stickToBottom revision={revision}>
        <div className="agent-thread">
          {entries.length === 0 && !busy && (
            <motion.div
              className="agent-welcome"
              variants={staggerContainer(0.05)}
              initial="hidden"
              animate="visible"
            >
              <motion.span className="agent-welcome__mark" variants={riseIn} aria-hidden>
                <Sparkles size={20} />
              </motion.span>
              <motion.strong className="agent-welcome__title" variants={riseIn}>
                Que puis-je faire pour vous ?
              </motion.strong>
              <motion.p className="agent-welcome__text" variants={riseIn}>
                En mode Agent, je lis et modifie les fichiers du dossier ouvert et j’exécute
                des commandes. En mode Chat, je réponds sans rien toucher.
              </motion.p>

              {!providerReady && (
                <motion.div className="agent-welcome__notice" variants={riseIn}>
                  <Key size={13} />
                  Aucune clé API pour {currentProvider?.name ?? 'le fournisseur sélectionné'}.
                  <button type="button" onClick={() => setOpenMenu('key')}>En ajouter une</button>
                </motion.div>
              )}
              {!workspace && (
                <motion.div className="agent-welcome__notice" variants={riseIn}>
                  <Wrench size={13} /> Ouvre un dossier pour activer le mode Agent.
                </motion.div>
              )}

              <motion.div className="agent-suggestions" variants={riseIn}>
                {SUGGESTIONS.map(suggestion => (
                  <button key={suggestion} type="button" onClick={() => setInput(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </motion.div>
            </motion.div>
          )}

          <AnimatePresence initial={false}>
            {entries.map(entry => (
              <ChatMessage
                key={entry.id}
                entry={entry}
                busy={busy}
                canRegenerate={entry.id === lastAssistantId && !entry.error}
                describeArgs={describeArgs}
                onEdit={editAndResend}
                onRegenerate={regenerate}
              />
            ))}
          </AnimatePresence>

          {busy && (
            <motion.div
              className="msg msg--assistant is-live"
              variants={riseIn}
              initial="hidden"
              animate="visible"
            >
              <div className="msg__gutter">
                <motion.span
                  className="msg__avatar is-assistant is-thinking"
                  aria-hidden
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13">
                    <path d="M12 3.4 20.6 12 12 20.6 3.4 12Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                  </svg>
                </motion.span>
              </div>
              <div className="msg__main">
                <AgentTimeline
                  steps={timeline}
                  statusText={statusText}
                  startedAt={startedAt}
                  running={busy}
                />
                {streamText.length > 0
                  ? (busy
                    // Pendant le stream : texte BRUT. Re-parser tout le
                    // markdown à chaque frame saturait le renderer sur les
                    // longues réponses (crash 10-20 s).
                    ? <div className="msg__body msg__body--raw">{streamText}</div>
                    : <Markdown content={streamText} className="msg__body" streaming />)
                  : timeline.length === 0 && <ThinkingDots label={statusText} />}
              </div>
            </motion.div>
          )}
        </div>
      </ScrollArea>

      <div className="agent-composer">
        {activeFilePath && sendFileContents && (
          <div className="agent-composer__context">
            <Paperclip size={11} />
            <span title={activeFilePath}>{activeFilePath.split(/[\\/]/).pop()}</span>
          </div>
        )}

        <textarea
          ref={inputRef}
          value={input}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={
            !providerReady ? 'Configure une clé API pour commencer'
              : mode === 'agent' ? 'Décris la tâche à réaliser…'
                : 'Pose une question…'
          }
          disabled={composerDisabled}
          rows={2}
          aria-label="Message pour l’assistant"
        />

        <div className="agent-composer__foot">
          <span className="agent-composer__meta">
            {currentModel?.label ?? 'aucun modèle'} · {MODE_LABEL[mode]}
            {workspace ? '' : ' · aucun dossier'}
          </span>
          {busy ? (
            <motion.button
              type="button"
              className="agent-send is-stop"
              onClick={stop}
              aria-label="Arrêter la génération"
              title="Arrêter"
              whileTap={{ scale: 0.94 }}
            >
              <Square size={13} />
            </motion.button>
          ) : (
            <motion.button
              type="button"
              className="agent-send"
              onClick={submit}
              disabled={composerDisabled || input.trim().length === 0}
              aria-label="Envoyer le message"
              title="Envoyer"
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.94 }}
            >
              <CornerDownLeft size={15} />
            </motion.button>
          )}
        </div>
      </div>
    </aside>
  )
}

/** Three-dot "thinking" affordance shown before the first token arrives. */function ThinkingDots({ label }: { label: string }) {
  return (
    <div className="thinking">
      <span className="thinking__dots" aria-hidden>
        {[0, 1, 2].map(index => (
          <motion.span
            key={index}
            animate={{ opacity: [0.25, 1, 0.25], y: [0, -3, 0] }}
            transition={{
              duration: 1.05,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: index * 0.16,
            }}
          />
        ))}
      </span>
      <motion.span
        className="thinking__label"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={transitions.fast}
      >
        {label || 'Réflexion'}
      </motion.span>
    </div>
  )
}
