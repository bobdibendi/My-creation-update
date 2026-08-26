import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMode, ChatEntry, Conversation } from '../shared/types'
import {
  createConversation, groupConversations, loadConversations, saveConversations, titleFromEntries,
} from '../shared/conversations'

/**
 * Conversation list state.
 *
 * The active conversation is the single source of truth for the transcript, so
 * switching threads in the sidebar cannot desynchronise from what the assistant
 * panel is showing.
 */
export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  const [activeId, setActiveId] = useState<string>(() => conversations[0]?.id ?? '')
  const [query, setQuery] = useState('')
  /** Debounce handle so typing a long prompt does not hit storage per keystroke. */
  const writeTimer = useRef<number | null>(null)

  useEffect(() => {
    if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    writeTimer.current = window.setTimeout(() => saveConversations(conversations), 400)
    return () => {
      if (writeTimer.current !== null) window.clearTimeout(writeTimer.current)
    }
  }, [conversations])

  // Flush before the window goes away: the debounce would otherwise lose the tail.
  useEffect(() => {
    const flush = () => saveConversations(conversations)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [conversations])

  const active = useMemo(
    () => conversations.find(conversation => conversation.id === activeId) ?? null,
    [conversations, activeId],
  )

  const startNew = useCallback((mode: AgentMode) => {
    const conversation = createConversation(mode)
    setConversations(previous => [conversation, ...previous])
    setActiveId(conversation.id)
    return conversation.id
  }, [])

  /** Ensures a conversation exists to receive entries, creating one if needed. */
  const ensureActive = useCallback((mode: AgentMode): string => {
    let id = ''
    setConversations(previous => {
      const existing = previous.find(conversation => conversation.id === activeId)
      if (existing) {
        id = existing.id
        return previous
      }
      const conversation = createConversation(mode)
      id = conversation.id
      return [conversation, ...previous]
    })
    if (id && id !== activeId) setActiveId(id)
    return id || activeId
  }, [activeId])

  const setEntries = useCallback((id: string, update: (entries: ChatEntry[]) => ChatEntry[]) => {
    setConversations(previous => previous.map(conversation => {
      if (conversation.id !== id) return conversation
      const entries = update(conversation.entries)
      return {
        ...conversation,
        entries,
        // Keep the derived title until the user renames it explicitly.
        title: conversation.title === 'Nouvelle conversation' ? titleFromEntries(entries) : conversation.title,
        updatedAt: Date.now(),
      }
    }))
  }, [])

  const setMode = useCallback((id: string, mode: AgentMode) => {
    setConversations(previous => previous.map(conversation =>
      (conversation.id === id ? { ...conversation, mode } : conversation)))
  }, [])

  const rename = useCallback((id: string, title: string) => {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    setConversations(previous => previous.map(conversation =>
      (conversation.id === id ? { ...conversation, title: trimmed } : conversation)))
  }, [])

  const remove = useCallback((id: string) => {
    setConversations(previous => {
      const index = previous.findIndex(conversation => conversation.id === id)
      const next = previous.filter(conversation => conversation.id !== id)
      setActiveId(current => {
        if (current !== id) return current
        return (next[index] ?? next[index - 1] ?? next[0])?.id ?? ''
      })
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    setConversations([])
    setActiveId('')
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return conversations
    return conversations.filter(conversation =>
      conversation.title.toLowerCase().includes(needle)
      || conversation.entries.some(entry => entry.content.toLowerCase().includes(needle)))
  }, [conversations, query])

  const groups = useMemo(() => groupConversations(filtered), [filtered])

  return {
    conversations,
    filtered,
    groups,
    active,
    activeId,
    query,
    setQuery,
    select: setActiveId,
    startNew,
    ensureActive,
    setEntries,
    setMode,
    rename,
    remove,
    clearAll,
  }
}
