import type { AgentMode, ChatEntry, Conversation } from '../shared/types'

/**
 * Conversation persistence.
 *
 * Stored in localStorage rather than on disk: conversations are renderer-owned
 * UI state, and routing them through IPC would mean a main-process schema and a
 * migration path for something the user can lose without consequence.
 */
const STORAGE_KEY = 'cursor-clone.conversations'
const MAX_CONVERSATIONS = 80
const TITLE_MAX = 52

export function newConversationId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Derives a readable title from the first user message. */
export function titleFromEntries(entries: ChatEntry[]): string {
  const first = entries.find(entry => entry.role === 'user')
  if (!first) return 'Nouvelle conversation'
  const flat = first.content.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return 'Nouvelle conversation'
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`
}

export function createConversation(mode: AgentMode): Conversation {
  const now = Date.now()
  return {
    id: newConversationId(),
    title: 'Nouvelle conversation',
    createdAt: now,
    updatedAt: now,
    mode,
    entries: [],
  }
}

function isChatEntry(value: unknown): value is ChatEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && (entry.role === 'user' || entry.role === 'assistant')
    && typeof entry.content === 'string'
}

/** Defensive: a hand-edited or half-written store must not crash the app. */
function isConversation(value: unknown): value is Conversation {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
    && (record.mode === 'chat' || record.mode === 'agent')
    && Array.isArray(record.entries)
    && record.entries.every(isChatEntry)
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isConversation).slice(0, MAX_CONVERSATIONS)
  } catch {
    return []
  }
}

export function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS)),
    )
  } catch {
    // Quota exceeded or storage disabled: conversations stay in memory only.
  }
}

/** Groups by recency for the sidebar headings. */
export function groupConversations(
  conversations: Conversation[],
): Array<{ label: string; items: Conversation[] }> {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const startOfWeek = startOfToday - 6 * 86_400_000

  const buckets: Array<{ label: string; items: Conversation[] }> = [
    { label: "Aujourd'hui", items: [] },
    { label: 'Hier', items: [] },
    { label: '7 derniers jours', items: [] },
    { label: 'Plus ancien', items: [] },
  ]

  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (conversation.updatedAt >= startOfToday) buckets[0].items.push(conversation)
    else if (conversation.updatedAt >= startOfYesterday) buckets[1].items.push(conversation)
    else if (conversation.updatedAt >= startOfWeek) buckets[2].items.push(conversation)
    else buckets[3].items.push(conversation)
  }

  return buckets.filter(bucket => bucket.items.length > 0)
}
