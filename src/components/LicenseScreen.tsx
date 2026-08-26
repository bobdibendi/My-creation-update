import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { BadgeCheck, KeyRound, Loader2, ShieldCheck, Store, TriangleAlert } from 'lucide-react'
import { cx } from './ui/cx'

interface Props {
  /** Human-readable identity of the logged-in user. */
  userName: string
  /** Active une licence interne (JWT du License Generator). */
  onActivate(key: string): Promise<{ success: boolean; error?: string }>
  /** Active une licence Gumroad (vérification API côté main process). */
  onActivateGumroad(key: string): Promise<{ success: boolean; error?: string }>
  onLogout(): Promise<void>
  /** Passe l'étape : l'utilisateur entrera en FREE et activera plus tard. */
  onSkip(): void
}

type SubmitState = 'idle' | 'submitting'
type LicenseOrigin = 'my-creation' | 'gumroad'

/** Formats a raw license key as XXXXX-XXXXX-… while the user types. */
function formatKey(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return clean.replace(/(.{5})(?=.)/g, '$1-')
}

/**
 * Activation gate: shown instead of the workspace until a valid license is
 * activated for the current account. Deux sources acceptées : clé interne
 * (License Generator) ou License Key Gumroad — la vérification réelle est
 * toujours faite côté main process.
 */
export function LicenseScreen({ userName, onActivate, onActivateGumroad, onLogout, onSkip }: Props) {
  const [origin, setOrigin] = useState<LicenseOrigin>('my-creation')
  const [rawKey, setRawKey] = useState('')
  const key = origin === 'gumroad' ? rawKey.trim() : formatKey(rawKey)
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<SubmitState>('idle')

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (state === 'submitting') return

    const submitted = rawKey.trim()
    const minLength = origin === 'gumroad' ? 6 : 10
    if (submitted.length < minLength) {
      setError('La clé de licence semble incomplète.')
      return
    }

    setError(null)
    setState('submitting')
    try {
      const result = origin === 'gumroad'
        ? await onActivateGumroad(submitted)
        : await onActivate(submitted)
      if (!result.success) {
        setError(result.error ?? 'Clé invalide.')
        setState('idle')
      }
      // On success the parent flips to the unlocked app; no local state change.
    } catch {
      setError('Impossible de vérifier la clé. Réessayez.')
      setState('idle')
    }
  }

  return (
    <motion.div
      className="auth-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      <div className="auth-screen__glow" aria-hidden />
      <motion.div
        className="auth-card"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.05, 0.7, 0.1, 1] }}
      >
        <div className="auth-card__glow" aria-hidden />
        <div className="auth-card__mark" aria-hidden>
          <svg viewBox="0 0 64 64" width="44" height="44">
            <path d="M32 5 59 32 32 59 5 32Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
            <path d="M32 20 45 32 32 44 19 32Z" fill="currentColor" opacity="0.85" />
          </svg>
        </div>

        <h1 className="auth-card__title">Activer la licence</h1>
        <p className="auth-card__subtitle">
          Bienvenue <strong>{userName}</strong>. Entrez votre clé d’activation pour débloquer l’application.
        </p>

        <form className="auth-card__form" onSubmit={handleSubmit} noValidate>
          <div className="sub__origin-picker" role="radiogroup" aria-label="Type de licence">
            <label className={cx('sub__origin', origin === 'my-creation' && 'is-active')}>
              <input
                type="radio"
                name="license-origin-gate"
                checked={origin === 'my-creation'}
                onChange={() => { setOrigin('my-creation'); setError(null) }}
              />
              Licence My Creation
            </label>
            <label className={cx('sub__origin', origin === 'gumroad' && 'is-active')}>
              <input
                type="radio"
                name="license-origin-gate"
                checked={origin === 'gumroad'}
                onChange={() => { setOrigin('gumroad'); setError(null) }}
              />
              Licence Gumroad
            </label>
          </div>

          <label className="auth-field">
            <span className="auth-field__label">
              {origin === 'gumroad' ? (
                <span className="sub__source"><Store size={11} aria-hidden /> License Key Gumroad</span>
              ) : 'Clé de licence'}
            </span>
            <div className="auth-field__input auth-field__input--mono">
              <KeyRound size={15} aria-hidden />
              <input
                type="text"
                value={key}
                onChange={event => setRawKey(event.target.value)}
                placeholder={origin === 'gumroad' ? 'Collez votre License Key Gumroad' : 'XXXXX-XXXXX-XXXXX-XXXXX'}
                spellCheck={false}
                autoFocus
              />
            </div>
          </label>

          {error && (
            <div className="auth-error" role="alert">
              <TriangleAlert size={14} aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="auth-card__submit" disabled={state === 'submitting'}>
            {state === 'submitting' ? <Loader2 size={15} className="spin" aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
            {state === 'submitting' ? 'Vérification…' : 'Activer'}
          </button>
        </form>

        <div className="auth-card__footer">
          <span className="auth-hint"><BadgeCheck size={13} aria-hidden /> La clé est liée à votre compte.</span>
          <span className="auth-card__footer-actions">
            <button type="button" className="auth-card__switch" onClick={onSkip}>
              Passer cette étape — utiliser FREE
            </button>
            <button type="button" className="auth-card__switch" onClick={() => void onLogout()}>
              Se déconnecter
            </button>
          </span>
        </div>
      </motion.div>
    </motion.div>
  )
}
