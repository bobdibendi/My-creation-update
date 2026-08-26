import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Check, Copy, CornerDownLeft, Pencil, RefreshCw, TriangleAlert, X,
} from 'lucide-react'
import type { ChatEntry } from '../shared/types'
import { ActivityList } from './AgentTimeline'
import { IconButton, Markdown, Textarea, Tooltip, copyText } from './ui'
import { messageIn } from '../animations'
import { cx } from './ui/cx'

interface Props {
  entry: ChatEntry
  /** Only the newest assistant turn may be regenerated. */
  canRegenerate: boolean
  busy: boolean
  describeArgs: (args: unknown) => string
  onEdit: (id: string, content: string) => void
  onRegenerate: () => void
}

/**
 * One chat turn.
 *
 * User turns are editable in place: submitting replaces the message and
 * discards everything after it, which is the only coherent way to rewind a
 * conversation whose later turns depended on the edited text.
 */
export function ChatMessage({
  entry, canRegenerate, busy, describeArgs, onEdit, onRegenerate,
}: Props) {
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.content)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) return
    setDraft(entry.content)
    const timer = window.setTimeout(() => {
      const area = areaRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    }, 20)
    return () => window.clearTimeout(timer)
  }, [editing, entry.content])

  const copy = useCallback(async () => {
    if (!(await copyText(entry.content))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [entry.content])

  const submitEdit = useCallback(() => {
    const value = draft.trim()
    setEditing(false)
    if (value.length === 0 || value === entry.content) return
    onEdit(entry.id, value)
  }, [draft, entry.content, entry.id, onEdit])

  const isUser = entry.role === 'user'

  return (
    <motion.article
      className={cx('msg', isUser ? 'msg--user' : 'msg--assistant', entry.error && 'msg--error')}
      variants={messageIn}
      initial="hidden"
      animate="visible"
      layout="position"
    >
      <div className="msg__gutter">
        <span className={cx('msg__avatar', isUser ? 'is-user' : 'is-assistant')} aria-hidden>
          {isUser ? 'A' : (
            <svg viewBox="0 0 24 24" width="13" height="13">
              <path d="M12 3.4 20.6 12 12 20.6 3.4 12Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </div>

      <div className="msg__main">
        <header className="msg__head">
          <span className="msg__role">{isUser ? 'Vous' : 'Assistant'}</span>
          {entry.error && (
            <span className="msg__flag"><TriangleAlert size={11} /> échec</span>
          )}
          <span className="msg__spacer" />
          <div className="msg__tools">
            <Tooltip content={copied ? 'Copié' : 'Copier'} side="top">
              <button
                type="button"
                className={cx('msg__tool', copied && 'is-done')}
                onClick={() => void copy()}
                aria-label="Copier le message"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            </Tooltip>
            {isUser && !editing && (
              <Tooltip content="Modifier et renvoyer" side="top">
                <button
                  type="button"
                  className="msg__tool"
                  onClick={() => setEditing(true)}
                  disabled={busy}
                  aria-label="Modifier le message"
                >
                  <Pencil size={12} />
                </button>
              </Tooltip>
            )}
            {!isUser && canRegenerate && (
              <Tooltip content="Régénérer" side="top">
                <button
                  type="button"
                  className="msg__tool"
                  onClick={onRegenerate}
                  disabled={busy}
                  aria-label="Régénérer la réponse"
                >
                  <RefreshCw size={12} />
                </button>
              </Tooltip>
            )}
          </div>
        </header>

        {entry.activities && entry.activities.length > 0 && (
          <ActivityList activities={entry.activities} describe={describeArgs} />
        )}

        {editing ? (
          <div className="msg__editor">
            <Textarea
              ref={areaRef}
              value={draft}
              rows={Math.min(14, Math.max(3, draft.split('\n').length + 1))}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submitEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                }
              }}
            />
            <div className="msg__editor-actions">
              <IconButton label="Annuler" icon={<X size={13} />} onClick={() => setEditing(false)} />
              <IconButton
                label="Renvoyer"
                variant="primary"
                icon={<CornerDownLeft size={13} />}
                onClick={submitEdit}
                disabled={draft.trim().length === 0}
              />
            </div>
          </div>
        ) : (
          <Markdown content={entry.content} className="msg__body" />
        )}
      </div>
    </motion.article>
  )
}
