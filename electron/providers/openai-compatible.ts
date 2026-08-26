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
import type { ApiKeyPool } from '../keypool.js'

interface OpenAIToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIToolCallDelta[] }
    finish_reason?: string | null
  }>
  /** Present on the final chunk when the backend reports token accounting. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string }
}

interface Accumulator {
  id: string
  name: string
  args: string
}

function toApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      }
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}

function toApiTools(tools: ToolSchema[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

export interface OpenAICompatibleOptions {
  id: string
  name: string
  apiUrl: string
  models: ModelInfo[]
  getKey: () => string | null
  missingKeyMessage: string
  /**
   * How the transcript's tool traffic is encoded on the wire:
   *  - 'native' (default): assistant.tool_calls + role:"tool" messages, as
   *    specified by the OpenAI chat completions API.
   *  - 'folded': tool calls/results rewritten as plain assistant/user text.
   *    For backends that hang or reject native tool roles while still
   *    supporting tool_calls deltas in their responses (observed on
   *    Top Tools AI: request with role:"tool" never gets response headers).
   */
  toolCallStyle?: 'native' | 'folded'
  /** Extra headers merged into every request. Null key = anonymous call. */
  headers?: (key: string | null) => Record<string, string>
  maxTokens?: number
  /**
   * Asks the backend to append a usage summary to the stream
   * (`stream_options: { include_usage: true }`). When the endpoint rejects
   * the option the request is retried once without it, so a strict
   * implementation never turns into a hard failure.
   */
  requestUsage?: boolean
  /** 'free' = intégré (clés administrateur) ; défaut 'premium'. */
  tier?: AIProvider['tier']
  /**
   * True when the backend accepts anonymous requests: the call proceeds
   * without an Authorization header even when neither a personal key nor a
   * pool is configured.
   */
  allowKeyless?: boolean
  /**
   * Infrastructure key pool (main process only). When a pooled key is refused
   * (401/402/403/429) the next one is tried before any event reaches the
   * renderer, so a failover never duplicates output.
   */
  keyPool?: ApiKeyPool
}

/**
 * Rewrites assistant.toolCalls / role:"tool" traffic as plain text turns so
 * backends without native tool-role support still see a coherent transcript.
 */
function foldToolTraffic(messages: ChatMessage[]): ChatMessage[] {
  const folded: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const announced = message.toolCalls
        .map(call => `Appel de l'outil ${call.name} avec les arguments ${call.arguments}`)
        .join(' ')
      const text = [message.content.trim(), announced].filter(part => part.length > 0).join(' ')
      folded.push({ role: 'assistant', content: text })
      continue
    }
    if (message.role === 'tool') {
      folded.push({
        role: 'user',
        content: `[Résultat de l'outil ${message.toolName ?? 'outil'}] ${message.content}`,
      })
      continue
    }
    folded.push(message)
  }
  return folded
}

/**
 * [AI-DIAG] Journal temporaire de diagnostic — JAMAIS de clé, JWT ou secret
 * ici : uniquement host, modèle, index/hash partiel de clé, statut, durées.
 */
function diag(event: string, details: Record<string, unknown>): void {
  const parts = Object.entries(details)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value.slice(0, 120) : String(value)}`)
    .join(' ')
  console.info(`[AI-DIAG] ${event} ${parts}`)
  try { streamDiagLogger?.(event, details) } catch { /* jamais fatal */ }
}

/** Hash court et non réversible pour distinguer une clé sans la révéler. */
export function keyFingerprint(key: string): string {
  let hash = 5381
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0
  }
  return `k${(hash >>> 0).toString(16).padStart(8, '0')}/${key.length}`
}

/** Journal injectable ([AI-CRASH]) — branché par main.ts, jamais de secret. */
type StreamDiagLogger = (event: string, details: Record<string, unknown>) => void
let streamDiagLogger: StreamDiagLogger | null = null
export function setStreamDiagLogger(logger: StreamDiagLogger | null): void {
  streamDiagLogger = logger
}

/**
 * Streaming client for any `/chat/completions` compatible endpoint.
 * Handles incremental `tool_calls` deltas keyed by index.
 */
export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  const headers = options.headers ?? ((key: string | null): Record<string, string> =>
    (key ? { Authorization: `Bearer ${key}` } : {}))

  return {
    id: options.id,
    name: options.name,
    tier: options.tier ?? 'premium',
    models: options.models,

    async stream(request: ProviderRequest, onEvent: (event: ProviderEvent) => void): Promise<void> {
      await guardStream(options.name, onEvent, async emit => {
        const personalKey = options.getKey()
        const hasPooledKeys = (options.keyPool?.size ?? 0) > 0
        if (!personalKey && !hasPooledKeys && !options.allowKeyless) {
          throw new ProviderError(options.missingKeyMessage)
        }

        // The UI-facing model id may differ from the backend model string.
        const apiModel = options.models.find(candidate => candidate.id === request.model)?.apiModel
          ?? request.model

        const buildBody = (withUsageOption: boolean): Record<string, unknown> => {
          const transcript = options.toolCallStyle === 'folded'
            ? foldToolTraffic(request.messages)
            : request.messages
          const body: Record<string, unknown> = {
            model: apiModel,
            stream: true,
            max_tokens: request.maxTokens ?? options.maxTokens ?? 8192,
            messages: toApiMessages(transcript),
          }
          if (withUsageOption && options.requestUsage) body.stream_options = { include_usage: true }
          const tools = toApiTools(request.tools)
          if (tools) {
            body.tools = tools
            body.tool_choice = 'auto'
          }
          return body
        }

        /** Status codes that justify switching to the next pooled key. */
        const FAILOVER_STATUS = new Set([401, 402, 403, 429])

        // Personal key first; then the pool in rotation until one answers or
        // every key has been tried. `null` = anonymous (allowKeyless).
        const attempts: Array<string | null> = []
        if (personalKey) attempts.push(personalKey)
        if (hasPooledKeys && options.keyPool) {
          for (let seen = 0; seen < options.keyPool.size; seen += 1) {
            const candidate = options.keyPool.next()
            if (candidate && !attempts.includes(candidate)) attempts.push(candidate)
          }
        }
        if (attempts.length === 0 && options.allowKeyless) attempts.push(null)
        if (attempts.length === 0) throw new ProviderError(options.missingKeyMessage)

        const diagStart = Date.now()
        let sawFirstEvent = false
        let textChunks = 0
        diag('request-start', {
          provider: options.id,
          model: apiModel,
          key: attempts.length === 1 && attempts[0] === null ? 'anonymous' : keyFingerprint(String(attempts[0] ?? '')),
          attempts: attempts.length,
          tools: Boolean(request.tools),
        })

        /** One POST attempt; fails over across pooled keys when allowed. */
        const post = async (withUsageOption: boolean): Promise<Response> => {
          let lastError: unknown = null
          for (let index = 0; index < attempts.length; index += 1) {
            const key = attempts[index]
            try {
              const response = await postJson(options.apiUrl, headers(key), buildBody(withUsageOption), request.signal)
              diag('http-open', { provider: options.id, status: response.status, ms: Date.now() - diagStart })
              return response
            } catch (error: unknown) {
              lastError = error
              diag('http-error', { provider: options.id, status: error instanceof ProviderError ? error.status ?? '?' : '?', ms: Date.now() - diagStart, message: error instanceof Error ? error.message.slice(0, 100) : String(error).slice(0, 100) })
              const canFailover = error instanceof ProviderError
                && error.status !== undefined
                && FAILOVER_STATUS.has(error.status)
                && hasPooledKeys
                && key !== null
                && index < attempts.length - 1
              if (!canFailover) throw error
              options.keyPool?.reportFailure(key)
            }
          }
          throw lastError ?? new ProviderError('Le fournisseur n\'a pas répondu')
        }

        let response: Response
        try {
          response = await post(true)
        } catch (error: unknown) {
          // Strict backends answer 400 on unknown stream fields; degrade to a
          // plain stream instead of failing the whole turn.
          const isUsageRejection = error instanceof ProviderError
            && error.status === 400
            && options.requestUsage === true
            && /stream_options/i.test(error.message)
          if (!isUsageRejection) throw error
          response = await post(false)
        }

        const pending = new Map<number, Accumulator>()
        let reason: StopReason = 'stop'
        let usage: { inputTokens: number; outputTokens: number } | null = null

        for await (const payload of readSSE(response)) {
          let chunk: OpenAIChunk
          try { chunk = JSON.parse(payload) as OpenAIChunk } catch { continue }
          if (chunk.error?.message) throw new ProviderError(chunk.error.message)

          const reported = chunk.usage
          if (reported && (typeof reported.prompt_tokens === 'number' || typeof reported.completion_tokens === 'number')) {
            usage = {
              inputTokens: reported.prompt_tokens ?? 0,
              outputTokens: reported.completion_tokens ?? 0,
            }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue

          const reasoning = choice.delta?.reasoning_content
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            emit({ type: 'reasoning', text: reasoning })
            if (!sawFirstEvent) {
              sawFirstEvent = true
              diag('first-event', { kind: 'reasoning', ms: Date.now() - diagStart })
            }
          }

          const text = choice.delta?.content
          if (typeof text === 'string' && text.length > 0) {
            textChunks += 1
            if (!sawFirstEvent) {
              sawFirstEvent = true
              diag('first-token', { ms: Date.now() - diagStart })
            }
            emit({ type: 'text', text })
          }

          for (const delta of choice.delta?.tool_calls ?? []) {
            const index = delta.index ?? 0
            const current = pending.get(index) ?? { id: '', name: '', args: '' }
            if (delta.id) current.id = delta.id
            if (delta.function?.name) current.name = delta.function.name
            if (delta.function?.arguments) current.args += delta.function.arguments
            pending.set(index, current)
          }

          if (choice.finish_reason === 'tool_calls') reason = 'tool-calls'
        }

        diag('stream-end', {
          provider: options.id,
          ms: Date.now() - diagStart,
          textChunks,
          usage: usage ? `${usage.inputTokens}/${usage.outputTokens}` : 'none',
        })

        const calls: ProviderToolCall[] = Array.from(pending.entries())
          .sort((a, b) => a[0] - b[0])
          .filter(([, value]) => value.name.length > 0)
          .map(([index, value], position) => ({
            id: value.id || `call_${index}_${position}`,
            name: value.name,
            arguments: value.args || '{}',
          }))

        for (const call of calls) emit({ type: 'tool-call', call })
        if (usage) emit({ type: 'usage', ...usage })
        emit({ type: 'done', reason: calls.length > 0 ? 'tool-calls' : reason })
      })
    },
  }
}
