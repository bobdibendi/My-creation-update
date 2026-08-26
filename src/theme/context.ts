import { createContext, useContext } from 'react'
import type { Density, FontChoice, ThemeDefinition } from './tokens'

export interface AppearanceState {
  themeId: string
  font: FontChoice
  monoFont: FontChoice
  density: Density
  /** Master switch for motion; also honours prefers-reduced-motion. */
  animations: boolean
  /** Background blur on glass surfaces. Costly on weak GPUs. */
  blur: boolean
  /** Subtle accent glow on active surfaces. */
  glow: boolean
  /** UI corner roundness multiplier, 0.5 to 1.5. */
  roundness: number
}

export interface ThemeContextValue extends AppearanceState {
  theme: ThemeDefinition
  /** True when motion should be suppressed, animations flag included. */
  reducedMotion: boolean
  setThemeId: (id: string) => void
  setFont: (font: FontChoice) => void
  setMonoFont: (font: FontChoice) => void
  setDensity: (density: Density) => void
  setAnimations: (value: boolean) => void
  setBlur: (value: boolean) => void
  setGlow: (value: boolean) => void
  setRoundness: (value: number) => void
  reset: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

/** Throws when used outside the provider: that is a wiring bug, not a state. */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme doit être utilisé dans ThemeProvider')
  return value
}
