/**
 * Design tokens.
 *
 * Everything the UI paints with is declared here once and exposed to CSS as
 * custom properties. Components never hardcode a colour: they read a variable,
 * which is what makes theme switching instant and total.
 */

/** Colour slots every theme must fill. */
export interface ThemeColors {
  /** Application backdrop, behind every surface. */
  bg: string
  /** Slightly raised backdrop used by rails and gutters. */
  bgAlt: string
  /** Default panel surface. */
  surface: string
  /** Nested surface: cards inside panels, inputs, code blocks. */
  surface2: string
  /** Highest surface: menus, popovers, modals. */
  surface3: string
  /** Translucent glass fill, layered over blurred content. */
  glass: string
  /** Accent used for focus, selection and primary actions. */
  accent: string
  /** Readable foreground on top of `accent`. */
  accentContrast: string
  /** Low-opacity accent wash for active rows and badges. */
  accentSoft: string
  /** Accent glow used by shadows and rings. */
  accentGlow: string
  text: string
  textDim: string
  textFaint: string
  border: string
  borderStrong: string
  success: string
  warning: string
  danger: string
  info: string
  /** Syntax-ish hues reused by file icons, chips and charts. */
  hue1: string
  hue2: string
  hue3: string
  hue4: string
  hue5: string
}

export type ThemeMode = 'dark' | 'light'

export type ThemeFamily = 'claude' | 'cursor' | 'chatgpt' | 'arc'

export interface ThemeDefinition {
  id: string
  label: string
  family: ThemeFamily
  mode: ThemeMode
  description: string
  colors: ThemeColors
}

/** Radius scale, in pixels. Generous by design: 16-24px on containers. */
export const RADIUS = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const

/** Spacing scale, in pixels. */
export const SPACE = {
  '0': 0,
  '1': 2,
  '2': 4,
  '3': 6,
  '4': 8,
  '5': 12,
  '6': 16,
  '7': 20,
  '8': 24,
  '9': 32,
  '10': 40,
  '11': 56,
} as const

/** Named durations, in milliseconds, shared by CSS and Framer Motion. */
export const DURATION = {
  instant: 90,
  fast: 140,
  normal: 200,
  slow: 320,
  slower: 480,
} as const

/** Easing curves as cubic-bezier control points. */
export const EASING = {
  /** Default: fast out, settled in. Feels responsive without overshoot. */
  standard: [0.22, 0.61, 0.36, 1] as const,
  /** Entrances that should feel like they were already in motion. */
  decelerate: [0.05, 0.7, 0.1, 1] as const,
  /** Exits that should get out of the way immediately. */
  accelerate: [0.3, 0, 0.8, 0.15] as const,
  /** Slight overshoot for affordances that reward interaction. */
  spring: [0.34, 1.42, 0.64, 1] as const,
} as const

/** Font stacks. No web fonts: the app's CSP forbids external font sources. */
export const FONT_STACKS = {
  system:
    "-apple-system,BlinkMacSystemFont,'Segoe UI Variable Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  grotesk:
    "'Segoe UI Variable Display','Segoe UI Semibold','SF Pro Display',Inter,system-ui,sans-serif",
  serif: "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,'Times New Roman',serif",
  mono: "'Cascadia Code','Cascadia Mono','JetBrains Mono','Fira Code',Consolas,'SF Mono',Menlo,monospace",
} as const

export type FontChoice = keyof typeof FONT_STACKS

export const FONT_LABELS: Record<FontChoice, string> = {
  system: 'Système',
  grotesk: 'Display',
  serif: 'Serif',
  mono: 'Monospace',
}

/** Base UI font size in pixels, per density preference. */
export const DENSITY_SCALE = {
  compact: 12.5,
  normal: 13.5,
  comfortable: 15,
} as const

export type Density = keyof typeof DENSITY_SCALE

export const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Compacte',
  normal: 'Normale',
  comfortable: 'Confortable',
}

export function cubicBezier(points: readonly [number, number, number, number]): string {
  return `cubic-bezier(${points.join(',')})`
}
