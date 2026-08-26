// ─── Configuration centrale des fournisseurs IA de MY CREATION ──────────
//
// Ce fichier contient UNIQUEMENT des paramètres non secrets :
//   ids internes, noms affichés, URLs, modèles, niveaux d'accès, capacités.
//
// Les clés API ne sont JAMAIS écrites ici, ni dans le renderer, ni dans
// app.asar public, ni dans package.json. Elles viennent exclusivement de
// variables d'environnement lues côté processus main :
//
//   Top Tools AI (backend du modèle « Kim Pro ») :
//     TOP_TOOLS_AI_API_KEYS      -> plusieurs clés séparées par , ou ;
//     TOP_TOOLS_AI_API_KEY       -> clé unique
//     MY_CREATION_AI_KEY_1..9    -> pool générique administrateur
//
//   OpenCode Zen (backend du modèle « Ox Alpha Free ») :
//     OPENCODE_ZEN_API_KEYS      -> plusieurs clés séparées par , ou ;
//     OPENCODE_ZEN_API_KEY       -> clé unique
//
// L'utilisateur final ne saisit jamais de clé pour ces deux modèles ; une
// clé personnelle reste optionnelle via Paramètres (KeyStore chiffré).

export type ProviderTier = 'free' | 'premium'

/**
 * D'où vient la clé d'un fournisseur :
 *   'admin' -> clés administrateur gérées côté main process (pool env +
 *              KeyStore chiffré). L'utilisateur n'a RIEN à saisir et aucun
 *              champ de clé ne doit lui être présenté pour ces fournisseurs.
 *   'user'  -> clé personnelle optionnelle saisie par l'utilisateur.
 */
export type KeySource = 'admin' | 'user'

/** Niveau d'accès du fournisseur : gratuit intégré ou premium (clé perso). */
export interface ProviderConfig {
  /** Identifiant interne (jamais affiché tel quel dans l'UI principale). */
  id: string
  /** Nom affiché à l'utilisateur. */
  displayName: string
  /** Backend réel, masqué à l'utilisateur. */
  provider: string
  baseUrl: string
  /** Identifiant de modèle réellement envoyé à l'API. */
  apiModel: string
  /** Identifiant du modèle vu par l'application. */
  modelId: string
  tier: ProviderTier
  supportsTools: boolean
  /** Qui possède la clé : toujours 'admin' pour les modèles intégrés gratuits. */
  keySource: KeySource
  /** Variables d'environnement où chercher les clés du pool. */
  keyEnvVars: string[]
  missingKeyMessage: string
}

/**
 * Modèle gratuit affiché « Kim Pro ».
 * Le backend réel (Top Tools AI) reste invisible : seul le nom affiché et la
 * configuration ci-dessous font foi, et le backend peut changer sans toucher
 * l'interface.
 */
export const KIM_PRO: ProviderConfig = {
  id: 'tools',
  displayName: 'Kim Pro',
  provider: 'top-tools',
  baseUrl: 'https://top-tools-ai.com/api/v1/chat/completions',
  modelId: 'kim-pro',
  apiModel: 'Top-Tools-Ai',
  tier: 'free',
  supportsTools: true,
  keySource: 'admin',
  keyEnvVars: [
    'TOP_TOOLS_AI_API_KEYS',
    'TOP_TOOLS_AI_API_KEY',
    'TOOLS_API_KEY',
    'MY_CREATION_AI_KEY_9',
    'MY_CREATION_AI_KEY_8',
    'MY_CREATION_AI_KEY_7',
    'MY_CREATION_AI_KEY_6',
    'MY_CREATION_AI_KEY_5',
    'MY_CREATION_AI_KEY_4',
    'MY_CREATION_AI_KEY_3',
    'MY_CREATION_AI_KEY_2',
    'MY_CREATION_AI_KEY_1',
  ],
  missingKeyMessage:
    'Kim Pro est momentanément indisponible : cette installation de My Creation '
    + 'n’a pas encore été activée par votre administrateur. Contactez-le pour finaliser l’installation.',
}

/** Fournisseur OpenCode Zen affiché « Ox Alpha » (inclus à partir du plan PRO). */
export const OX_ALPHA_FREE: ProviderConfig = {
  id: 'opencode-zen',
  displayName: 'Ox Alpha',
  provider: 'opencode-zen',
  baseUrl: 'https://opencode.ai/zen/v1/chat/completions',
  modelId: 'ox-alpha-free',
  apiModel: 'x-preview-f-free',
  tier: 'free',
  supportsTools: true,
  keySource: 'admin',
  keyEnvVars: ['OPENCODE_ZEN_API_KEYS', 'OPENCODE_ZEN_API_KEY'],
  missingKeyMessage:
    'Ox Alpha est momentanément indisponible. Réessaie dans quelques instants '
    + 'ou bascule sur Kim Pro.',
}

/** Fournisseurs intégrés gratuits, dans l'ordre de la chaîne de fallback. */
export const BUILTIN_FREE_PROVIDERS: ProviderConfig[] = [KIM_PRO, OX_ALPHA_FREE]

/** Lit une variable d'environnement multi-clés (« a,b » / « a;b »). */
export function readEnvKeys(envVars: string[]): string | null {
  const parts: string[] = []
  for (const name of envVars) {
    const raw = process.env[name]
    if (!raw) continue
    for (const piece of raw.split(/[,;]/)) {
      const value = piece.trim()
      if (value.length > 0) parts.push(value)
    }
  }
  return parts.length > 0 ? parts.join(',') : null
}
