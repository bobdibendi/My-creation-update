import type { AIProvider, ModelInfo } from './registry.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'

const OPENAI_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', label: 'GPT-4o', supportsTools: true },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', supportsTools: true },
]

export function createOpenAIProvider(getKey: () => string | null): AIProvider {
  return createOpenAICompatibleProvider({
    id: 'openai',
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    models: OPENAI_MODELS,
    getKey,
    missingKeyMessage: 'Clé API OpenAI absente. Ajoutez-la dans les paramètres.',
    maxTokens: 8192,
  })
}
