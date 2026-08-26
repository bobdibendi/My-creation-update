import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import type { ActionLogEntry } from '../shared/types'
import { useI18n } from '../i18n'
import { staggerContainer, riseIn } from '../animations'

interface Props {
  sessionToken: string | null
}

/** Pur : aucun hook — appelé N fois par render dans une boucle. */
function dayLabel(timestamp: number, today: number): string {
  const dayStart = new Date(today)
  dayStart.setHours(0, 0, 0, 0)
  const target = new Date(timestamp)
  const start = new Date(target)
  start.setHours(0, 0, 0, 0)
  const diffDays = Math.round((dayStart.getTime() - start.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  return 'earlier'
}

function timeOf(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * Journal des actions significatives (tâches, dossiers) alimenté par le
 * TaskService côté main process — lecture seule, aucune action destructive.
 */
export function HistoryPage({ sessionToken }: Props) {
  const { t } = useI18n()
  const [entries, setEntries] = useState<ActionLogEntry[] | null>(null)
  const [now] = useState(() => Date.now())

  useEffect(() => {
    let cancelled = false
    void window.electronAPI?.tasks.activityLog(sessionToken, 120)
      .then(log => { if (!cancelled) setEntries(log) })
      .catch(() => { if (!cancelled) setEntries([]) })
    return () => { cancelled = true }
  }, [sessionToken])

  const groups = useMemo(() => {
    if (!entries) return []
    const map = new Map<string, ActionLogEntry[]>()
    for (const entry of entries) {
      const label = dayLabel(entry.createdAt, now)
      const list = map.get(label) ?? []
      list.push(entry)
      map.set(label, list)
    }
    return [...map.entries()]
  }, [entries, now])

  return (
    <div className="history-page">
      <motion.header
        className="page-head"
        variants={staggerContainer(0.05)}
        initial="hidden"
        animate="visible"
      >
        <motion.h1 variants={riseIn}>{t('history.title')}</motion.h1>
        <motion.p variants={riseIn}>{t('history.subtitle')}</motion.p>
      </motion.header>

      {!entries && <p className="history-page__empty">{t('common.loading')}</p>}

      {entries?.length === 0 && (
        <p className="history-page__empty">{t('history.empty')}</p>
      )}

      {entries && entries.length > 0 && (
        <div className="timeline">
          {groups.map(([group, items]) => (
            <section key={group} className="timeline__group">
              <h2>{group === 'today' ? t('history.today') : group === 'yesterday' ? t('history.yesterday') : t('history.earlier')}</h2>
              <ol>
                {items.map(entry => (
                  <li key={entry.id} className="timeline__row" data-kind={entry.kind}>
                    <span className="timeline__time">{timeOf(entry.createdAt)}</span>
                    <span className="timeline__dot" aria-hidden />
                    <span className="timeline__label">
                      {kindLabel(t, entry.kind)}
                      <strong>{entry.label}</strong>
                      {entry.detail && <small>{entry.detail}</small>}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function kindLabel(t: (key: string) => string, kind: string): string {
  const direct = t(`history.kinds.${kind}`)
  return direct.startsWith('history.kinds.') ? kind : direct
}
