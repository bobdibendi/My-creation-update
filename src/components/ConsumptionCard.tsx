import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { useI18n } from '../i18n'

export interface ConsumptionCardProps {
  /** Modèle actuellement sélectionné dans l'assistant, si connu. */
  modelLabel: string | null
  /** Nom de l'offre affiché : Free / Pro / Pro Ultimate. */
  planLabel: string
  remainingTokens: number | null
  dailyTokenLimit: number | null
  percentUsed: number | null
  nextResetAt: number | null
}

const BRAND = 'My Creation AI'

/** « 65,5M » / « 980K » / « 12 340 ». */
function compactTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })}K`
  }
  return value.toLocaleString('fr-FR')
}

/** « 11h 30min », « 42 min », « 2 j 3 h ». */
export function formatResetIn(ms: number): string {
  if (ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '< 1 min'
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} j`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 && days === 0) parts.push(`${minutes}min`)
  return parts.slice(0, days > 0 ? 2 : 2).join(' ') || '< 1 min'
}

/**
 * Consommation My Creation AI — pool quotidienne.
 *
 * Les chiffres viennent du QuotaService réel (comptabilisation des usages
 * chat + agent, poussée en temps réel via `quota:update`). La dimension
 * « pool partagée entre utilisateurs » relève du backend : tant qu'aucune
 * source serveur ne l'expose, l'affichage reflète le quota suivi localement,
 * sans jamais inventer de valeur (hasData=false -> tirets).
 */
export function ConsumptionCard({
  modelLabel, planLabel, remainingTokens, dailyTokenLimit, percentUsed, nextResetAt,
}: ConsumptionCardProps) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const hasData = remainingTokens !== null || dailyTokenLimit !== null
  const remainingText = remainingTokens !== null ? compactTokens(remainingTokens) : '—'
  const limitText = dailyTokenLimit !== null ? compactTokens(dailyTokenLimit) : '—'
  const barWidth = Math.min(100, Math.max(0, percentUsed ?? 0))
  const resetIn = nextResetAt !== null ? formatResetIn(nextResetAt - now) : '—'
  const offerLine = `${BRAND} · ${planLabel}`

  return (
    <section className="consumption-card" aria-label={t('consumption.title')}>
      <span className="sidebar-group__label">{t('consumption.title')}</span>

      <header className="consumption-card__head">
        <strong className="consumption-card__model">{modelLabel ?? BRAND}</strong>
        <span className="consumption-card__offer">{offerLine}</span>
      </header>

      <div className="consumption-card__block">
        <span className="sidebar-group__label">{t('consumption.poolLabel')}</span>
        <div
          className="consumption-card__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(barWidth)}
          aria-label={t('consumption.poolLabel')}
        >
          <span style={{ width: `${barWidth}%` }} />
        </div>
        <p className="consumption-card__figures">
          {hasData
            ? t('consumption.remaining', { remaining: remainingText, total: limitText })
            : '—'}
        </p>
      </div>

      <div className="consumption-card__reset">
        <dt>{t('consumption.resetLabel')}</dt>
        <dd>{nextResetAt !== null ? t('consumption.resetIn', { duration: resetIn }) : '—'}</dd>
      </div>

      <p className="consumption-card__note">
        <Info size={12} aria-hidden />
        {t('consumption.sharedNote')}
      </p>
    </section>
  )
}
