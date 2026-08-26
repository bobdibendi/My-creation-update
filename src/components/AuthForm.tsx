import { useState, type FormEvent } from 'react'
import { motion } from 'framer-motion'
import { KeyRound, Loader2, LogIn, Mail, TriangleAlert, UserRound } from 'lucide-react'

interface Props {
  mode: 'login' | 'register'
  onSubmit(email: string, password: string, name: string): Promise<{ success: boolean; error?: string }>
  onToggleMode(): void
}

type SubmitState = 'idle' | 'submitting'

/**
 * Shared login / registration form.
 *
 * Client-side validation mirrors the server rules so obvious mistakes never
 * reach a round-trip; the server remains authoritative.
 */
export function AuthForm({ mode, onSubmit, onToggleMode }: Props) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [state, setState] = useState<SubmitState>('idle')

  const isRegister = mode === 'register'

  function validate(): string | null {
    if (isRegister && name.trim().length < 2) {
      return 'Le nom doit contenir au moins 2 caractères.'
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return 'Adresse email invalide.'
    }
    if (password.length < 8) {
      return 'Le mot de passe doit contenir au moins 8 caractères.'
    }
    if (isRegister && password !== confirm) {
      return 'Les mots de passe ne correspondent pas.'
    }
    return null
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (state === 'submitting') return

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    setState('submitting')
    try {
      const result = await onSubmit(email.trim(), password, name.trim())
      if (!result.success) {
        setError(result.error ?? 'Une erreur est survenue.')
        setState('idle')
      }
    } catch {
      setError('Impossible de contacter le service d’authentification.')
      setState('idle')
    }
  }

  return (
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

      <h1 className="auth-card__title">{isRegister ? 'Créer un compte' : 'Connexion'}</h1>
      <p className="auth-card__subtitle">
        {isRegister
          ? 'Créez votre compte pour retrouver vos projets et activer votre licence.'
          : 'Connectez-vous pour accéder à vos projets.'}
      </p>

      <form className="auth-card__form" onSubmit={handleSubmit} noValidate>
        {isRegister && (
          <label className="auth-field">
            <span className="auth-field__label">Nom ou pseudo</span>
            <div className="auth-field__input">
              <UserRound size={15} aria-hidden />
              <input
                type="text"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="Ada Lovelace"
                autoComplete="name"
                autoFocus={isRegister}
              />
            </div>
          </label>
        )}

        <label className="auth-field">
          <span className="auth-field__label">Adresse email</span>
          <div className="auth-field__input">
            <Mail size={15} aria-hidden />
            <input
              type="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="vous@exemple.fr"
              autoComplete="email"
              autoFocus={!isRegister}
            />
          </div>
        </label>

        <label className="auth-field">
          <span className="auth-field__label">Mot de passe</span>
          <div className="auth-field__input">
            <KeyRound size={15} aria-hidden />
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
            />
          </div>
        </label>

        {isRegister && (
          <label className="auth-field">
            <span className="auth-field__label">Confirmer le mot de passe</span>
            <div className="auth-field__input">
              <KeyRound size={15} aria-hidden />
              <input
                type="password"
                value={confirm}
                onChange={event => setConfirm(event.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </div>
          </label>
        )}

        {error && (
          <div className="auth-error" role="alert">
            <TriangleAlert size={14} aria-hidden />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="auth-card__submit" disabled={state === 'submitting'}>
          {state === 'submitting'
            ? <Loader2 size={15} className="spin" aria-hidden />
            : isRegister ? <UserRound size={15} aria-hidden /> : <LogIn size={15} aria-hidden />}
          {state === 'submitting' ? 'Veuillez patienter…' : isRegister ? 'Créer le compte' : 'Se connecter'}
        </button>
      </form>

      <button type="button" className="auth-card__switch" onClick={onToggleMode}>
        {isRegister ? 'Vous avez déjà un compte ? Se connecter' : 'Pas encore de compte ? Créer un compte'}
      </button>
    </motion.div>
  )
}
