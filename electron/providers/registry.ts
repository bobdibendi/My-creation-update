// Provider contracts shared by every AI backend.
//
// Every provider speaks the same normalized protocol:
//   messages in  ->  streamed events out (text deltas + tool calls)
// Tool calling is native (no JSON-in-prose parsing).

export interface JsonSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
}

export interface JsonSchemaObject extends JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchema>
  required: string[]
  additionalProperties: false
}

/** A tool exposed to the model. */
export interface ToolSchema {
  name: string
  description: string
  parameters: JsonSchemaObject
}

/** A tool invocation requested by the model. */
export interface ProviderToolCall {
  id: string
  name: string
  /** Raw JSON string produced by the model. */
  arguments: string
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Only for `assistant` messages that requested tools. */
  toolCalls?: ProviderToolCall[]
  /** Only for `tool` messages: the id of the call being answered. */
  toolCallId?: string
  /** Only for `tool` messages: the name of the tool being answered. */
  toolName?: string
}

export type StopReason = 'stop' | 'tool-calls'

export type ProviderEvent =
  | { type: 'text'; text: string }
  /** Reasoning delta emitted BEFORE/AROUND the answer by thinking models. */
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; call: ProviderToolCall }
  /** Real token accounting reported by the backend, when it provides one. */
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; reason: StopReason }
  | { type: 'error'; message: string }

export interface ProviderRequest {
  messages: ChatMessage[]
  model: string
  tools?: ToolSchema[]
  signal: AbortSignal
  /** Upper bound for generated tokens. Providers clamp to their own limits. */
  maxTokens?: number
}

export interface ModelInfo {
  id: string
  label: string
  /** False when the backend cannot do native tool calling. */
  supportsTools: boolean
  /**
   * Model identifier actually sent to the API when it differs from `id`.
   * Lets the UI expose a friendly name (e.g. « Kim Pro ») while the backend
   * keeps using its own model string.
   */
  apiModel?: string
}

export type ProviderTier = 'free' | 'premium'

export interface AIProvider {
  readonly id: string
  readonly name: string
  /** 'free' = intégré (clés administrateur) ; 'premium' = clé personnelle. Absent = premium. */
  readonly tier?: ProviderTier
  readonly models: ModelInfo[]
  stream(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<void>
}

export class ProviderRegistry {
  private readonly providers = new Map<string, AIProvider>()

  register(provider: AIProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`)
    this.providers.set(provider.id, provider)
  }

  get(id: string): AIProvider | undefined {
    return this.providers.get(id)
  }

  list(): AIProvider[] {
    return Array.from(this.providers.values())
  }

  resolveModel(modelId: string): { provider: AIProvider; model: ModelInfo } | null {
    for (const provider of this.providers.values()) {
      const model = provider.models.find(candidate => candidate.id === modelId)
      if (model) return { provider, model }
    }
    return null
  }
}
