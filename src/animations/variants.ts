import type { Transition, Variants } from 'framer-motion'
import { DURATION, EASING } from '../theme/tokens'

/** Seconds, because Framer Motion counts in seconds and tokens in milliseconds. */
const s = (ms: number): number => ms / 1000

export const transitions = {
  instant: { duration: s(DURATION.instant), ease: EASING.standard },
  fast: { duration: s(DURATION.fast), ease: EASING.standard },
  normal: { duration: s(DURATION.normal), ease: EASING.standard },
  slow: { duration: s(DURATION.slow), ease: EASING.decelerate },
  exit: { duration: s(DURATION.fast), ease: EASING.accelerate },
  spring: { type: 'spring', stiffness: 420, damping: 32, mass: 0.8 },
  softSpring: { type: 'spring', stiffness: 260, damping: 26, mass: 0.9 },
} satisfies Record<string, Transition>

/** Fade only. For overlays and anything already positioned. */
export const fade: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: transitions.normal },
  exit: { opacity: 0, transition: transitions.exit },
}

/** The canonical entrance: 10px rise plus fade, 200ms. */
export const riseIn: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: transitions.normal },
  exit: { opacity: 0, y: 6, transition: transitions.exit },
}

export const dropIn: Variants = {
  hidden: { opacity: 0, y: -8, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: transitions.fast },
  exit: { opacity: 0, y: -6, scale: 0.98, transition: transitions.exit },
}

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: transitions.spring },
  exit: { opacity: 0, scale: 0.97, transition: transitions.exit },
}

/** Modal card: lifts as it appears so it reads as coming towards the viewer. */
export const modalIn: Variants = {
  hidden: { opacity: 0, scale: 0.965, y: 14 },
  visible: { opacity: 1, scale: 1, y: 0, transition: transitions.spring },
  exit: { opacity: 0, scale: 0.98, y: 8, transition: transitions.exit },
}

export const slideFromRight: Variants = {
  hidden: { opacity: 0, x: 28 },
  visible: { opacity: 1, x: 0, transition: transitions.softSpring },
  exit: { opacity: 0, x: 20, transition: transitions.exit },
}

export const slideFromLeft: Variants = {
  hidden: { opacity: 0, x: -24 },
  visible: { opacity: 1, x: 0, transition: transitions.softSpring },
  exit: { opacity: 0, x: -18, transition: transitions.exit },
}

export const slideFromBottom: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: transitions.softSpring },
  exit: { opacity: 0, y: 18, transition: transitions.exit },
}

/** Chat bubbles: assistant text should feel like it is being placed, not popped. */
export const messageIn: Variants = {
  hidden: { opacity: 0, y: 12, filter: 'blur(3px)' },
  visible: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { duration: s(DURATION.slow), ease: EASING.decelerate } },
  exit: { opacity: 0, transition: transitions.exit },
}

/** Timeline rows and list items, offset by index. */
export const listItem: Variants = {
  hidden: { opacity: 0, x: -6 },
  visible: { opacity: 1, x: 0, transition: transitions.fast },
  exit: { opacity: 0, x: -4, transition: transitions.exit },
}

/** Container that staggers its children. */
export function staggerContainer(stagger = 0.04, delay = 0): Variants {
  return {
    hidden: {},
    visible: { transition: { staggerChildren: stagger, delayChildren: delay } },
    exit: {},
  }
}

/** Tab panels: direction-aware horizontal swap. */
export function tabPanel(direction: 1 | -1): Variants {
  return {
    hidden: { opacity: 0, x: 14 * direction },
    visible: { opacity: 1, x: 0, transition: transitions.normal },
    exit: { opacity: 0, x: -10 * direction, transition: transitions.exit },
  }
}

/** Notification toast: comes in from the edge, leaves by collapsing. */
export const toastIn: Variants = {
  hidden: { opacity: 0, x: 32, scale: 0.96 },
  visible: { opacity: 1, x: 0, scale: 1, transition: transitions.spring },
  exit: { opacity: 0, x: 24, scale: 0.96, transition: transitions.exit },
}

/** Height 0 -> auto. Framer resolves `auto` by measuring, so this is safe. */
export const collapse: Variants = {
  hidden: { height: 0, opacity: 0, overflow: 'hidden' },
  visible: { height: 'auto', opacity: 1, transition: transitions.normal },
  exit: { height: 0, opacity: 0, transition: transitions.exit },
}

/** Infinite pulse for "thinking" affordances. */
export const thinkingPulse = {
  animate: {
    opacity: [0.35, 1, 0.35],
    transition: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' },
  },
} as const

/** Infinite rotation for spinners driven by Framer rather than CSS. */
export const spinLoop = {
  animate: { rotate: 360, transition: { duration: 0.9, repeat: Infinity, ease: 'linear' } },
} as const

export const hoverLift = {
  whileHover: { y: -2 },
  whileTap: { y: 0, scale: 0.985 },
  transition: transitions.fast,
} as const

export const pressable = {
  whileHover: { scale: 1.02 },
  whileTap: { scale: 0.96 },
  transition: transitions.fast,
} as const
