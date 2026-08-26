import type { AIProvider, ModelInfo } from './registry.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'
import { ApiKeyPool } from '../keypool.js'
import { KIM_PRO } from '../config/ai-providers.js'

const KIM_PRO_MODELS: ModelInfo[] = [
  {
    id: KIM_PRO.modelId,
    label: KIM_PRO.displayName,
    apiModel: KIM_PRO.apiModel,
    supportsTools: KIM_PRO.supportsTools,
  },
]

/**
 * Modèle « Kim Pro » affiché à l'utilisateur.
 *
 * Le backend réel (Top Tools AI, API compatible OpenAI) reste masqué : seul
 * ce fichier et la configuration centrale connaissent son identité. Les clés
 * d'infrastructure viennent du pool (variables d'environnement côté main
 * process, jamais du renderer) et tournent en rotation : une clé rejetée est
 * mise au repos et la requête repart sur la suivante AVANT tout envoi
 * d'événements au renderer, donc jamais de réponse dupliquée.
 * La clé personnelle saisie dans les paramètres reste prioritaire.
 */
export function createToolsProvider(
  getKey: () => string | null,
  pooledKeys?: () => string | null,
): AIProvider {
  const pool = new ApiKeyPool([pooledKeys ?? (() => null)])

  return createOpenAICompatibleProvider({
    id: KIM_PRO.id,
    name: KIM_PRO.displayName,
    apiUrl: KIM_PRO.baseUrl,
    models: KIM_PRO_MODELS,
    missingKeyMessage: KIM_PRO.missingKeyMessage,
    maxTokens: 16384,
    requestUsage: true,
    /**
     * Le backend Top Tools AI accepte les tool_calls dans ses réponses mais
     * se suspend définitivement (aucune réponse HTTP) sur une requête
     * contenant des messages role:"tool" natifs — replier ce trafic en texte
     * user/assistant est la seule forme qui fonctionne de façon fiable.
     */
    toolCallStyle: 'folded',
    tier: 'free',
    keyPool: pool.size > 0 ? pool : undefined,
    getKey,
  })
}
