import { useCallback, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, KeyRound, Loader2, ShieldCheck, ShieldOff, Store, WifiOff } from 'lucide-react'
import type { PlanInfo } from '../shared/types'
import { useI18n } from '../i18n'
import { Badge } from './ui'
import { ConsumptionCard } from './ConsumptionCard'
import { cx } from './ui/cx'
import { useSubscription } from '../hooks/useSubscription'

interface Props {
  sessionToken: string | null
  online: boolean
  licenseActive: boolean
  licenseType: string | null
  licenseExpiresAt: number | null
  licenseSource: 'my-creation' | 'gumroad' | null
  /** Revalidation Gumroad : dernière validation réussie (ms) si connue. */
  planName: string
  /** Modèle actif de l'assistant, poussé par l'UI (affichage consommation). */
  activeModelLabel?: string | null
  onActivate(key: string): Promise<{ success: boolean; error?: string }>
  onActivateGumroad(key: string): Promise<{ success: boolean; error?: string }>
  onDeactivate(): Promise<{ success: boolean; removed?: number }>
}

type Origin = 'my-creation' | 'gumroad'

const PLAN_LABEL: Record<string, string> = {
  free: 'FREE',
  pro: 'PRO',
  pro_ultimate: 'PRO ULTIMATE',
}

function timeRemaining(expiresAt: number | null, t: ReturnType<typeof useI18n>['t']): string {
  if (expiresAt === null) return t('license.none')
  const ms = expiresAt - Date.now()
  if (ms <= 0) return t('license.expired')
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} j`
}

/**
 * Page Licence — une section normale du compte, plus jamais un portail.
 *
 * Toute la logique métier existante est conservée : activation interne (JWT
 * RS256), activation Gumroad (API officielle côté main), désactivation locale,
 * revalidation différée tolérante hors-ligne.
 */
export function LicenseSection({
  sessionToken, online, licenseActive, licenseType, licenseExpiresAt, licenseSource,
  planName, activeModelLabel, onActivate, onActivateGumroad, onDeactivate,
}: Props) {
  const { t } = useI18n()
  const { summary, plans, refresh } = useSubscription(sessionToken)

  const [activating, setActivating] = useState(false)
  const [showActivate, setShowActivate] = useState(false)
  const [origin, setOrigin] = useState<Origin>('my-creation')
  const [keyDraft, setKeyDraft] = useState('')
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [confirmOff, setConfirmOff] = useState(false)

  const activate = useCallback(async (): Promise<void> => {
    const key = keyDraft.trim()
    if (key.length < 6) {
      setMessage({ tone: 'error', text: t('license.keyTooShort') })
      return
    }
    setActivating(true)
    setMessage(null)
    try {
      const result = origin === 'gumroad'
        ? await onActivateGumroad(key)
        : await onActivate(key)
      if (result.success) {
        setKeyDraft('')
        setMessage({ tone: 'ok', text: origin === 'gumroad' ? t('license.gumroadActivatedOk') : t('license.activatedOk') })
        await refresh()
      } else {
        setMessage({ tone: 'error', text: result.error ?? t('license.invalidKey') })
      }
    } catch {
      setMessage({ tone: 'error', text: online ? t('license.verifyFailed') : t('errors.networkLicense') })
    } finally {
      setActivating(false)
    }
  }, [keyDraft, origin, onActivate, onActivateGumroad, refresh, t, online])

  const deactivate = useCallback(async (): Promise<void> => {
    setConfirmOff(false)
    setActivating(true)
    const result = await onDeactivate()
    setActivating(false)
    setMessage(result.success
      ? { tone: 'ok', text: t('license.deactivatedOk', { count: result.removed ?? 0 }) }
      : { tone: 'error', text: t('errors.ipcFailed') })
    await refresh()
  }, [onDeactivate, refresh, t])

  const currentPlanId = (summary?.plan.id ?? 'free') as PlanInfo['id']

  return (
    <div className="license-section">
      <div className="license-hero">
        <div className="license-hero__plan">
          <span className="sidebar-group__label">{t('license.currentPlan')}</span>
          <strong className={cx('license-plan-name', currentPlanId !== 'free' && 'is-pro')}>{planName}</strong>
        </div>
        <dl className="license-facts">
          <div><dt>{t('license.status')}</dt><dd>
            <Badge size="sm" tone={licenseActive ? 'success' : 'neutral'}>
              {licenseActive ? t('license.active') : t('license.inactive')}
            </Badge>
          </dd></div>
          <div><dt>{t('license.type')}</dt><dd>
            {!licenseActive ? t('license.noLicense')
              : licenseType === 'lifetime' ? t('license.lifetime') : licenseType === 'subscription' ? t('license.subscription') : licenseType}
          </dd></div>
          <div><dt>{t('license.source')}</dt><dd>
            {!licenseActive ? t('license.none')
              : (<span className="license-source"><Store size={11} aria-hidden /> {licenseSource === 'gumroad' ? 'Gumroad' : 'My Creation'}</span>)}
          </dd></div>
          <div><dt>{t('license.expiration')}</dt><dd>
            {!licenseActive || licenseExpiresAt === null ? t('license.none')
              : new Date(licenseExpiresAt).toLocaleDateString(undefined, { dateStyle: 'long' })}
          </dd></div>
          <div><dt>{t('license.remaining')}</dt><dd>
            {licenseActive ? (licenseExpiresAt === null ? t('license.lifetime') : timeRemaining(licenseExpiresAt, t)) : t('license.none')}
          </dd></div>
        </dl>

        {!online && licenseActive && (
          <p className="license-offline"><WifiOff size={12} aria-hidden /> {t('statusbar.offline')} — {t('license.offlineNote', { date: new Date().toLocaleDateString() })}</p>
        )}

        {!licenseActive && (
          <div className="license-free-note">
            <p>{t('license.usingFree')}</p>
            <ul className="license-features">
              {(summary?.plan.features ?? []).map(feature => (
                <li key={feature}><Check size={12} aria-hidden /> {feature}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {summary && (() => {
        const planDisplayLabel = planName === 'PRO ULTIMATE'
          ? 'Pro Ultimate'
          : planName.charAt(0) + planName.slice(1).toLowerCase()
        return (
          <ConsumptionCard
            modelLabel={activeModelLabel ?? null}
            planLabel={planDisplayLabel}
            remainingTokens={summary.remainingTokens}
            dailyTokenLimit={summary.dailyTokenLimit}
            percentUsed={summary.percentUsed}
            nextResetAt={summary.nextResetAt}
          />
        )
      })()}

      <AnimatePresence initial={false}>
        {!showActivate && (
          <motion.div exit={{ opacity: 0 }} className="license-actions">
            <button type="button" className="btn btn--primary" onClick={() => setShowActivate(true)}>
              <KeyRound size={14} aria-hidden /> {t('license.activate')}
            </button>
            {currentPlanId === 'free' && (
              <button type="button" className="btn btn--upgrade" onClick={() => setShowActivate(true)}>
                {t('license.upgradePro')}
              </button>
            )}
            {licenseActive && (
              confirmOff ? (
                <div className="license-deactivate-confirm">
                  <p>{t('license.deactivateConfirm')}</p>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirmOff(false)}>{t('common.cancel')}</button>
                  <button type="button" className="btn btn--danger btn--sm" disabled={activating} onClick={() => void deactivate()}>
                    <ShieldOff size={13} aria-hidden /> {t('license.deactivate')}
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn--ghost" onClick={() => setConfirmOff(true)}>
                  <ShieldOff size={13} aria-hidden /> {t('license.deactivate')}
                </button>
              )
            )}
          </motion.div>
        )}

        {showActivate && (
          <motion.form
            className="license-activate"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            onSubmit={event => { event.preventDefault(); void activate() }}
          >
            <span className="sidebar-group__label">{t('license.alreadyPurchased')}</span>
            <div className="sub__origin-picker" role="radiogroup" aria-label={t('license.licenseType')}>
              <label className={cx('sub__origin', origin === 'my-creation' && 'is-active')}>
                <input type="radio" name="license-origin-settings" checked={origin === 'my-creation'} onChange={() => setOrigin('my-creation')} />
                {t('license.internalLicense')}
              </label>
              <label className={cx('sub__origin', origin === 'gumroad' && 'is-active')}>
                <input type="radio" name="license-origin-settings" checked={origin === 'gumroad'} onChange={() => setOrigin('gumroad')} />
                {t('license.gumroadLicense')}
              </label>
            </div>
            <label className="settings__label" htmlFor="license-key-input">{t('license.keyLabel')}</label>
            <input
              id="license-key-input"
              className="account__license-input"
              value={keyDraft}
              placeholder={origin === 'gumroad' ? t('license.gumroadKeyPlaceholder') : t('license.keyPlaceholder')}
              onChange={event => setKeyDraft(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <div className="license-actions">
              <button type="submit" className="btn btn--primary" disabled={activating || keyDraft.trim().length < 6}>
                {activating ? <Loader2 size={14} className="spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                {activating ? t('license.verifying') : t('license.activateShort')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => { setShowActivate(false); setMessage(null) }}>
                {t('common.cancel')}
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {message && (
        <div role="status" className={cx('license-message', message.tone === 'ok' ? 'is-ok' : 'is-error')}>
          {message.text}
        </div>
      )}

      <div className="license-plans">
        <span className="sidebar-group__label">{t('license.plansTitle')}</span>
        <ul>
          {plans.map(plan => (
            <li key={plan.id} className={cx('license-plan-card', plan.id === currentPlanId && 'is-current')}>
              <header>
                <strong>{PLAN_LABEL[plan.id] ?? plan.name}</strong>
                <span>{plan.price}</span>
              </header>
              <p>{plan.description}</p>
              <ul>
                {plan.features.map(feature => <li key={feature}>{feature}</li>)}
                {plan.dailyTokenLimit === null && plan.id !== 'free' && (
                  <li className="is-muted">{t('license.quotaExactTbd')}</li>
                )}
              </ul>
              {plan.id !== 'free' && plan.id === currentPlanId && (
                <Badge size="sm" tone="accent">{t('license.active')}</Badge>
              )}
            </li>
          ))}
        </ul>
        <p className="settings__note">{t('license.upgradeNote', { plan: 'Pro / Pro Ultimate' })}</p>
      </div>
    </div>
  )
}
