// ─── Product IDs Gumroad — configuration FOURNISSEUR ───────────────────
//
// Les Product ID Gumroad ne sont PAS des secrets : ils identifient
// publiquement les produits My Creation auprès de l'API officielle
// (POST /v2/licenses/verify : product_id + license_key, sans token).
//
//   PRO_PRODUCT_ID             -> produit Gumroad « PRO » (abonnement)
//   PRO_ULTIMATE_PRODUCT_ID    -> produit Gumroad « PRO ULTIMATE » (abonnement)
//   PRO_RECURRENCE             -> 'monthly' (défaut) | 'yearly'
//   PRO_ULTIMATE_RECURRENCE    -> 'monthly' (défaut) | 'yearly'
//
// Le plan est déduit du produit qui valide la clé :
//   PRO_PRODUCT_ID            -> plan pro
//   PRO_ULTIMATE_PRODUCT_ID   -> plan pro_ultimate
// Le plan FREE ne dépend JAMAIS de Gumroad.
//
// La RÉCURRENCE sert à calculer la fin de période payée après une
// annulation : période = dernier paiement (sale_timestamp) + cadence.
// Elle doit correspondre au réglage du produit dans le dashboard Gumroad.
//
// Priorité : variables d'environnement > constantes de ce fichier.
//   GUMROAD_PRO_PRODUCT_ID / GUMROAD_PRO_ULTIMATE_PRODUCT_ID /
//   MC_SUB_PRO_RECURRENCE / MC_SUB_PRO_ULTIMATE_RECURRENCE restent supportées.
//
// Aucun secret ici : l'API token Gumroad n'est JAMAIS nécessaire à
// My Creation et ne doit jamais être embarqué côté client.

export type SubscriptionRecurrence = 'monthly' | 'yearly'

export const GUMROAD_BUILD_PRODUCTS = {
  PRO_PRODUCT_ID: 'fqcefy',
  PRO_ULTIMATE_PRODUCT_ID: 'rbdvn',
  PRO_RECURRENCE: 'monthly',
  PRO_ULTIMATE_RECURRENCE: 'monthly',
} as const

export function isRecurrence(value: string): value is SubscriptionRecurrence {
  return value === 'monthly' || value === 'yearly'
}
