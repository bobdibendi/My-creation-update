import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import fr from './fr.json'
import en from './en.json'

export type Locale = 'fr' | 'en'

const LOCALE_KEY = 'my-creation.locale'

const DICTIONARIES: Record<Locale, Record<string, unknown>> = {
  fr,
  en,
}

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'fr', label: 'Français' },
  { id: 'en', label: 'English' },
]

/** Prêt pour : de, es, it — il suffit d'ajouter un JSON + une entrée ici. */
function readStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY)
    if (stored === 'fr' || stored === 'en') return stored
  } catch { /* stockage indisponible */ }
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

function resolve(dictionary: Record<string, unknown>, key: string): string | null {
  let current: unknown = dictionary
  for (const part of key.split('.')) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' ? current : null
}

export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const raw = resolve(DICTIONARIES[locale], key)
    ?? resolve(DICTIONARIES.fr, key)
    ?? key
  if (!params) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{{${name}}}`)
}

export interface I18n {
  locale: Locale
  t: (key: string, params?: Record<string, string | number>) => string
  setLocale: (locale: Locale) => void
}

const I18nContext = createContext<I18n>({
  locale: 'fr',
  t: (key, params) => translate('fr', key, params),
  setLocale: () => undefined,
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try { localStorage.setItem(LOCALE_KEY, next) } catch { /* session only */ }
    document.documentElement.lang = next
  }, [])

  // Applique la langue au document dès le premier rendu.
  if (typeof document !== 'undefined') document.documentElement.lang = locale

  const value = useMemo<I18n>(() => ({
    locale,
    setLocale,
    t: (key, params) => translate(locale, key, params),
  }), [locale, setLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  return useContext(I18nContext)
}
