// ─── Plans, permissions et abonnement IA de MY CREATION ────────────────
//
// Configuration centrale : les quotas et droits ne sont jamais codés en dur
// dans l'UI React. Source unique exposée au renderer via `subscription:plans`
// et `permissions:get`.
//
// Les limites exactes des plans payants n'étant pas encore définies par le
// fournisseur, elles restent configurables (valeur `null` = illimité/non
// défini) et surchargeables par variables d'environnement :
//   MY_CREATION_PLAN_PRO_DAILY_TOKENS
//   MY_CREATION_PLAN_PRO_ULTIMATE_DAILY_TOKENS

export type PlanType = 'free' | 'pro' | 'pro_ultimate'

export type UsageKind = 'chat' | 'agent' | 'other'

/** Droits accordés par un plan, évalués côté main process. */
export interface Permissions {
  chat: boolean
  agent: boolean
  /** Modèle intégré Kim Pro — inclus dans tous les plans. */
  builtinFreeModels: boolean
  /** Modèle intégré Ox Alpha — inclus à partir du plan PRO. */
  oxAlphaModels: boolean
  /** Modèles premium (clé personnelle / catalogue étendu) — PRO ULTIMATE. */
  premiumModels: boolean
  /** Outils avancés du mode Agent. */
  advancedTools: boolean
  /** Accès prioritaire au pool de clés. */
  priorityAccess: boolean
}

export interface PlanDefinition {
  id: PlanType
  name: string
  /** Jetons par jour. `null` = quota non défini (à configurer côté serveur). */
  dailyTokenLimit: number | null
  features: string[]
  price: string
  description: string
  permissions: Permissions
}

const FREE_PERMISSIONS: Permissions = {
  chat: true,
  agent: true,
  builtinFreeModels: true,
  oxAlphaModels: false,
  premiumModels: false,
  advancedTools: false,
  priorityAccess: false,
}

const PRO_PERMISSIONS: Permissions = {
  chat: true,
  agent: true,
  builtinFreeModels: true,
  oxAlphaModels: true,
  premiumModels: false,
  advancedTools: false,
  priorityAccess: false,
}

const PRO_ULTIMATE_PERMISSIONS: Permissions = {
  chat: true,
  agent: true,
  builtinFreeModels: true,
  oxAlphaModels: true,
  premiumModels: true,
  advancedTools: true,
  priorityAccess: true,
}

function envLimit(planId: string): number | null {
  const raw = process.env[`MY_CREATION_PLAN_${planId.toUpperCase()}_DAILY_TOKENS`]
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export const PLANS: PlanDefinition[] = [
  {
    id: 'free',
    name: 'FREE',
    dailyTokenLimit: 10_000_000,
    features: [
      '10 000 000 tokens / jour',
      'Chat et Agent complets',
      'Modèle Kim Pro inclus',
      'Terminal, Preview et Package intégrés',
    ],
    price: 'Gratuit',
    description: 'Le plan de départ : chat et Agent complets au quotidien.',
    permissions: FREE_PERMISSIONS,
  },
  {
    id: 'pro',
    name: 'PRO',
    // Quota configurable : aucune valeur officielle n'est inventée ici.
    dailyTokenLimit: envLimit('pro') ?? null,
    features: [
      'Quota quotidien étendu',
      'Modèle Ox Alpha inclus',
      'Support dédié',
    ],
    // Prix affiché aligné sur le produit Gumroad « My Creation Pro » (fqcefy,
    // abonnement mensuel 9,99 €). Source réelle du prix : le dashboard Gumroad.
    price: '9,99 € / mois',
    description: 'Kim Pro + Ox Alpha, pour les créateurs qui produisent tous les jours.',
    permissions: PRO_PERMISSIONS,
  },
  {
    id: 'pro_ultimate',
    name: 'PRO ULTIMATE',
    dailyTokenLimit: envLimit('pro_ultimate') ?? null,
    features: [
      'Tout My Creation débloqué',
      'Tous les modèles (y compris vos clés personnelles)',
      'Outils avancés de l’Agent',
      'Accès prioritaire au pool IA',
    ],
    price: 'Licence administrateur',
    description: 'Accordé par une licence My Creation PRO ULTIMATE.',
    permissions: PRO_ULTIMATE_PERMISSIONS,
  },
]

export function getPlan(planId: string): PlanDefinition {
  return PLANS.find(plan => plan.id === planId) ?? PLANS[0]
}

export function isPlanType(value: string): value is PlanType {
  return PLANS.some(plan => plan.id === value)
}
