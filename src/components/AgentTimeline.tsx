import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Loader2, TriangleAlert } from 'lucide-react'
import type { TimelineStep } from '../hooks/useAssistant'
import { Progress, StatusDot } from './ui'
import { collapse, listItem, staggerContainer } from '../animations'
import { cx } from './ui/cx'

interface Props {
  steps: TimelineStep[]
  statusText: string
  startedAt: number | null
  running: boolean
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} min ${seconds.toString().padStart(2, '0')} s`
}

/**
 * Live agent activity, Claude Code style.
 *
 * The elapsed counter ticks locally instead of being pushed from the main
 * process: a 250 ms interval in the renderer is cheaper than an IPC message at
 * the same rate, and the value only ever feeds this display.
 */
export function AgentTimeline({ steps, statusText, startedAt, running }: Props) {
  const [elapsed, setElapsed] = useState(0)
  const [expanded, setExpanded] = useState(true)

  useEffect(() => {
    if (!running || startedAt === null) {
      setElapsed(0)
      return
    }
    setElapsed(Date.now() - startedAt)
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 250)
    return () => window.clearInterval(timer)
  }, [running, startedAt])

  if (steps.length === 0 && statusText.length === 0) return null

  const toolSteps = steps.filter(step => step.kind === 'tool')
  const done = toolSteps.filter(step => step.status !== 'running').length
  const failed = toolSteps.filter(step => step.status === 'error').length
  const ratio = toolSteps.length > 0 ? done / toolSteps.length : undefined

  return (
    <div className={cx('timeline', running && 'is-running')}>
      <button
        type="button"
        className="timeline__head"
        onClick={() => setExpanded(current => !current)}
        aria-expanded={expanded}
      >
        <StatusDot tone={failed > 0 ? 'danger' : running ? 'accent' : 'success'} pulse={running} />
        <span className="timeline__title">
          {running ? statusText || 'Traitement' : 'Séquence terminée'}
        </span>
        <span className="timeline__meta">
          {toolSteps.length > 0 && (
            <span>{done}/{toolSteps.length} action{toolSteps.length > 1 ? 's' : ''}</span>
          )}
          {startedAt !== null && <span>{formatDuration(elapsed)}</span>}
          {failed > 0 && <span className="timeline__meta-fail">{failed} échec(s)</span>}
        </span>
        <ChevronDown
          size={13}
          className={cx('timeline__chev', expanded && 'is-open')}
        />
      </button>

      {running && <Progress value={ratio} tone={failed > 0 ? 'warning' : 'accent'} label="Progression de l’agent" />}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.ol
            className="timeline__list"
            variants={collapse}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            <motion.span variants={staggerContainer(0.03)} initial="hidden" animate="visible">
              {steps.map(step => (
                <motion.li
                  key={step.id}
                  className={cx('timeline__step', `is-${step.status}`, `is-${step.kind}`)}
                  variants={listItem}
                >
                  <span className="timeline__rail" aria-hidden />
                  <span className="timeline__icon" aria-hidden>
                    {step.status === 'running' && <Loader2 size={11} className="is-spinning" />}
                    {step.status === 'success' && <Check size={11} />}
                    {step.status === 'error' && <TriangleAlert size={11} />}
                  </span>
                  <span className="timeline__label">{step.label}</span>
                  {step.detail && <span className="timeline__detail" title={step.detail}>{step.detail}</span>}
                  {step.endedAt !== null && step.kind === 'tool' && (
                    <span className="timeline__time">
                      {formatDuration(step.endedAt - step.startedAt)}
                    </span>
                  )}
                </motion.li>
              ))}
            </motion.span>
          </motion.ol>
        )}
      </AnimatePresence>
    </div>
  )
}

interface ActivityListProps {
  activities: Array<{ id: string; tool: string; args: unknown; status: string; summary: string }>
  describe: (args: unknown) => string
}

/** Compact, static rendering of a finished turn's tool calls. */
export function ActivityList({ activities, describe }: ActivityListProps) {
  const [open, setOpen] = useState(false)
  if (activities.length === 0) return null
  const failed = activities.filter(activity => activity.status === 'error').length

  return (
    <div className="agent-activity">
      <button
        type="button"
        className="agent-activity__toggle"
        onClick={() => setOpen(current => !current)}
        aria-expanded={open}
      >
        <StatusDot tone={failed > 0 ? 'danger' : 'success'} size={6} />
        {activities.length} action{activities.length > 1 ? 's' : ''}
        {failed > 0 && ` · ${failed} échec(s)`}
        <ChevronDown size={12} className={cx('agent-activity__chev', open && 'is-open')} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            className="agent-activity__list"
            variants={collapse}
            initial="hidden"
            animate="visible"
            exit="exit"
          >
            {activities.map(activity => (
              <li key={activity.id} className={cx('agent-activity__item', `is-${activity.status}`)}>
                <span className="agent-activity__icon" aria-hidden>
                  {activity.status === 'running' && <Loader2 size={10} className="is-spinning" />}
                  {activity.status === 'success' && <Check size={10} />}
                  {activity.status === 'error' && <TriangleAlert size={10} />}
                </span>
                <span className="agent-activity__tool">{activity.tool}</span>
                <span className="agent-activity__args">{describe(activity.args)}</span>
                {activity.status === 'error' && (
                  <span className="agent-activity__error">{activity.summary}</span>
                )}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}
