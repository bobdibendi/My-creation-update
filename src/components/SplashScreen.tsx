import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

interface Props {
  /** Flip to false once the app is ready; the splash then fades out. */
  visible: boolean
}

const STEPS = [
  'Initialisation du moteur',
  'Chargement des fournisseurs',
  'Préparation de l’espace de travail',
  'Prêt',
]

/**
 * Boot overlay.
 *
 * Purely cosmetic: it covers the first paint, during which Monaco and the
 * provider list resolve. The step labels advance on a timer rather than tracking
 * real work, so a slow provider call can never leave the app stuck behind it.
 */
export function SplashScreen({ visible }: Props) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => {
      setStep(current => Math.min(current + 1, STEPS.length - 1))
    }, 260)
    return () => window.clearInterval(timer)
  }, [visible])

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="splash"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.42, ease: [0.3, 0, 0.8, 0.15] }}
        >
          <div className="splash__glow" aria-hidden />
          <motion.div
            className="splash__mark"
            initial={{ opacity: 0, scale: 0.86 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, ease: [0.05, 0.7, 0.1, 1] }}
          >
            <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden>
              <motion.path
                d="M32 5 59 32 32 59 5 32Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                initial={{ pathLength: 0, opacity: 0.2 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.9, ease: 'easeInOut' }}
              />
              <motion.circle
                cx="32"
                cy="32"
                r="8"
                fill="currentColor"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.35, type: 'spring', stiffness: 300, damping: 20 }}
              />
            </svg>
          </motion.div>

          <motion.span
            className="splash__name"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.3 }}
          >
            My Creation
          </motion.span>

          <div className="splash__bar" aria-hidden>
            <motion.span
              className="splash__bar-fill"
              initial={{ width: '8%' }}
              animate={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
              transition={{ duration: 0.32, ease: [0.22, 0.61, 0.36, 1] }}
            />
          </div>

          <AnimatePresence mode="wait">
            <motion.span
              key={step}
              className="splash__step"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {STEPS[step]}
            </motion.span>
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
