import { MotionConfig } from 'framer-motion'
import type { ReactNode } from 'react'
import { useTheme } from '../theme'

/**
 * Bridges the appearance preference into Framer Motion.
 *
 * With `reducedMotion="always"` Framer keeps opacity transitions but drops
 * transforms, which is exactly the wanted behaviour: the UI stays legible and
 * nothing jumps, instead of animations being half-disabled by hand.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  const { reducedMotion } = useTheme()
  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'never'}>
      {children}
    </MotionConfig>
  )
}
