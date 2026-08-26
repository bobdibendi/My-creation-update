import { useCallback, useEffect, useState } from 'react'
import type { PlanInfo, UsageSummary } from '../shared/types'

const POLL_MS = 15_000

export interface UseSubscriptionState {
  loading: boolean
  error: string | null
  summary: UsageSummary | null
  plans: PlanInfo[]
  refresh(): Promise<void>
}

/**
 * Abonnement IA : consommation temps réel du compte.
 *
 * La source de vérité est le processus main (QuotaService + SQLite) ; le
 * renderer ne peut jamais écrire le compteur. Les mises à jour poussées
 * (`quota:update`) rafraîchissent l'affichage sans attendre le poll.
 */
export function useSubscription(sessionToken: string | null): UseSubscriptionState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [plans, setPlans] = useState<PlanInfo[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = window.electronAPI
    if (!bridge || !sessionToken) {
      setLoading(false)
      return
    }
    try {
      const [usage, catalogue] = await Promise.all([
        bridge.subscription.usage(sessionToken),
        bridge.subscription.plans(),
      ])
      setSummary(usage)
      setPlans(catalogue)
      setError(null)
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionToken])

  useEffect(() => {
    void refresh()

    const bridge = window.electronAPI
    const disposeUpdate = bridge?.subscription.onUpdate(setSummary)

    const timer = sessionToken ? window.setInterval(() => { void refresh() }, POLL_MS) : null

    return () => {
      disposeUpdate?.()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [refresh, sessionToken])

  // New period: reset times arrive without any AI activity.
  useEffect(() => {
    if (!summary) return
    if (summary.nextResetAt <= Date.now()) void refresh()
  }, [summary, refresh])

  return { loading, error, summary, plans, refresh }
}

/** Formats a token count as a compact human string (2,58M / 980K…). */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} K`
  }
  return value.toLocaleString('fr-FR')
}
