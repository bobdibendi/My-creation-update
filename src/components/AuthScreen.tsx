import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { AuthResult } from '../shared/types'
import { AuthForm } from './AuthForm'

interface Props {
  login(email: string, password: string): Promise<AuthResult>
  register(email: string, password: string, name: string): Promise<AuthResult>
}

/**
 * Full-screen authentication gate: toggles between the login and registration
 * forms. Rendered before the license gate in the boot chain.
 */
export function AuthScreen({ login, register }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')

  return (
    <div className="auth-screen">
      <div className="auth-screen__glow" aria-hidden />
      <AnimatePresence mode="wait">
        <motion.div key={mode} className="auth-screen__form">
          <AuthForm
            mode={mode}
            onSubmit={async (email, password, name) =>
              mode === 'register' ? register(email, password, name) : login(email, password)}
            onToggleMode={() => setMode(current => (current === 'login' ? 'register' : 'login'))}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
