import { useCallback, useState } from 'react'
import { Loader2, RefreshCw, ShieldCheck, ShieldOff, Store } from 'lucide-react'
import { Sidebar } from '../layout/Sidebar'
import { BarChart, Donut } from './Charts'
import { Badge } from './ui'
import { cx } from './ui/cx'
import { formatTokens, useSubscription } from '../hooks/useSubscription'
import type { PlanInfo } from '../shared/types'

interface Props {
  sessionToken: string | null
  licenseActive: boolean
  licenseType: string | null
  licenseExpiresAt: number | null
  /** Source de la licence active : interne ou Gumroad. */
  licenseSource: 'my-creation' | 'gumroad' | null
  /** Activation d'une licence interne (JWT du License Generator). */
  onActivateLicense: (key: string) => Promise<{ success: boolean; error?: string }>
  /** Activation d'une licence Gumroad (vérification API côté main). */
  onActivateGumroadLicense: (key: string) => Promise<{ success: boolean; error?: string }>
  /** Désactivation locale des licences -> retour FREE immédiat. */
  onDeactivateLicense: () => Promise<{ success: boolean; removed?: number }>
}

const PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  pro_ultimate: 'Pro Ultimate',
}

type LicenseOrigin = 'my-creation' | 'gumroad'

/** « 30 jours », « 12 h », « 4 min »… */
function timeRemaining(expiresAt: number | null): string {
  if (expiresAt === null) return '—'
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'Expirée'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  const days = Math.floor(hours / 24)
  return `${days} jour${days > 1 ? 's' : ''}`
}

/**
 * ABONNEMENT — « Mon plan », quota quotidien et consommation réelle.
 * Bien distinct de la licence produit : la licence autorise l'application,
 * l'abonnement détermine le plan IA et son quota. Une licence
 * PRO ULTIMATE débloque directement le plan du même nom.
 */
export function SubscriptionPanel({
  sessionToken, licenseActive, licenseType, licenseExpiresAt, licenseSource,
  onActivateLicense, onActivateGumroadLicense, onDeactivateLicense,
}: Props) {
  const { loading, error, summary, plans, refresh } = useSubscription(sessionToken)
  const [upgradeNote, setUpgradeNote] = useState<string | null>(null)
  const [licenseKeyDraft, setLicenseKeyDraft] = useState('')
  const [licenseOrigin, setLicenseOrigin] = useState<LicenseOrigin>('my-creation')
  const [licenseBusy, setLicenseBusy] = useState(false)
  const [licenseMessage, setLicenseMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDeactivate, setConfirmDeactivate] = useState(false)

  const SOURCE_LABEL: Record<string, string> = {
    'my-creation': 'My Creation',
    gumroad: 'Gumroad',
  }

  const activate = useCallback(async (): Promise<void> => {
    const key = licenseKeyDraft.trim()
    if (key.length < 6) {
      setLicenseMessage({ tone: 'error', text: 'Clé de licence trop courte.' })
      return
    }
    setLicenseBusy(true)
    setLicenseMessage(null)
    const result = licenseOrigin === 'gumroad'
      ? await onActivateGumroadLicense(key)
      : await onActivateLicense(key)
    setLicenseBusy(false)
    if (result.success) {
      setLicenseKeyDraft('')
      setLicenseMessage({ tone: 'ok', text: licenseOrigin === 'gumroad'
        ? 'Licence Gumroad activée — plan mis à jour immédiatement.'
        : 'Licence activée — plan mis à jour immédiatement.' })
      refresh()
    } else {
      setLicenseMessage({ tone: 'error', text: result.error ?? 'Activation impossible.' })
    }
  }, [licenseKeyDraft, licenseOrigin, onActivateGumroadLicense, onActivateLicense, refresh])

  const deactivate = useCallback(async (): Promise<void> => {
    setConfirmDeactivate(false)
    setLicenseBusy(true)
    const result = await onDeactivateLicense()
    setLicenseBusy(false)
    if (result.success) {
      setLicenseMessage({ tone: 'ok', text: `Licence désactivée (${result.removed ?? 0} référence(s) retirée(s)). Plan : FREE.` })
      refresh()
    } else {
      setLicenseMessage({ tone: 'error', text: 'Désactivation impossible.' })
    }
  }, [onDeactivateLicense, refresh])

  /**
   * AUCUNE redirection vers un site externe (Top Tools AI n'est pas le
   * vendeur de My Creation). Les adhésions passent par le License Generator
   * de l'administrateur.
   */
  const askUpgrade = useCallback((plan: PlanInfo): void => {
    setUpgradeNote(
      `Pour obtenir une licence ${PLAN_LABEL[plan.id] ?? plan.name}, contactez l’administrateur `
      + 'My Creation : il générera votre clé d’activation depuis le License Generator. '
      + 'Collez ensuite cette clé dans l’écran d’activation pour débloquer le plan.',
    )
  }, [])

  return (
    <Sidebar
      title="ABONNEMENT"
      actions={
        <button type="button" className="pkg__secondary" onClick={() => void refresh()} aria-label="Actualiser">
          <RefreshCw size={12} />
        </button>
      }
    >
      {!sessionToken ? (
        <p className="sub__muted">Connecte-toi pour voir ton abonnement.</p>
      ) : loading && !summary ? (
        <p className="sub__muted"><Loader2 size={14} className="spin" aria-hidden /> Chargement…</p>
      ) : error ? (
        <div className="pkg__error" role="alert">{error}</div>
      ) : summary && (
        <div className="sub">
          <div className="sub__plan">
            <span className="sidebar-group__label">Mon plan</span>
            <Badge tone={summary.plan.id === 'free' ? 'neutral' : 'accent'}>
              {summary.plan.name}
              {summary.plan.id === 'pro_ultimate' ? ' ★' : ''}
            </Badge>
            {licenseType && (
              <span className="sub__license" title="Licence produit (indépendante du plan IA)">
                Licence : {licenseType === 'lifetime'
                  ? 'Lifetime'
                  : licenseType === 'pro_ultimate'
                    ? 'PRO ULTIMATE'
                    : 'Subscription'}
              </span>
            )}
          </div>

          <section className="sub__block sub__profile">
            <div><dt className="sub__dt">Nom</dt><dd>My Creation</dd></div>
            <div><dt className="sub__dt">Plan</dt><dd>{summary.plan.name}</dd></div>
            <div>
              <dt className="sub__dt">Statut</dt>
              <dd>{licenseActive ? 'ACTIF' : 'INACTIF'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Type</dt>
              <dd>{licenseActive
                ? (licenseType === 'lifetime' || licenseExpiresAt === null ? 'LIFETIME' : 'SUBSCRIPTION')
                : '—'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Source</dt>
              <dd>{licenseActive
                ? (<span className="sub__source"><Store size={11} aria-hidden /> {SOURCE_LABEL[licenseSource ?? 'my-creation'] ?? 'My Creation'}</span>)
                : '—'}</dd>
            </div>
            <div>
              <dt className="sub__dt">Expiration</dt>
              <dd>{!licenseActive
                ? '—'
                : licenseExpiresAt === null
                  ? 'Aucune'
                  : new Date(licenseExpiresAt).toLocaleDateString('fr-FR', { dateStyle: 'long' })}</dd>
            </div>
            <div>
              <dt className="sub__dt">Temps restant</dt>
              <dd>{licenseActive && licenseExpiresAt !== null ? timeRemaining(licenseExpiresAt) : licenseActive ? 'Illimité' : '—'}</dd>
            </div>
            <div><dt className="sub__dt">Modèles</dt><dd>{summary.plan.permissions.premiumModels
              ? 'Tous'
              : summary.plan.permissions.oxAlphaModels
                ? 'Kim Pro · Ox Alpha'
                : 'Kim Pro'}</dd></div>
            <div className="sub__features">
              <dt className="sub__dt">Fonctionnalités</dt>
              <dd>
                <ul>
                  {(summary.plan.features ?? []).map(feature => <li key={feature}>{feature}</li>)}
                </ul>
              </dd>
            </div>
          </section>

          <section className="sub__quota">
            <Donut
              value={(summary.percentUsed ?? 0) / 100}
              label="utilisé"
              size={96}
              tone={
                (summary.percentUsed ?? 0) >= 100 ? 'danger'
                  : (summary.percentUsed ?? 0) >= 80 ? 'warning' : 'accent'
              }
            />
            <dl className="sub__numbers">
              <div>
                <dt>Quota</dt>
                <dd>{summary.dailyTokenLimit === null ? '—' : `${formatTokens(summary.dailyTokenLimit)} / jour`}</dd>
              </div>
              <div>
                <dt>Utilisation</dt>
                <dd>{formatTokens(summary.totalTokens)}{summary.dailyTokenLimit !== null && ` / ${formatTokens(summary.dailyTokenLimit)}`}</dd>
              </div>
              <div>
                <dt>Restants</dt>
                <dd>{summary.remainingTokens === null ? 'Illimité' : formatTokens(summary.remainingTokens)}</dd>
              </div>
              <div>
                <dt>Requêtes</dt>
                <dd>{summary.requests.toLocaleString('fr-FR')}</dd>
              </div>
            </dl>
          </section>

          <section className="sub__block">
            <span className="sidebar-group__label">Aujourd’hui</span>
            <BarChart
              data={[
                { label: 'Chat', value: summary.byKind.chat.totalTokens },
                { label: 'Agent', value: summary.byKind.agent.totalTokens },
                { label: 'Autres', value: summary.byKind.other.totalTokens },
              ]}
              format={formatTokens}
            />
          </section>

          <section className="sub__block sub__io">
            <div><dt className="sub__dt">Input tokens</dt><dd>{formatTokens(summary.inputTokens)}</dd></div>
            <div><dt className="sub__dt">Output tokens</dt><dd>{formatTokens(summary.outputTokens)}</dd></div>
            <div><dt className="sub__dt">Total tokens</dt><dd>{formatTokens(summary.totalTokens)}</dd></div>
          </section>

          <p className="sub__reset">
            Prochain reset&nbsp;:{' '}
            <strong>{new Date(summary.nextResetAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</strong>
          </p>

          <section className="sub__block">
            <span className="sidebar-group__label">Changer de licence</span>
            <p className="sub__note">
              Deux sources possibles : une clé générée par l'administrateur
              (License Generator My Creation) ou une License Key Gumroad.
              Upgrade Free&nbsp;→&nbsp;Pro&nbsp;→&nbsp;Pro Ultimate, effet immédiat, sans redémarrage.
            </p>
            <div className="account__form-actions account__form-actions--col">
              <div className="sub__origin-picker" role="radiogroup" aria-label="Type de licence">
                <label className={cx('sub__origin', licenseOrigin === 'my-creation' && 'is-active')}>
                  <input
                    type="radio"
                    name="license-origin"
                    checked={licenseOrigin === 'my-creation'}
                    onChange={() => setLicenseOrigin('my-creation')}
                  />
                  Licence My Creation
                </label>
                <label className={cx('sub__origin', licenseOrigin === 'gumroad' && 'is-active')}>
                  <input
                    type="radio"
                    name="license-origin"
                    checked={licenseOrigin === 'gumroad'}
                    onChange={() => setLicenseOrigin('gumroad')}
                  />
                  Licence Gumroad
                </label>
              </div>
              <input
                className="account__license-input"
                value={licenseKeyDraft}
                placeholder={licenseOrigin === 'gumroad' ? 'Collez votre License Key Gumroad' : 'Collez votre clé de licence'}
                onChange={e => setLicenseKeyDraft(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="sidebar__cta"
                disabled={licenseBusy || licenseKeyDraft.trim().length < 6}
                onClick={() => void activate()}
              >
                {licenseBusy ? <Loader2 size={13} className="spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />}
                Activer
              </button>

              {licenseActive && (
                confirmDeactivate ? (
                  <div className="sub__deactivate-confirm">
                    <p className="sub__note">Désactiver cette licence ? Le compte repassera en FREE immédiatement.</p>
                    <div className="account__form-actions">
                      <button type="button" className="pkg__secondary" onClick={() => setConfirmDeactivate(false)}>Annuler</button>
                      <button type="button" className="pkg__error account__logout--inline" disabled={licenseBusy} onClick={() => void deactivate()}>
                        <ShieldOff size={12} aria-hidden /> Confirmer la désactivation
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="pkg__secondary sub__deactivate"
                    onClick={() => setConfirmDeactivate(true)}
                  >
                    <ShieldOff size={12} aria-hidden /> Désactiver cette licence
                  </button>
                )
              )}
            </div>
            {licenseMessage && (
              <div role="status" className="pkg__error" style={licenseMessage.tone === 'ok'
                ? { borderColor: 'var(--c-success)', color: 'var(--c-success)', background: 'color-mix(in srgb, var(--c-success) 10%, transparent)' }
                : undefined}>
                {licenseMessage.text}
              </div>
            )}
          </section>

          <section className="sub__block">
            <span className="sidebar-group__label">Voir les plans</span>
            <ul className="sub__plans">
              {plans.map(plan => (
                <li key={plan.id} className={cx('sub__plan-card', plan.id === summary.plan.id && 'is-current')}>
                  <header>
                    <strong>{plan.name}</strong>
                    <span>{plan.price}</span>
                  </header>
                  <p>{plan.description}</p>
                  <ul>
                    {plan.features.map(feature => <li key={feature}>{feature}</li>)}
                    {plan.dailyTokenLimit === null && plan.id !== 'free' && (
                      <li className="sub__tbd">Quota exact à confirmer avec le fournisseur</li>
                    )}
                  </ul>
                  {plan.id !== 'free' && plan.id !== summary.plan.id && (
                    <button
                      type="button"
                      className="sidebar__cta"
                      onClick={() => askUpgrade(plan)}
                    >
                      Passer à {PLAN_LABEL[plan.id] ?? plan.name}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {upgradeNote && <p className="sub__note">{upgradeNote}</p>}
          </section>
        </div>
      )}
    </Sidebar>
  )
}
