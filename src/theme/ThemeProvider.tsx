import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeContext, type AppearanceState, type ThemeContextValue } from './context'
import { DEFAULT_THEME_ID, themeById } from './themes'
import {
  DENSITY_SCALE, DURATION, EASING, FONT_STACKS, RADIUS, cubicBezier,
  type Density, type FontChoice,
} from './tokens'

const STORAGE_KEY = 'cursor-clone.appearance'

const DEFAULTS: AppearanceState = {
  themeId: DEFAULT_THEME_ID,
  font: 'system',
  monoFont: 'mono',
  density: 'normal',
  animations: true,
  blur: true,
  glow: true,
  roundness: 1,
}

function readStored(): AppearanceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<AppearanceState>
    return {
      ...DEFAULTS,
      ...parsed,
      // Guard against a stale theme id from an older build.
      themeId: themeById(parsed.themeId ?? DEFAULTS.themeId).id,
      roundness: Math.min(1.5, Math.max(0.5, Number(parsed.roundness ?? 1))),
    }
  } catch {
    return DEFAULTS
  }
}

/** Writes the resolved token set onto `:root` as custom properties. */
function applyToDocument(state: AppearanceState, reducedMotion: boolean): void {
  const theme = themeById(state.themeId)
  const root = document.documentElement
  const style = root.style

  for (const [name, value] of Object.entries(theme.colors)) {
    // camelCase -> kebab-case: accentContrast becomes --c-accent-contrast.
    const slot = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    style.setProperty(`--c-${slot}`, value)
  }

  for (const [name, value] of Object.entries(RADIUS)) {
    const scaled = name === 'pill' ? value : Math.round(value * state.roundness)
    style.setProperty(`--r-${name}`, `${scaled}px`)
  }

  style.setProperty('--font-ui', FONT_STACKS[state.font])
  style.setProperty('--font-mono', FONT_STACKS[state.monoFont])
  style.setProperty('--font-display', FONT_STACKS.grotesk)
  style.setProperty('--fs-base', `${DENSITY_SCALE[state.density]}px`)

  for (const [name, value] of Object.entries(DURATION)) {
    style.setProperty(`--d-${name}`, reducedMotion ? '0ms' : `${value}ms`)
  }
  style.setProperty('--e-standard', cubicBezier(EASING.standard))
  style.setProperty('--e-decelerate', cubicBezier(EASING.decelerate))
  style.setProperty('--e-accelerate', cubicBezier(EASING.accelerate))
  style.setProperty('--e-spring', cubicBezier(EASING.spring))

  style.setProperty('--blur-glass', state.blur ? '18px' : '0px')
  style.setProperty('--blur-heavy', state.blur ? '32px' : '0px')
  style.setProperty('--glow-strength', state.glow ? '1' : '0')

  root.dataset.theme = theme.id
  root.dataset.mode = theme.mode
  root.dataset.family = theme.family
  root.dataset.density = state.density
  root.dataset.motion = reducedMotion ? 'reduced' : 'full'
  root.dataset.blur = state.blur ? 'on' : 'off'
  root.style.colorScheme = theme.mode
}

/**
 * Owns appearance state and mirrors it into CSS custom properties.
 *
 * Tokens are pushed to the DOM rather than passed through React context to the
 * styles, so a theme switch repaints without re-rendering the tree.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppearanceState>(readStored)
  const [systemReduced, setSystemReduced] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setSystemReduced(query.matches)
    const handler = (event: MediaQueryListEvent) => setSystemReduced(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])

  const reducedMotion = systemReduced || !state.animations

  useEffect(() => {
    applyToDocument(state, reducedMotion)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Private mode or a full quota: appearance simply will not persist.
    }
  }, [state, reducedMotion])

  const setThemeId = useCallback((id: string) => {
    setState(previous => ({ ...previous, themeId: themeById(id).id }))
  }, [])
  const setFont = useCallback((font: FontChoice) => {
    setState(previous => ({ ...previous, font }))
  }, [])
  const setMonoFont = useCallback((monoFont: FontChoice) => {
    setState(previous => ({ ...previous, monoFont }))
  }, [])
  const setDensity = useCallback((density: Density) => {
    setState(previous => ({ ...previous, density }))
  }, [])
  const setAnimations = useCallback((animations: boolean) => {
    setState(previous => ({ ...previous, animations }))
  }, [])
  const setBlur = useCallback((blur: boolean) => {
    setState(previous => ({ ...previous, blur }))
  }, [])
  const setGlow = useCallback((glow: boolean) => {
    setState(previous => ({ ...previous, glow }))
  }, [])
  const setRoundness = useCallback((value: number) => {
    setState(previous => ({ ...previous, roundness: Math.min(1.5, Math.max(0.5, value)) }))
  }, [])
  const reset = useCallback(() => setState(DEFAULTS), [])

  const value = useMemo<ThemeContextValue>(() => ({
    ...state,
    theme: themeById(state.themeId),
    reducedMotion,
    setThemeId,
    setFont,
    setMonoFont,
    setDensity,
    setAnimations,
    setBlur,
    setGlow,
    setRoundness,
    reset,
  }), [
    state, reducedMotion, setThemeId, setFont, setMonoFont, setDensity,
    setAnimations, setBlur, setGlow, setRoundness, reset,
  ])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
