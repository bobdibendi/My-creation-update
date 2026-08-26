// ─── Intégration Gumroad (abonnements + lifetime) ──────────────────────
//
// Deuxième source d'activation à côté du License Generator interne (JWT
// RS256). Une clé Gumroad validée est convertie en licence interne stockée
// dans SQLite, et le plan effectif reste résolu par la couche license-plan.
//
// API réelle utilisée : POST {apiBase}/v2/licenses/verify
//   body : product_id + license_key — AUCUN token d'API requis.
// Champs exploités dans purchase (documentation officielle) :
//   success                     -> clé connue du produit
//   product_id                  -> identifiant du produit validé
//   sale_id / sale_timestamp    -> dernier paiement (AVANCE à chaque
//                                  renouvellement, même license_key)
//   email                       -> acheteur
//   refunded / disputed /
//   chargebacked / disabled     -> accès retiré
//   subscription_id             -> présent si achat lié à un abonnement
//   subscription_cancelled_at   -> annulation demandée (période payée continue)
//   subscription_failed_at      -> paiement échoué (dunning)
//   subscription_ended_at       -> abonnement réellement terminé
//   test                        -> achat de test
//
// SÉCURITÉ :
//   - ce module tourne EXCLUSIVEMENT dans le main process ;
//   - aucun secret Gumroad n'existe côté client : la vérification publique
//     suffit ; un éventuel API token resterait sur un backend dédié ;
//   - les Product IDs publics viennent de config/gumroad-products.ts,
//     surchargeables par variables d'environnement.

import { GUMROAD_BUILD_PRODUCTS, isRecurrence, type SubscriptionRecurrence } from './config/gumroad-products.js'

export type GumroadPlan = 'pro' | 'pro_ultimate'

/** Statut normalisé d'un abonnement, aligné sur les états réels Gumroad. */
export type SubscriptionStatus =
  | 'ACTIVE'
  | 'CANCELLED_BUT_ACTIVE'
  | 'EXPIRED'
  | 'FAILED'
  | 'REFUNDED'
  | 'INVALID'

export interface GumroadConfig {
  /** Product ID Gumroad du plan PRO. */
  proProductId: string | null
  /** Product ID Gumroad du plan PRO ULTIMATE. */
  ultimateProductId: string | null
  /** Récurrence facturée par produit (calcul de fin de période). */
  recurrences: Record<string, SubscriptionRecurrence>
  /** Base API (sans /v2/...). Surcharge test uniquement. */
  apiBase: string
}

/** Lit la configuration : env d'abord, sinon valeurs embarquées au build. */
export function readGumroadConfig(env: NodeJS.ProcessEnv = process.env): GumroadConfig {
  const trim = (value: string | undefined): string | null => {
    const cleaned = value?.trim()
    return cleaned ? cleaned : null
  }
  const recurrence = (raw: string | undefined, fallback: SubscriptionRecurrence): SubscriptionRecurrence => {
    const cleaned = raw?.trim().toLowerCase()
    return cleaned && isRecurrence(cleaned) ? cleaned : fallback
  }
  const recurrences: Record<string, SubscriptionRecurrence> = {}
  if (GUMROAD_BUILD_PRODUCTS.PRO_PRODUCT_ID) recurrences[GUMROAD_BUILD_PRODUCTS.PRO_PRODUCT_ID] =
    recurrence(env.MC_SUB_PRO_RECURRENCE, GUMROAD_BUILD_PRODUCTS.PRO_RECURRENCE as SubscriptionRecurrence)
  if (GUMROAD_BUILD_PRODUCTS.PRO_ULTIMATE_PRODUCT_ID) recurrences[GUMROAD_BUILD_PRODUCTS.PRO_ULTIMATE_PRODUCT_ID] =
    recurrence(env.MC_SUB_PRO_ULTIMATE_RECURRENCE, GUMROAD_BUILD_PRODUCTS.PRO_ULTIMATE_RECURRENCE as SubscriptionRecurrence)

  return {
    proProductId: trim(env.GUMROAD_PRO_PRODUCT_ID) ?? (GUMROAD_BUILD_PRODUCTS.PRO_PRODUCT_ID || null),
    ultimateProductId: trim(env.GUMROAD_PRO_ULTIMATE_PRODUCT_ID) ?? (GUMROAD_BUILD_PRODUCTS.PRO_ULTIMATE_PRODUCT_ID || null),
    recurrences,
    apiBase: trim(env.GUMROAD_API_URL) ?? 'https://api.gumroad.com',
  }
}

export type Recurrence = SubscriptionRecurrence

/** Fin de période payée : dernier paiement + cadence produit. */
export function computePeriodEndsAt(saleTimestampMs: number, cadence: Recurrence): number {
  const monthMs = 30 * 24 * 60 * 60 * 1000
  return saleTimestampMs + (cadence === 'yearly' ? 365 * monthMs : monthMs)
}

/**
 * Résout le statut réel d'un abonnement Gumroad.
 *
 * Fonction PURE (aucune dépendance Electron) : testable en Node avec une
 * horloge injectée. Politique hors-ligne intégrée :
 *  - les états datés déterministes (fin de période après annulation,
 *    ended_at, failed_at, refund) s'appliquent même hors ligne ;
 *  - un abonnement ACTIF sans preuve de renouvellement n'expire que après
 *    periodEndsAt + renewalGraceMs (tolérance réseau/dunning), jamais avant :
 *    une panne internet ne coupe jamais PRO brutalement.
 */
export function resolveSubscriptionState(
  data: {
    refunded?: boolean
    disabled?: boolean
    chargebacked?: boolean
    disputed?: boolean
    subscriptionId?: string | null
    cancelledAt?: number | null
    failedAt?: number | null
    endedAt?: number | null
    saleTimestamp?: number | null
    periodEndsAt?: number | null
    validatedAt?: number
  },
  options: { nowMs: number; renewalGraceMs?: number },
): { status: SubscriptionStatus; active: boolean } {
  const now = options.nowMs
  const renewalGraceMs = options.renewalGraceMs ?? DEFAULT_RENEWAL_GRACE_MS

  if (data.refunded || data.chargebacked || data.disputed || data.disabled) {
    return { status: 'REFUNDED', active: false }
  }

  // Achat unique (lifetime) sans abonnement : actif tant que non remboursé.
  if (!data.subscriptionId) {
    return { status: 'ACTIVE', active: true }
  }

  if (data.endedAt !== null) return { status: 'EXPIRED', active: false }
  if (data.failedAt !== null) return { status: 'FAILED', active: false }

  if (data.cancelledAt !== null) {
    if (typeof data.periodEndsAt === 'number' && now <= data.periodEndsAt) {
      return { status: 'CANCELLED_BUT_ACTIVE', active: true }
    }
    return { status: 'EXPIRED', active: false }
  }

  // Abonnement toujours actif chez Gumroad : on exige une preuve de
  // renouvellement au-delà de la période théorique + tolérance.
  const hardLimit = typeof data.periodEndsAt === 'number'
    ? data.periodEndsAt + renewalGraceMs
    : (data.validatedAt ?? now) + renewalGraceMs
  if (now > hardLimit) return { status: 'EXPIRED', active: false }

  return { status: 'ACTIVE', active: true }
}

export const DEFAULT_RENEWAL_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** Réponse partielle mais suffisante de POST /v2/licenses/verify. */
interface GumroadVerifyResponse {
  success?: boolean
  message?: string
  purchase?: {
    email?: string
    product_id?: string
    sale_id?: number | string
    sale_timestamp?: string
    refunded?: boolean
    chargebacked?: boolean
    disputed?: boolean
    disabled?: boolean
    subscription_id?: string | null
    subscription_cancelled_at?: string | null
    subscription_failed_at?: string | null
    subscription_ended_at?: string | null
    test?: boolean
  }
}

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export type GumroadOutcome =
  | {
      ok: true
      plan: GumroadPlan
      productId: string
      saleId: string | null
      email: string | null
      /** Dernier paiement connu (renouvellements inclus). */
      saleTimestamp: number | null
      /** Présent si l'achat appartient à un abonnement Gumroad. */
      subscription: {
        id: string
        cancelledAt: number | null
        failedAt: number | null
        endedAt: number | null
      } | null
      /** Achat de test Gumroad : activable, signalé pour information. */
      test: boolean
    }
  | { ok: false; error: string; kind: 'invalid' | 'refunded' | 'unconfigured' | 'network' }

/** Contrat fournisseur d'abonnement : implémenté par Gumroad ET par le
 *  provider de test local (mode développement uniquement). */
export interface SubscriptionProvider {
  readonly configured: boolean
  resolvePlan(productId: string): GumroadPlan | null
  cadenceFor(productId: string): Recurrence
  verifyLicenseKey(licenseKey: string): Promise<GumroadOutcome>
}

/**
 * Vérifie une License Key Gumroad et en déduit le plan acheté.
 *
 * Le client n'a pas à connaître le Product ID : on interroge l'API avec
 * chaque produit configuré jusqu'à correspondance — la première réponse
 * positive détermine à la fois la validité ET le plan.
 */
export class GumroadService implements SubscriptionProvider {
  constructor(private readonly config: GumroadConfig) {}

  /** Plan associé à un Product ID configuré, sinon null. */
  resolvePlan(productId: string): GumroadPlan | null {
    if (this.config.proProductId && productId === this.config.proProductId) return 'pro'
    if (this.config.ultimateProductId && productId === this.config.ultimateProductId) return 'pro_ultimate'
    return null
  }

  cadenceFor(productId: string): Recurrence {
    return this.config.recurrences[productId] ?? 'monthly'
  }

  /** Aucun produit Gumroad configuré sur cette installation. */
  get configured(): boolean {
    return this.config.proProductId !== null || this.config.ultimateProductId !== null
  }

  async verifyLicenseKey(licenseKey: string): Promise<GumroadOutcome> {
    const ids = [this.config.proProductId, this.config.ultimateProductId]
      .filter((id): id is string => id !== null)

    if (ids.length === 0) {
      return {
        ok: false,
        kind: 'unconfigured',
        error: 'Aucun produit Gumroad n\'est configuré sur cette installation de My Creation.',
      }
    }

    let lastMessage = 'Clé de licence Gumroad invalide.'
    for (const productId of ids) {
      let response: Response
      try {
        response = await fetch(`${this.config.apiBase}/v2/licenses/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ product_id: productId, license_key: licenseKey }).toString(),
          signal: AbortSignal.timeout(12_000),
        })
      } catch {
        // Indisponibilité réseau : inutile de tester les autres produits.
        return {
          ok: false,
          kind: 'network',
          error: 'Vérification Gumroad impossible : connexion internet indisponible.',
        }
      }

      if (!response.ok) {
        if (response.status === 404) {
          lastMessage = 'Clé de licence Gumroad invalide.'
          continue
        }
        lastMessage = `Le service Gumroad a répondu HTTP ${response.status}.`
        continue
      }

      let payload: GumroadVerifyResponse
      try {
        payload = await response.json() as GumroadVerifyResponse
      } catch {
        lastMessage = 'Réponse illisible du service Gumroad.'
        continue
      }

      if (!payload.success || !payload.purchase) {
        lastMessage = payload.message ? `Gumroad : ${payload.message}` : 'Clé de licence Gumroad invalide.'
        continue
      }

      const purchase = payload.purchase
      const productIdResolved = String(purchase.product_id ?? productId)
      const plan = this.resolvePlan(productIdResolved)
      if (!plan) {
        lastMessage = 'Cette licence Gumroad ne correspond à aucun produit My Creation.'
        continue
      }

      // Remboursé / litigieux / désactivé -> activation refusée.
      if (purchase.refunded === true || purchase.chargebacked === true
        || purchase.disputed === true || purchase.disabled === true) {
        return {
          ok: false,
          kind: 'refunded',
          error: 'Cette licence Gumroad a été remboursée ou désactivée : elle ne peut plus être activée.',
        }
      }

      const subscriptionId = typeof purchase.subscription_id === 'string' && purchase.subscription_id.length > 0
        ? purchase.subscription_id
        : null

      return {
        ok: true,
        plan,
        productId: productIdResolved,
        saleId: purchase.sale_id !== undefined ? String(purchase.sale_id) : null,
        email: typeof purchase.email === 'string' ? purchase.email : null,
        saleTimestamp: parseDate(purchase.sale_timestamp),
        subscription: subscriptionId
          ? {
              id: subscriptionId,
              cancelledAt: parseDate(purchase.subscription_cancelled_at),
              failedAt: parseDate(purchase.subscription_failed_at),
              endedAt: parseDate(purchase.subscription_ended_at),
            }
          : null,
        test: purchase.test === true,
      }
    }

    return { ok: false, kind: 'invalid', error: lastMessage }
  }
}
