import { useCallback, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  MessageSquare, MoreHorizontal, PenLine, Plus, Search, Trash2, Zap,
} from 'lucide-react'
import type { Conversation } from '../shared/types'
import { Sidebar } from '../layout'
import {
  Badge, ContextMenu, EmptyState, IconButton, Input, Tooltip, type MenuEntry,
} from './ui'
import { listItem, staggerContainer } from '../animations'
import { cx } from './ui/cx'
import { shortcutFor } from '../shared/shortcuts'

interface Props {
  groups: Array<{ label: string; items: Conversation[] }>
  activeId: string
  query: string
  total: number
  onQueryChange: (value: string) => void
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onRemove: (id: string) => void
  onClearAll: () => void
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  const minutes = Math.round(delta / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${hours} h`
  const days = Math.round(hours / 24)
  if (days < 7) return `il y a ${days} j`
  return new Date(timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

/** Claude-style conversation list with search, rename and delete. */
export function ConversationList({
  groups, activeId, query, total, onQueryChange, onSelect, onNew,
  onRename, onRemove, onClearAll,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; conversation: Conversation } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const submitRename = useCallback((id: string) => {
    const value = draft.trim()
    setRenaming(null)
    if (value.length > 0) onRename(id, value)
  }, [draft, onRename])

  const menuEntries = useMemo<MenuEntry[]>(() => {
    if (!menu) return []
    return [
      {
        id: 'rename',
        label: 'Renommer',
        icon: <PenLine size={13} />,
        onSelect: () => {
          setDraft(menu.conversation.title)
          setRenaming(menu.conversation.id)
        },
      },
      { id: 'sep', separator: true },
      {
        id: 'delete',
        label: 'Supprimer',
        icon: <Trash2 size={13} />,
        danger: true,
        onSelect: () => onRemove(menu.conversation.id),
      },
    ]
  }, [menu, onRemove])

  return (
    <Sidebar
      title="Conversations"
      actions={
        total > 0 ? (
          <Tooltip content="Tout supprimer" side="bottom">
            <IconButton
              label="Supprimer toutes les conversations"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={onClearAll}
            />
          </Tooltip>
        ) : undefined
      }
      toolbar={
        <>
          <motion.button
            type="button"
            className="conv__new"
            onClick={onNew}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.985 }}
          >
            <Plus size={14} />
            Nouveau chat
            <kbd>{shortcutFor('new-chat')}</kbd>
          </motion.button>
          <Input
            size="sm"
            icon={<Search size={12} />}
            value={query}
            placeholder="Rechercher une conversation"
            aria-label="Rechercher une conversation"
            onChange={event => onQueryChange(event.target.value)}
          />
        </>
      }
    >
      {groups.length === 0 && (
        <EmptyState
          icon={<MessageSquare size={22} />}
          title={query ? 'Aucun résultat' : 'Aucune conversation'}
          description={query
            ? 'Essaie un autre terme de recherche.'
            : 'Démarre une conversation pour la retrouver ici.'}
          compact
        />
      )}

      <AnimatePresence initial={false}>
        {groups.map(group => (
          <motion.div
            className="conv__group"
            key={group.label}
            variants={staggerContainer(0.02)}
            initial="hidden"
            animate="visible"
          >
            <div className="conv__group-head">{group.label}</div>
            {group.items.map(conversation => {
              const active = conversation.id === activeId
              const preview = conversation.entries[conversation.entries.length - 1]?.content ?? ''
              return (
                <motion.div
                  key={conversation.id}
                  className={cx('conv__item', active && 'is-active')}
                  variants={listItem}
                  onClick={() => onSelect(conversation.id)}
                  onContextMenu={event => {
                    event.preventDefault()
                    setMenu({ x: event.clientX, y: event.clientY, conversation })
                  }}
                >
                  <span className="conv__item-icon" aria-hidden>
                    {conversation.mode === 'agent' ? <Zap size={12} /> : <MessageSquare size={12} />}
                  </span>

                  <span className="conv__item-main">
                    {renaming === conversation.id ? (
                      <input
                        className="conv__item-input"
                        value={draft}
                        autoFocus
                        aria-label="Nouveau titre"
                        onChange={event => setDraft(event.target.value)}
                        onClick={event => event.stopPropagation()}
                        onBlur={() => submitRename(conversation.id)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') submitRename(conversation.id)
                          if (event.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <span className="conv__item-title" title={conversation.title}>
                        {conversation.title}
                      </span>
                    )}
                    <span className="conv__item-meta">
                      {relativeTime(conversation.updatedAt)}
                      {conversation.entries.length > 0 && ` · ${conversation.entries.length} msg`}
                    </span>
                    {preview.length > 0 && (
                      <span className="conv__item-preview">{preview.slice(0, 90)}</span>
                    )}
                  </span>

                  {active && <Badge tone="accent" size="sm">actif</Badge>}

                  <button
                    type="button"
                    className="conv__item-more"
                    aria-label="Actions de la conversation"
                    onClick={event => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      setMenu({ x: rect.left, y: rect.bottom + 4, conversation })
                    }}
                  >
                    <MoreHorizontal size={13} />
                  </button>
                </motion.div>
              )
            })}
          </motion.div>
        ))}
      </AnimatePresence>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.conversation.title}
          entries={menuEntries}
          onClose={() => setMenu(null)}
        />
      )}
    </Sidebar>
  )
}
