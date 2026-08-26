import type { AIProvider, ModelInfo } from './registry.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'
import { ApiKeyPool } from '../keypool.js'
import { OX_ALPHA_FREE } from '../config/ai-providers.js'

const OX_ALPHA_MODELS: ModelInfo[] = [
  {
    id: OX_ALPHA_FREE.modelId,
    label: OX_ALPHA_FREE.displayName,
    apiModel: OX_ALPHA_FREE.apiModel,
    supportsTools: OX_ALPHA_FREE.supportsTools,
  },
]

/**
 * Fournisseur OpenCode Zen affiché « Ox Alpha Free » (modèle x-preview-f-free).
 *
 * API OpenAI-compatible : streaming, messages system/user/assistant, tool
 * calls. Les clés viennent des variables d'environnement côté main process
 * ou d'une clé personnelle facultative ; rien n'est exposé au renderer.
 * Si le backend refuse les tools, l'erreur remonte telle quelle au runtime
 * Agent qui l'affiche clairement — jamais de tool call prétendu réussi.
 */
export function createOpenCodeZenProvider(
  getKey: () => string | null,
  pooledKeys?: () => string | null,
): AIProvider {
  const pool = new ApiKeyPool([pooledKeys ?? (() => null)])

  return createOpenAICompatibleProvider({
    id: OX_ALPHA_FREE.id,
    name: OX_ALPHA_FREE.displayName,
    apiUrl: OX_ALPHA_FREE.baseUrl,
    models: OX_ALPHA_MODELS,
    missingKeyMessage: OX_ALPHA_FREE.missingKeyMessage,
    maxTokens: 16384,
    requestUsage: true,
    tier: 'free',
    // OpenCode Zen accepte les requêtes anonymes : le modèle gratuit marche
    // sans aucune configuration ; une clé personnelle reste prioritaire.
    allowKeyless: true,
    keyPool: pool.size > 0 ? pool : undefined,
    getKey,
  })
}
