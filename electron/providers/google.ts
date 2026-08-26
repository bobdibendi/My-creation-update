import type {
  AIProvider,
  ChatMessage,
  JsonSchema,
  ModelInfo,
  ProviderEvent,
  ProviderRequest,
  ProviderToolCall,
  StopReason,
  ToolSchema,
} from './registry.js'
import { ProviderError, guardStream, postJson, readSSE } from './http.js'

const GOOGLE_MODELS: ModelInfo[] = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', supportsTools: true },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', supportsTools: true },
]

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name: string; response: unknown }
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  error?: { message?: string }
}

/** Gemini's schema dialect rejects `additionalProperties`. */
function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type.toUpperCase() }
  if (schema.description) out.description = schema.description
  if (schema.enum) out.enum = schema.enum
  if (schema.items) out.items = toGeminiSchema(schema.items)
  if (schema.properties) {
    const properties: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(schema.properties)) properties[name] = toGeminiSchema(value)
    out.properties = properties
  }
  if (schema.required && schema.required.length > 0) out.required = schema.required
  return out
}

function toApiContents(messages: ChatMessage[]): { system: string; contents: unknown[] } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = []

  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      push('user', [{
        functionResponse: {
          name: message.toolName ?? 'tool',
          response: { result: message.content },
        },
      }])
      continue
    }

    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (message.content.trim().length > 0) parts.push({ text: message.content })
      for (const call of message.toolCalls ?? []) {
        let args: unknown = {}
        try { args = JSON.parse(call.arguments || '{}') } catch { args = {} }
        parts.push({ functionCall: { name: call.name, args } })
      }
      push('model', parts)
      continue
    }

    push('user', [{ text: message.content }])
  }

  return { system, contents }
}

function toApiTools(tools: ToolSchema[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: toGeminiSchema(tool.parameters),
    })),
  }]
}

export function createGoogleProvider(getKey: () => string | null): AIProvider {
  return {
    id: 'google',
    name: 'Google',
    models: GOOGLE_MODELS,

    async stream(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<void> {
      await guardStream('Google', onEvent, async emit => {
        const key = getKey()
        if (!key) throw new ProviderError('Clé API Google absente. Ajoutez-la dans les paramètres.')

        const { system, contents } = toApiContents(request.messages)
        const body: Record<string, unknown> = {
          contents,
          generationConfig: { maxOutputTokens: request.maxTokens ?? 8192 },
        }
        if (system.trim().length > 0) body.systemInstruction = { parts: [{ text: system }] }
        const tools = toApiTools(request.tools)
        if (tools) body.tools = tools

        const url = `${API_BASE}/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`
        const response = await postJson(url, {}, body, request.signal)

        const calls: ProviderToolCall[] = []
        let reason: StopReason = 'stop'

        for await (const payload of readSSE(response)) {
          let chunk: GeminiChunk
          try { chunk = JSON.parse(payload) as GeminiChunk } catch { continue }
          if (chunk.error?.message) throw new ProviderError(chunk.error.message)

          const candidate = chunk.candidates?.[0]
          for (const part of candidate?.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) emit({ type: 'text', text: part.text })
            if (part.functionCall?.name) {
              calls.push({
                id: `call_${calls.length + 1}_${part.functionCall.name}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              })
              reason = 'tool-calls'
            }
          }
        }

        for (const call of calls) emit({ type: 'tool-call', call })
        emit({ type: 'done', reason: calls.length > 0 ? 'tool-calls' : reason })
      })
    },
  }
}
