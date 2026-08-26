/**
 * Traitement du callback de confirmation e-mail Supabase.
 *
 * Le lien reçu par e-mail s'ouvre dans le navigateur EXTERNE, puis revient
 * vers l'application via le deep link « mycreation://auth/callback » :
 *   - succès (flux PKCE)  : mycreation://auth/callback?code=<authorization_code>
 *   - succès (repli implicite) : mycreation://auth/callback#access_token=…&refresh_token=…
 *   - échec               : mycreation://auth/callback#error=access_denied&error_code=otp_expired&error_description=…
 *
 * L'URL est capturée par le main process, transmise au renderer, puis traitée
 * ICI exactement une fois : l'échange du code consomme le verifier PKCE stocké
 * localement au moment du signUp() et établit la session Supabase.
 */
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase.js'

/** URL passée à Supabase comme `emailRedirectTo` lors du signUp(). Doit figurer dans la allowlist « Redirect URLs » du projet. */
export const AUTH_REDIRECT_URL = 'mycreation://auth/callback'

const AUTH_URL_PREFIX = 'mycreation://'

export interface AuthCallbackErrorPayload {
  kind: 'error'
  /** ex. « otp_expired », « access_denied ». */
  errorCode: string | null
  description: string
}

export type AuthCallbackPayload =
  | { kind: 'code'; code: string }
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | AuthCallbackErrorPayload

export interface AuthCallbackOutcome {
  success: boolean
  /** Session établie avec succès (à adopter via useAuth). */
  session?: Session
  /** Message utilisateur prêt à afficher (succès ou erreur claire). */
  notice: string
}

/** Extrait la charge utile d'authentification d'une URL de deep link. */
export function parseAuthCallback(rawUrl: string): AuthCallbackPayload | null {
  if (!rawUrl || !rawUrl.toLowerCase().startsWith(AUTH_URL_PREFIX)) return null

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  const params = url.searchParams
  const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  const first = (...names: string[]): string | null => {
    for (const name of names) {
      const value = params.get(name) ?? hashParams.get(name)
      if (value !== null && value !== '') return value
    }
    return null
  }

  // Supabase signale les liens invalides/expirés/consommés via error=access_denied.
  const errorCode = first('error_code')
  const errorDescription = first('error_description') ?? ''
  if (first('error') === 'access_denied' || errorCode || errorDescription) {
    return { kind: 'error', errorCode, description: errorDescription }
  }

  const code = first('code')
  if (code) return { kind: 'code', code }

  const accessToken = first('access_token')
  const refreshToken = first('refresh_token')
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken }

  return null
}

/** Message utilisateur explicite pour une erreur de lien de confirmation. */
export function describeAuthCallbackError(errorCode: string | null, description: string): string {
  const code = (errorCode ?? '').toLowerCase()
  if (code === 'otp_expired' || code === 'otp_disabled') {
    return 'Le lien de confirmation est invalide ou a déjà été utilisé. '
      + 'Connectez-vous directement avec votre mot de passe, ou recréez votre compte pour recevoir un nouvel email.'
  }
  if (code === 'access_denied') {
    return description || 'La confirmation a été refusée. Demandez un nouvel email de confirmation.'
  }
  return description || 'Le lien de confirmation est invalide.'
}

/** Message pour un échec d'échange code ↔ session (code déjà consommé, verifier absent…). */
function describeExchangeFailure(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('verifier') || lower.includes('code challenge')) {
    return 'Ce lien de confirmation ne correspond plus à cette installation. Connectez-vous directement.'
  }
  if (lower.includes('already') || lower.includes('invalid or expired')) {
    return 'Ce lien de confirmation a déjà été utilisé ou a expiré. Connectez-vous directement.'
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Impossible de finaliser la confirmation (réseau). Réessayez ou connectez-vous directement.'
  }
  return 'La confirmation a échoué. Connectez-vous directement avec votre mot de passe.'
}

/** URLs déjà traitées : un même deep link n'est jamais consommé deux fois. */
const processedUrls = new Set<string>()

/**
 * Traite une URL de deep link d'authentification exactement UNE fois.
 * Retourne null pour une URL ignorée (étrangère ou doublon).
 */
export async function processAuthCallback(rawUrl: string): Promise<AuthCallbackOutcome | null> {
  const key = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!key || processedUrls.has(key)) return null
  processedUrls.add(key)

  const payload = parseAuthCallback(key)
  if (!payload) return null

  if (payload.kind === 'error') {
    return { success: false, notice: describeAuthCallbackError(payload.errorCode, payload.description) }
  }

  try {
    // Flux nominal PKCE : échange du code contre la session (verifier local).
    if (payload.kind === 'code') {
      const { data, error } = await supabase.auth.exchangeCodeForSession(payload.code)
      if (error) return { success: false, notice: describeExchangeFailure(error.message) }
      if (!data.session) return { success: false, notice: describeExchangeFailure('session manquante') }
      return { success: true, session: data.session, notice: 'Adresse email confirmée.' }
    }

    // Repli historique (flux implicite) : pose directe des tokens reçus.
    const { data, error } = await supabase.auth.setSession({
      access_token: payload.accessToken,
      refresh_token: payload.refreshToken,
    })
    if (error) return { success: false, notice: describeExchangeFailure(error.message) }
    if (!data.session) return { success: false, notice: describeExchangeFailure('session manquante') }
    return { success: true, session: data.session, notice: 'Adresse email confirmée.' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? '')
    return { success: false, notice: describeExchangeFailure(message) }
  }
}
