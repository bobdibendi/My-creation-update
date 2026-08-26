import type {
  AIProvider,
  ChatMessage,
  ModelInfo,
  ProviderEvent,
  ProviderRequest,
  ProviderToolCall,
  StopReason,
  ToolSchema,
} from './registry.js'
import { ProviderError, guardStream, postJson, readSSE } from './http.js'

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5', supportsTools: true },
  { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', supportsTools: true },
  { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5', supportsTools: true },
]

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

interface AnthropicBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

interface AnthropicEvent {
  type?: string
  index?: number
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  content_block?: { type?: string; id?: string; name?: string; text?: string }
  message?: { stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

/** Anthropic requires alternating user/assistant turns with tool results inside user blocks. */
function toApiMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []

  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? 'unknown',
        content: message.content,
      }])
      continue
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (message.content.trim().length > 0) blocks.push({ type: 'text', text: message.content })
      for (const call of message.toolCalls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(call.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
      }
      push('assistant', blocks)
      continue
    }

    push('user', [{ type: 'text', text: message.content }])
  }

  // The API rejects conversations that do not start with a user turn.
  if (out.length > 0 && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  }

  return { system, messages: out }
}

function toApiTools(tools: ToolSchema[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

export function createAnthropicProvider(getKey: () => string | null): AIProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    models: ANTHROPIC_MODELS,

    async stream(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<void> {
      await guardStream('Anthropic', onEvent, async emit => {
        const key = getKey()
        if (!key) throw new ProviderError('Clé API Anthropic absente. Ajoutez-la dans les paramètres.')

        const { system, messages } = toApiMessages(request.messages)
        const body: Record<string, unknown> = {
          model: request.model,
          max_tokens: request.maxTokens ?? 8192,
          stream: true,
          messages,
        }
        if (system.trim().length > 0) body.system = system
        const tools = toApiTools(request.tools)
        if (tools) body.tools = tools

        const response = await postJson(API_URL, {
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        }, body, request.signal)

        const blocks = new Map<number, { id: string; name: string; json: string }>()
        const calls: ProviderToolCall[] = []
        let reason: StopReason = 'stop'
        let inputTokens = 0
        let outputTokens = 0

        for await (const payload of readSSE(response)) {
          let event: AnthropicEvent
          try { event = JSON.parse(payload) as AnthropicEvent } catch { continue }
          if (event.type === 'error') throw new ProviderError(event.error?.message ?? 'Erreur de flux Anthropic')

          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens ?? inputTokens
            outputTokens = event.message.usage.output_tokens ?? outputTokens
          }
          if (event.usage) {
            // message_delta carries the running output total.
            inputTokens = event.usage.input_tokens ?? inputTokens
            outputTokens = event.usage.output_tokens ?? outputTokens
          }

          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            blocks.set(event.index ?? 0, {
              id: event.content_block.id ?? `call_${event.index ?? 0}`,
              name: event.content_block.name ?? '',
              json: '',
            })
            continue
          }

          if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              emit({ type: 'text', text: event.delta.text })
            } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json !== undefined) {
              const block = blocks.get(event.index ?? 0)
              if (block) block.json += event.delta.partial_json
            }
            continue
          }

          if (event.type === 'content_block_stop') {
            const block = blocks.get(event.index ?? 0)
            if (block && block.name) {
              calls.push({ id: block.id, name: block.name, arguments: block.json || '{}' })
              blocks.delete(event.index ?? 0)
            }
            continue
          }

          if (event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use') {
            reason = 'tool-calls'
          }
        }

        for (const call of calls) emit({ type: 'tool-call', call })
        if (inputTokens > 0 || outputTokens > 0) {
          emit({ type: 'usage', inputTokens, outputTokens })
        }
        emit({ type: 'done', reason: calls.length > 0 ? 'tool-calls' : reason })
      })
    },
  }
}
