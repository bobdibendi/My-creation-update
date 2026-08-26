import { isAbort, ProviderError } from './providers/http.js'

// ─── Taxonomie d'erreurs ───────────────────────────────
//
// Les codes structurés restent côté Electron (logs) ; le renderer reçoit un
// message français compréhensible préfixé par le code, ex. :
//   « [RATE_LIMIT] Kim Pro est sollicité au-delà de sa limite. Réessaie dans
//    quelques instants. »

export type ErrorCode =
  | 'AUTH_ERROR'
  | 'RATE_LIMIT'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'TOOL_ERROR'
  | 'QUOTA_ERROR'
  | 'LICENSE_ERROR'

const FRIENDLY: Record<ErrorCode, string> = {
  AUTH_ERROR: 'Accès refusé par le fournisseur IA (clé invalide ou expirée).',
  RATE_LIMIT: 'Le fournisseur IA est sollicité au-delà de sa limite. Réessaie dans quelques instants.',
  MODEL_UNAVAILABLE: 'Ce modèle est momentanément indisponible.',
  PROVIDER_ERROR: 'Le fournisseur IA a renvoyé une erreur.',
  NETWORK_ERROR: 'Connexion au fournisseur IA impossible. Vérifie ta connexion internet.',
  TIMEOUT: 'Le fournisseur IA n’a pas répondu à temps.',
  TOOL_ERROR: 'Un outil de l’Agent a échoué.',
  QUOTA_ERROR: 'Quota quotidien atteint.',
  LICENSE_ERROR: 'Licence invalide ou expirée.',
}

export interface DescribedError {
  code: ErrorCode
  /** Message utilisateur compréhensible, prêt à afficher. */
  message: string
}

function classifyStatus(status: number | undefined): ErrorCode | null {
  if (status === undefined) return null
  if (status === 401 || status === 403) return 'AUTH_ERROR'
  if (status === 402) return 'QUOTA_ERROR'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 404 || status === 400) return 'MODEL_UNAVAILABLE'
  if (status >= 500) return 'PROVIDER_ERROR'
  return null
}

/** Mappe n'importe quelle erreur vers un code + message utilisateur. */
export function describeError(error: unknown): DescribedError {
  if (isAbort(error)) {
    return { code: 'TIMEOUT', message: `${FRIENDLY.TIMEOUT}` }
  }
  if (error instanceof ProviderError) {
    const byStatus = classifyStatus(error.status)
    const detail = error.message.length > 0 ? ` ${error.message.slice(0, 200)}` : ''
    if (byStatus) return { code: byStatus, message: `[${byStatus}] ${FRIENDLY[byStatus]}${detail}` }

    // Heuristiques sur les messages des backends sans statut exploitable.
    if (/quota|exceeded|insufficient/i.test(error.message)) {
      return { code: 'QUOTA_ERROR', message: `[QUOTA_ERROR] ${FRIENDLY.QUOTA_ERROR} ${error.message.slice(0, 200)}` }
    }
    if (/timeout|timed out/i.test(error.message)) {
      return { code: 'TIMEOUT', message: `[TIMEOUT] ${FRIENDLY.TIMEOUT}` }
    }
    if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(error.message)) {
      return { code: 'NETWORK_ERROR', message: `[NETWORK_ERROR] ${FRIENDLY.NETWORK_ERROR}` }
    }
    return { code: 'PROVIDER_ERROR', message: `[PROVIDER_ERROR] ${FRIENDLY.PROVIDER_ERROR} ${detail.trim()}` }
  }

  const raw = error instanceof Error ? error.message : String(error)
  // Heuristiques valables pour toutes les erreurs non structurées.
  if (/timeout|timed out/i.test(raw)) {
    return { code: 'TIMEOUT', message: `[TIMEOUT] ${FRIENDLY.TIMEOUT}` }
  }
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) {
    return { code: 'NETWORK_ERROR', message: `[NETWORK_ERROR] ${FRIENDLY.NETWORK_ERROR}` }
  }
  // Barrière de plan : le message mentionne « Licence » (section Paramètres)
  // mais n'est PAS une erreur de licence — il doit rester tel quel.
  if (/inclus à partir du plan|pas inclus dans votre plan/i.test(raw)) {
    return { code: 'PROVIDER_ERROR', message: raw }
  }
  if (/licence|license/i.test(raw)) return { code: 'LICENSE_ERROR', message: `[LICENSE_ERROR] ${FRIENDLY.LICENSE_ERROR}` }
  if (/quota/i.test(raw)) return { code: 'QUOTA_ERROR', message: raw }
  // Pool administrateur entièrement rejeté (401/402 sur chaque clé) :
  // message orienté administrateur, jamais de demande de clé à l'utilisateur.
  if (/activée par votre administrateur/i.test(raw) && /Kim Pro/i.test(raw)) {
    return { code: 'PROVIDER_ERROR', message: raw }
  }
  return { code: 'PROVIDER_ERROR', message: raw.length > 0 ? raw : FRIENDLY.PROVIDER_ERROR }
}

/**
 * Vrai lorsque l'erreur justifie de basculer sur un fournisseur secondaire :
 * pannes temporaires uniquement — une clé invalide ou une requête mal formée
 * échouera partout, donc on la remonte.
 *
 * NB : le failover ENTRE les clés d'une même pool est déjà assuré en amont
 * par ApiKeyPool/openai-compatible avant tout envoi d'événement ; ici on ne
 * décide que du repli vers un AUTRE fournisseur intégré.
 */
export function isTransientError(error: unknown): boolean {
  const TRANSIENT_TEXT = /timeout|timed out|fetch failed|network|ECONNRESET|ECONNREFUSED|socket hang up|HTTP\s*429|HTTP\s*5\d{2}/i
  if (error instanceof ProviderError) {
    const status = error.status
    if (status === 429 || (status !== undefined && status >= 500)) return true
    if (status === undefined && TRANSIENT_TEXT.test(error.message)) return true
    return false
  }
  if (error instanceof Error) return TRANSIENT_TEXT.test(error.message)
  return false
}
