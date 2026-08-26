import { useState } from 'react'
import { motion } from 'framer-motion'
import { MailCheck, TriangleAlert } from 'lucide-react'
import { AuthForm } from './AuthForm'
import type { AuthResult } from '../shared/types'

export interface OnboardingNotice {
  kind: 'success' | 'error'
  text: string
}

interface Props {
  /** Connexion réelle (Supabase Auth). */
  login(email: string, password: string): Promise<AuthResult>
  /** Création de compte réelle (Supabase Auth). */
  register(email: string, password: string, name: string): Promise<AuthResult>
  /** Retour du lien de confirmation e-mail (succès ou erreur claire). */
  notice?: OnboardingNotice | null
}

type Step = 'welcome' | 'login' | 'register'

/**
 * Écran d'accueil : sans session Supabase valide, l'utilisateur passe TOUJOURS
 * par ici. Deux portes : connexion ou création de compte — aucune entrée
 * anonyme dans l'application.
 */
export function Onboarding({ login, register, notice }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)

  async function handleSubmit(mode: Step, email: string, password: string, name: string): Promise<AuthResult> {
    const result = mode === 'register' ? await register(email, password, name) : await login(email, password)
    // Compte créé mais confirmation email requise (paramètre Supabase du projet).
    if (result.pendingConfirmation) {
      setPendingEmail(email)
      setStep('login')
    }
    return result
  }

  return (
    <div className="onboarding">
      <div className="onboarding__glow" aria-hidden />
      <motion.div
        className="onboarding__card"
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.05, 0.7, 0.1, 1] }}
      >
        {notice && (
          <div
            className={`onboarding__notice onboarding__notice--${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.kind === 'error'
              ? <TriangleAlert size={15} aria-hidden />
              : <MailCheck size={15} aria-hidden />}
            <span>{notice.text}</span>
          </div>
        )}
        {step === 'welcome' ? (
          <motion.div
            key="welcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            <div className="onboarding__mark" aria-hidden>
              <svg viewBox="0 0 64 64" width={52} height={52}>
                <path d="M32 5 59 32 32 59 5 32Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
                <path d="M32 20 45 32 32 44 19 32Z" fill="currentColor" opacity="0.85" />
              </svg>
            </div>

            <h1 className="onboarding__brand">MY CREATION</h1>
            <p className="onboarding__welcome">Bienvenue</p>

            <button type="button" className="btn btn--primary btn--lg onboarding__start" onClick={() => setStep('login')}>
              Se connecter
            </button>

            <button type="button" className="onboarding__license" onClick={() => setStep('register')}>
              Créer un compte
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="auth"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="onboarding__auth"
          >
            {pendingEmail && (
              <div className="onboarding__notice" role="status">
                <MailCheck size={15} aria-hidden />
                <span>
                  Compte créé pour <strong>{pendingEmail}</strong>.
                  Confirmez votre adresse via l'email reçu, puis connectez-vous.
                </span>
              </div>
            )}
            <AuthForm
              mode={step === 'register' ? 'register' : 'login'}
              onSubmit={async (email, password, name) => handleSubmit(step, email, password, name)}
              onToggleMode={() => {
                setPendingEmail(null)
                setStep(current => (current === 'login' ? 'register' : 'login'))
              }}
            />
            <div className="onboarding__auth-actions">
              <button type="button" className="link-btn" onClick={() => { setPendingEmail(null); setStep('welcome') }}>
                Retour
              </button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  )
}
