import type { PlanType } from './plans.js'
import { isPlanType } from './plans.js'

// ─── Licence -> Plan ───────────────────────────────────
//
// Le plan d'adhésion MY CREATION est porté par le claim `plan` du JWT
// (free / pro / pro_ultimate), généré par le License Generator. Les licences
// plus anciennes n'ont pas ce claim mais pouvaient porter
// type = 'pro_ultimate' : cette forme reste supportée.
//
// La DURÉE reste portée par type ('lifetime' | 'subscription') + exp.
// Les deux axes sont donc indépendants :
//   plan  -> permissions et modèles disponibles
//   durée -> expiration

export interface LicensePlanSource {
  /** Claim plan du JWT, s'il existe. */
  plan?: string | null
  /** Type historique : 'lifetime' | 'subscription' | 'pro_ultimate'. */
  type?: string | null
}

/**
 * Résout le plan effectif d'une licence.
 * Un claim `plan` valide prime ; sinon on retombe sur l'historique
 * `type === 'pro_ultimate'` ; sinon FREE.
 */
export function resolveLicensedPlan(source: LicensePlanSource | null | undefined): PlanType {
  if (!source) return 'free'
  if (typeof source.plan === 'string' && isPlanType(source.plan)) return source.plan
  if (source.type === 'pro_ultimate') return 'pro_ultimate'
  return 'free'
}

/** Sous-ensemble du statut renvoyé par LicenseService.getLicenseStatus(). */
export interface VerifiedLicenseStatusLike {
  active: boolean
  type: string | null
  plan?: 'free' | 'pro' | 'pro_ultimate' | null
}

/**
 * Plan effectif depuis le statut VÉRIFIÉ de la licence : claim `plan` du JWT
 * RS256 re-validé (licence interne) ou Product ID résolu chez le fournisseur
 * (licence Gumroad). Une licence absente, inactive ou expirée retombe sur FREE.
 *
 * Ne JAMAIS alimenter cette fonction avec licenseData brut : ce champ SQLite
 * est éditable sur disque et n'est PAS une source de vérité — le re-parsing
 * du JSON stocké permettrait une élévation de plan sans posséder la clé.
 */
export function planFromVerifiedStatus(status: VerifiedLicenseStatusLike | null | undefined): PlanType {
  if (!status?.active) return 'free'
  return resolveLicensedPlan({ plan: status.plan, type: status.type })
}
