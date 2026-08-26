import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import type {
  ActivateLicenseResult,
  AuthResult,
  AuthUser,
  LicenseStatus,
} from '../shared/types.js'
import { supabase } from '../lib/supabase.js'
import { AUTH_REDIRECT_URL, processAuthCallback } from '../lib/authCallback.js'

/** Persists the LOCAL SQLite session token (licences/quotas IPC key). */
const SESSION_TOKEN_KEY = 'cursor-clone:session-token'
/** Periodic license re-check interval (spec: 30-60 s). */
const LICENSE_POLL_MS = 30_000
/** Safety margin so the timer never fires after the actual expiry. */
const EXPIRY_LEEWAY_MS = 250

/** Reads the persisted session token from localStorage. */
function readStoredToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

/** Persists or clears the session token in localStorage. */
function writeStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_TOKEN_KEY, token)
    else localStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // localStorage unavailable — session simply won't persist.
  }
}

export interface UseAuthState {
  /** True until the first session check resolves. */
  loading: boolean
  user: AuthUser | null
  sessionToken: string | null
  licenseActive: boolean
  licenseType: string | null
  licenseExpiresAt: number | null
  licenseError: string | null
  /** Source de la licence active : « my-creation » ou « gumroad ». */
  licenseSource: 'my-creation' | 'gumroad' | null
  /** Retour du lien de confirmation e-mail (succès ou erreur claire). */
  confirmationNotice: { kind: 'success' | 'error'; text: string } | null
  register(email: string, password: string, name: string): Promise<AuthResult>
  login(email: string, password: string): Promise<AuthResult>
  logout(): Promise<void>
    activateLicense(key: string): Promise<ActivateLicenseResult>
    activateGumroadLicense(key: string): Promise<ActivateLicenseResult>
    deactivateLicense(): Promise<{ success: boolean; removed?: number }>
    refreshLicense(): Promise<void>
    updateProfile(changes: { name?: string; email?: string }): Promise<{ success: boolean; error?: string }>
    changePassword(currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }>
}

/** Narrowed bridge access; the preload script always defines it in production. */
function bridge() {
  if (!window.electronAPI) throw new Error('electronAPI indisponible')
  return window.electronAPI
}

/**
 * useAuth manages the authentication + licensing state of the app.
 *
 * Identity is Supabase Auth (signup / login / logout / session). After a
 * successful Supabase authentication, the identity is mirrored into the local
 * SQLite account via `auth.ensureSupabase`, which returns the local session
 * token consumed by the existing licence/quota/tasks chain.
 *
 * Flow:
 *   boot    -> supabase.auth.getSession() -> bridge -> user + licence status
 *   register -> signUp (email confirmation respected when enabled)
 *   login    -> signInWithPassword
 *   logout   -> signOut() + local cleanup
 */
export function useAuth(): UseAuthState {
  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [licenseSource, setLicenseSource] = useState<'my-creation' | 'gumroad' | null>(null)
  const [confirmationNotice, setConfirmationNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const expiryTimerRef = useRef<number | null>(null)
  const pollTimerRef = useRef<number | null>(null)

  /** Maps a raw Supabase auth error to an explicit French message. */
  const describeSupabaseError = useCallback((error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error ?? '')
    const lower = message.toLowerCase()
    if (lower.includes('invalid login credentials')) return 'Email ou mot de passe incorrect'
    if (lower.includes('email not confirmed')) return 'Confirmez votre adresse email avant de vous connecter.'
    if (lower.includes('already registered') || lower.includes('already exists')) return 'Un compte avec cet email existe déjà'
    if (lower.includes('rate limit')) return 'Trop de tentatives. Réessayez dans un instant.'
    if (lower.includes('failed to fetch') || lower.includes('network')) return 'Impossible de contacter le service d’authentification.'
    return message || 'Une erreur est survenue.'
  }, [])

  /**
   * Bridges a verified Supabase session into the local account chain:
   * mirrors the identity in SQLite and loads the licence status.
   */
  const adoptSupabaseSession = useCallback(async (session: Session): Promise<AuthResult> => {
    const metadata = session.user.user_metadata as { name?: string; full_name?: string } | undefined
    const bridged = await bridge().auth.ensureSupabase({
      supabaseId: session.user.id,
      email: session.user.email ?? '',
      name: metadata?.name ?? metadata?.full_name ?? null,
    })
    if (!bridged.success || !bridged.user || !bridged.sessionToken) {
      return { success: false, error: bridged.error ?? 'Synchronisation du compte impossible' }
    }

    writeStoredToken(bridged.sessionToken)
    setSessionToken(bridged.sessionToken)
    setUser(bridged.user)
    setLicenseStatus(null)
    const status = await bridge().license.getStatus(bridged.sessionToken).catch(() => null)
    if (status) {
      setLicenseStatus(status)
      setLicenseSource(status.source ?? null)
    }
    return { success: true, user: bridged.user, sessionToken: bridged.sessionToken }
  }, [])

  const clearTimers = useCallback((): void => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  /** Re-reads the real status from the main process. */
  const refreshLicense = useCallback(async (): Promise<void> => {
    const token = readStoredToken()
    if (!token) return
    const status = await bridge().license.getStatus(token).catch(() => null)
    if (status) {
      setLicenseStatus(status)
      setLicenseSource(status.source ?? null)
    }
  }, [])

  /**
   * Arms the expiry timer for the current status. Called from an effect keyed
   * on the status itself, so a changed licence replaces the previous timer.
   */
  useEffect(() => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }

    // Lifetime licence (expiresAt null) or already inactive: nothing to arm.
    if (!licenseStatus?.active || !licenseStatus.expiresAt) return

    const delay = Math.max(0, licenseStatus.expiresAt - Date.now() - EXPIRY_LEEWAY_MS)
    expiryTimerRef.current = window.setTimeout(() => { void refreshLicense() }, delay)

    return () => {
      if (expiryTimerRef.current !== null) {
        window.clearTimeout(expiryTimerRef.current)
        expiryTimerRef.current = null
      }
    }
  }, [licenseStatus?.active, licenseStatus?.expiresAt, refreshLicense])

  /** Periodic safety net + wake-from-sleep check, only while licensed. */
  useEffect(() => {
    if (!licenseStatus?.active) return

    pollTimerRef.current = window.setInterval(() => { void refreshLicense() }, LICENSE_POLL_MS)

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refreshLicense()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [licenseStatus?.active, refreshLicense])

  // Unmount cleanup (app teardown).
  useEffect(() => clearTimers, [clearTimers])

  // Restore session on boot from Supabase, then bridge to the local account.
  useEffect(() => {
    let cancelled = false

    async function restore(): Promise<void> {
      if (!window.electronAPI) {
        setLoading(false)
        return
      }

      try {
        const { data, error } = await supabase.auth.getSession()
        if (cancelled) return
        if (error) console.warn('[auth] getSession:', error.message)

        const session = data.session
        if (!session?.user) {
          writeStoredToken(null)
          setSessionToken(null)
          setUser(null)
          setLoading(false)
          return
        }

        const result = await adoptSupabaseSession(session)
        if (cancelled) return
        if (!result.success) {
          // Session Supabase présente mais miroir local impossible :
          // on reste sur l'écran d'accueil plutôt qu'un état incohérent.
          console.error('[auth] pont local impossible:', result.error)
          await supabase.auth.signOut().catch(() => undefined)
          writeStoredToken(null)
          setUser(null)
          setSessionToken(null)
        }
      } catch (error) {
        console.error('[auth] restauration de session impossible:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void restore()

    // Écoute des changements d'authentification (déconnexion distante,
    // expiration de token rafraîchie par Supabase, etc.).
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return
      if (event === 'SIGNED_OUT' || (!session && event === 'TOKEN_REFRESHED')) {
        clearTimers()
        writeStoredToken(null)
        setSessionToken(null)
        setUser(null)
        setLicenseStatus(null)
      }
    })

    /**
     * Callback de confirmation e-mail : l'URL deep link « mycreation:// »
     * est traitée exactement une fois (échange PKCE / erreur explicite),
     * puis la session est adoptée comme après une connexion classique.
     */
    async function handleAuthCallbackUrl(url: string): Promise<void> {
      const outcome = await processAuthCallback(url)
      if (cancelled || !outcome) return
      if (!outcome.session) {
        setConfirmationNotice({ kind: 'error', text: outcome.notice })
        return
      }
      const result = await adoptSupabaseSession(outcome.session)
      if (cancelled) return
      if (result.success) {
        setConfirmationNotice({ kind: 'success', text: outcome.notice })
        return
      }
      console.error('[auth] pont local impossible après confirmation:', result.error)
      setConfirmationNotice({
        kind: 'error',
        text: 'Adresse confirmée, mais la session locale a échoué. Reconnectez-vous.',
      })
    }

    // Cas froid (application lancée PAR le lien e-mail) et cas chaud
    // (lien reçu pendant que l'application tourne).
    let unsubscribeCallback: (() => void) | null = null
    if (window.electronAPI) {
      void window.electronAPI.auth.takeAuthCallback()
        .then(url => { if (url) void handleAuthCallbackUrl(url) })
        .catch(() => undefined)
      unsubscribeCallback = window.electronAPI.auth.onAuthCallback(url => { void handleAuthCallbackUrl(url) })
    }

    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
      unsubscribeCallback?.()
    }
  }, [adoptSupabaseSession, clearTimers])

  const register = useCallback(
    async (email: string, password: string, name: string): Promise<AuthResult> => {
      try {
        setConfirmationNotice(null)
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { name },
            // Le lien de confirmation revient dans l'application via le deep
            // link « mycreation://auth/callback » (allowlist Supabase).
            // Sans lui, Supabase retombe sur le Site URL du projet et le
            // retour se perd dans le navigateur externe.
            emailRedirectTo: AUTH_REDIRECT_URL,
          },
        })
        if (error) return { success: false, error: describeSupabaseError(error) }

        // Confirmation email activée : aucune session tant que l'utilisateur
        // n'a pas cliqué sur le lien. Le compte existe réellement chez Supabase.
        if (!data.session) {
          return { success: true, pendingConfirmation: true }
        }
        return await adoptSupabaseSession(data.session)
      } catch (error) {
        return { success: false, error: describeSupabaseError(error) }
      }
    },
    [adoptSupabaseSession, describeSupabaseError],
  )

  const login = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    try {
      setConfirmationNotice(null)
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) return { success: false, error: describeSupabaseError(error) }
      if (!data.session) return { success: false, error: 'Connexion impossible.' }
      return await adoptSupabaseSession(data.session)
    } catch (error) {
      return { success: false, error: describeSupabaseError(error) }
    }
  }, [adoptSupabaseSession, describeSupabaseError])

  const logout = useCallback(async (): Promise<void> => {
    // 1) Coupe toute requête IA/agent en cours (abort + listeners).
    const bridgeNow = window.electronAPI
    if (bridgeNow) {
      await bridgeNow.ai.cancel().catch(() => undefined)
      await bridgeNow.agentExtra.cancelAll().catch(() => undefined)
    }
    // 2) Invalide la session locale (SQLite) puis la session Supabase.
    if (sessionToken) {
      await bridgeNow?.auth.logout(sessionToken).catch(() => undefined)
    }
    await supabase.auth.signOut().catch(error => {
      console.warn('[auth] signOut:', error instanceof Error ? error.message : error)
    })
    // 3) Timers d'expiration + états renderer.
    clearTimers()
    writeStoredToken(null)
    setSessionToken(null)
    setUser(null)
    setLicenseStatus(null)
  }, [sessionToken, clearTimers])

  const updateProfile = useCallback(
    async (changes: { name?: string; email?: string }) => {
      if (!sessionToken) return { success: false, error: 'Non connecté' }
      const nextEmail = typeof changes.email === 'string' ? changes.email.trim().toLowerCase() : undefined
      if (nextEmail) {
        // L'e-mail est l'identifiant de connexion : la vérité est chez Supabase.
        // updateUser({ email }) envoie un e-mail de confirmation à la nouvelle
        // adresse ; le changement n'est effectif qu'une fois confirmé.
        const { data } = await supabase.auth.getSession()
        const currentEmail = data.session?.user?.email ?? null
        if (currentEmail && currentEmail.toLowerCase() !== nextEmail) {
          const { error } = await supabase.auth.updateUser({ email: nextEmail })
          if (error) return { success: false, error: describeSupabaseError(error) }
        }
      }
      const result = await bridge().auth.updateProfile(sessionToken, changes)
      if (result.success && result.user) setUser(result.user)
      return { success: result.success, error: result.error }
    },
    [sessionToken, describeSupabaseError],
  )

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> => {
      if (!sessionToken) return { success: false, error: 'Non connecté' }
      if (!newPassword || newPassword.length < 8) {
        return { success: false, error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' }
      }
      // Les comptes créés via l'app s'authentifient UNIQUEMENT chez Supabase
      // (le hash local est volontairement inutilisable) : re-vérification
      // réelle de l'ancien mot de passe puis mise à jour chez Supabase.
      const { data } = await supabase.auth.getSession()
      if (data.session?.user) {
        try {
          const email = data.session.user.email ?? ''
          const reauth = await supabase.auth.signInWithPassword({ email, password: currentPassword })
          if (reauth.error) {
            const invalid = reauth.error.message.toLowerCase().includes('invalid login credentials')
            return { success: false, error: invalid ? 'Ancien mot de passe incorrect' : describeSupabaseError(reauth.error) }
          }
          const update = await supabase.auth.updateUser({ password: newPassword })
          if (update.error) return { success: false, error: describeSupabaseError(update.error) }
          return { success: true }
        } catch (error) {
          return { success: false, error: describeSupabaseError(error) }
        }
      }
      // Repli historique : compte local sans identité Supabase.
      const result = await bridge().auth.changePassword(sessionToken, currentPassword, newPassword)
      if (result.success && result.sessionToken) {
        writeStoredToken(result.sessionToken)
        setSessionToken(result.sessionToken)
      }
      return { success: result.success, error: result.error }
    },
    [sessionToken, describeSupabaseError],
  )

  const activateLicense = useCallback(
    async (key: string): Promise<ActivateLicenseResult> => {
      if (!sessionToken) {
        return { success: false, error: 'Vous devez être connecté pour activer une licence' }
      }
      const result = await bridge().license.activate(sessionToken, key)
      if (result.success) {
        await refreshLicense()
      }
      return result
    },
    [sessionToken, refreshLicense],
  )

  /** Active une licence Gumroad (lifetime) — vérification côté main process. */
  const activateGumroadLicense = useCallback(
    async (key: string): Promise<ActivateLicenseResult> => {
      if (!sessionToken) {
        return { success: false, error: 'Vous devez être connecté pour activer une licence' }
      }
      const result = await bridge().license.activateGumroad(sessionToken, key)
      if (result.success) {
        await refreshLicense()
      }
      return result
    },
    [sessionToken, refreshLicense],
  )

  /** Désactive les licences locales du compte -> retour FREE immédiat. */
  const deactivateLicense = useCallback(
    async (): Promise<{ success: boolean; removed?: number }> => {
      if (!sessionToken) return { success: false, removed: 0 }
      const result = await bridge().license.deactivate(sessionToken).catch(() => ({ success: false }) as { success: boolean; removed?: number })
      await refreshLicense()
      return result
    },
    [sessionToken, refreshLicense],
  )

  return {
    loading,
    user,
    sessionToken,
    licenseActive: licenseStatus?.active ?? false,
    licenseType: licenseStatus?.type ?? null,
    licenseExpiresAt: licenseStatus?.expiresAt ?? null,
    licenseError: licenseStatus?.error ?? null,
    licenseSource: licenseStatus?.source ?? licenseSource,
    confirmationNotice,
    register,
    login,
    logout,
    activateLicense,
    activateGumroadLicense,
    deactivateLicense,
    refreshLicense,
    updateProfile,
    changePassword,
  }
}
