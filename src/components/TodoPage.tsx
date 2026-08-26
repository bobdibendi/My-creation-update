import { useCallback, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Check, CircleDashed, Clock3, ListTodo, Loader2, Plus, ShieldAlert,
  Sparkle, Trash2, Undo2,
} from 'lucide-react'
import type { Task, TaskPriority } from '../shared/types'
import { useI18n } from '../i18n'
import { useToast } from './ui'
import { staggerContainer, riseIn } from '../animations'
import { cx } from './ui/cx'

interface Props {
  tasks: {
    grouped: {
      todo: Task[]
      inProgress: Task[]
      blocked: Task[]
      completed: Task[]
    }
    counts: { total: number; open: number; done: number }
    activeTask: Task | null
    addTask(input: { title: string }): Promise<unknown>
    setStatus(id: string, status: 'todo' | 'in_progress' | 'completed' | 'blocked', reason?: string | null): Promise<void>
    completeTask(id: string): Promise<void>
    removeTask(id: string): Promise<void>
    undoLast(): Promise<boolean>
    canUndo(): boolean
    clearCompleted(): Promise<void>
    loaded: boolean
  }
}

const PRIORITY_META: Record<TaskPriority, { icon: string; tone: string }> = {
  low: { icon: '○', tone: 'todo-priority--low' },
  medium: { icon: '', tone: '' },
  high: { icon: '!', tone: 'todo-priority--high' },
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Page Todo — sections À faire / En cours / Bloquées / Terminées.
 * Les mutations passent par le store (useTasks) : la liste est reçue du main
 * process via l'événement temps réel, donc les changements de l'IA apparaissent
 * ici sans rechargement.
 */
export function TodoPage({ tasks }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const [draft, setDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [showCompleted, setShowCompleted] = useState(true)

  const submitDraft = useCallback(async (): Promise<void> => {
    const title = draft.trim()
    if (title.length === 0) return
    setDraft('')
    await tasks.addTask({ title })
  }, [draft, tasks])

  const guard = useCallback(async (id: string, action: () => Promise<void>): Promise<void> => {
    setBusyId(id)
    await action()
    setBusyId(null)
  }, [])

  const runWithUndo = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    await action()
    if (tasks.canUndo()) {
      toast.notify({
        title: t('todo.title'),
        tone: 'accent',
        duration: 6000,
        action: { label: t('todo.undo'), onClick: () => { void tasks.undoLast() } },
      })
    }
  }, [tasks, t, toast])

  const renderRow = (task: Task, section: 'todo' | 'inProgress' | 'blocked' | 'completed') => {
    const busy = busyId === task.id
    const priority = PRIORITY_META[task.priority]
    return (
      <motion.li
        key={task.id}
        className={cx('todo-row', `is-${section}`, task.id === tasks.activeTask?.id && 'is-active')}
        variants={riseIn}
        layout
      >
        <button
          type="button"
          className="todo-row__toggle"
          disabled={busy}
          aria-label={section === 'completed' ? t('todo.reopen') : t('todo.markComplete')}
          title={section === 'completed' ? t('todo.reopen') : t('todo.markComplete')}
          onClick={() => void guard(task.id, () =>
            section === 'completed' ? tasks.setStatus(task.id, 'todo') : tasks.completeTask(task.id))}
        >
          {busy
            ? <Loader2 size={15} className="spin" aria-hidden />
            : section === 'completed'
              ? <Check size={15} aria-hidden />
              : section === 'inProgress'
                ? <Clock3 size={15} className="todo-row__running" aria-hidden />
                : section === 'blocked'
                  ? <ShieldAlert size={15} aria-hidden />
                  : <CircleDashed size={15} aria-hidden />}
        </button>

        <div className="todo-row__body">
          <span className="todo-row__title">
            {priority.icon && <em className={cx('todo-priority', priority.tone)}>{priority.icon}</em>}
            {task.title}
            {task.source === 'ai' && (
              <span className="todo-row__ai" title={t('todo.createdByAi')}>
                <Sparkle size={10} aria-hidden /> {t('todo.createdByAi')}
              </span>
            )}
          </span>
          {task.description && <span className="todo-row__desc">{task.description}</span>}
          {task.status === 'blocked' && task.blockedReason && (
            <span className="todo-row__reason"><ShieldAlert size={11} aria-hidden /> {task.blockedReason}</span>
          )}
          {task.status === 'completed' && task.completedAt && (
            <span className="todo-row__date">{t('todo.completedAt', { date: formatDate(task.completedAt) })}</span>
          )}
        </div>

        <div className="todo-row__actions">
          {section !== 'completed' && section !== 'inProgress' && (
            <button
              type="button"
              className="icon-btn"
              title={t('todo.startTask')}
              aria-label={t('todo.startTask')}
              onClick={() => void guard(task.id, () => tasks.setStatus(task.id, 'in_progress'))}
            >
              <Clock3 size={13} />
            </button>
          )}
          {section !== 'completed' && (
            <button
              type="button"
              className="icon-btn"
              title={t('todo.block')}
              aria-label={t('todo.block')}
              onClick={() => void guard(task.id, () => tasks.setStatus(task.id, 'blocked'))}
            >
              <ShieldAlert size={13} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn is-danger"
            title={t('todo.deleteTask')}
            aria-label={t('todo.deleteTask')}
            onClick={() => void runWithUndo(() => tasks.removeTask(task.id))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </motion.li>
    )
  }

  return (
    <div className="todo-page">
      <motion.header
        className="page-head"
        variants={staggerContainer(0.05)}
        initial="hidden"
        animate="visible"
      >
        <motion.h1 variants={riseIn}>{t('todo.title')}</motion.h1>
        <motion.p variants={riseIn}>{t('todo.subtitle')}</motion.p>
      </motion.header>

      <form
        className="todo-composer"
        onSubmit={event => { event.preventDefault(); void submitDraft() }}
      >
        <Plus size={15} aria-hidden />
        <input
          value={draft}
          placeholder={t('todo.addPlaceholder')}
          aria-label={t('todo.addPlaceholder')}
          onChange={event => setDraft(event.target.value)}
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={draft.trim().length === 0}>
          {t('todo.addButton')}
        </button>
      </form>

      <div className="todo-columns">
        <section className="todo-section" aria-label={t('todo.sectionInProgress')}>
          <h2><Clock3 size={13} aria-hidden /> {t('todo.sectionInProgress')} <span>{tasks.grouped.inProgress.length}</span></h2>
          <ul>
            {tasks.grouped.inProgress.map(task => renderRow(task, 'inProgress'))}
            {tasks.grouped.inProgress.length === 0 && <li className="todo-empty-hint">—</li>}
          </ul>
        </section>

        <section className="todo-section" aria-label={t('todo.sectionBlocked')}>
          <h2><ShieldAlert size={13} aria-hidden /> {t('todo.sectionBlocked')} <span>{tasks.grouped.blocked.length}</span></h2>
          <ul>
            {tasks.grouped.blocked.map(task => renderRow(task, 'blocked'))}
            {tasks.grouped.blocked.length === 0 && <li className="todo-empty-hint">—</li>}
          </ul>
        </section>

        <section className="todo-section todo-section--wide" aria-label={t('todo.sectionTodo')}>
          <h2><ListTodo size={13} aria-hidden /> {t('todo.sectionTodo')} <span>{tasks.grouped.todo.length}</span></h2>
          {tasks.grouped.todo.length === 0 && tasks.counts.total === 0 && (
            <p className="todo-page__empty">{t('todo.empty')}</p>
          )}
          <ul>
            {tasks.grouped.todo.map(task => renderRow(task, 'todo'))}
          </ul>
        </section>

        <section className={cx('todo-section todo-section--wide', !showCompleted && 'is-collapsed')} aria-label={t('todo.sectionCompleted')}>
          <h2>
            <button type="button" className="todo-section__toggle" onClick={() => setShowCompleted(current => !current)}>
              <Check size={13} aria-hidden /> {t('todo.sectionCompleted')}
              <span>{tasks.grouped.completed.length}</span>
            </button>
            {tasks.grouped.completed.length > 0 && (
              <button type="button" className="link-btn" onClick={() => void tasks.clearCompleted()}>
                {t('todo.clearCompleted')}
              </button>
            )}
          </h2>
          {showCompleted && (
            <ul>
              {tasks.grouped.completed.map(task => renderRow(task, 'completed'))}
            </ul>
          )}
        </section>
      </div>

      <footer className="todo-footer">
        <span>{t('todo.progressLabel', { done: tasks.counts.done, total: tasks.counts.total })}</span>
        <button
          type="button"
          className="link-btn"
          disabled={!tasks.canUndo()}
          onClick={() => void runWithUndo(() => tasks.undoLast())}
        >
          <Undo2 size={12} aria-hidden /> {t('todo.undo')}
        </button>
      </footer>
    </div>
  )
}
