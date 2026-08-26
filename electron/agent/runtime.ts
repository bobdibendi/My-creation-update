import type {
  AIProvider,
  ChatMessage,
  ModelInfo,
  ProviderEvent,
  ProviderToolCall,
  ToolSchema,
} from '../providers/registry.js'
import type { ToolContext } from './types.js'
import type { ToolRegistry } from './registry.js'
import { buildSystemPrompt, formatToolResult } from './prompt.js'

export type AgentRuntimeEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; tool: string; args: unknown }
  | { type: 'tool-result'; id: string; tool: string; success: boolean; summary: string; mutated: boolean }
  | { type: 'files-changed' }

export interface AgentRunInput {
  prompt: string
  workspace: string
  activeFilePath?: string
  activeFileExcerpt?: string
  /** Prior conversation turns, oldest first. Tool traffic is not included. */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** Resume de la Todo reelle, injecte dans le prompt systeme. */
  tasksSummary?: string
}

export interface AgentRunResult {
  text: string
  turns: number
  toolCalls: number
  filesChanged: boolean
}

const MAX_TURNS = 60
/** Keeps the transcript bounded on long autonomous runs. */
const MAX_HISTORY_MESSAGES = 60
/** Guards against a model that keeps returning nothing at all. */
const MAX_EMPTY_TURNS = 3

function summarizeArgs(rawArguments: string): unknown {
  try {
    return rawArguments.trim().length === 0 ? {} : JSON.parse(rawArguments)
  } catch {
    return rawArguments.slice(0, 400)
  }
}

function summarizeResult(success: boolean, payload: unknown, maxChars = 400): string {
  if (!success) return String(payload).slice(0, maxChars)
  if (payload === null || payload === undefined) return 'ok'
  if (typeof payload === 'string') return payload.slice(0, maxChars)
  try {
    return JSON.stringify(payload).slice(0, maxChars)
  } catch {
    return 'ok'
  }
}

/**
 * Collects one provider turn: text deltas are forwarded live, tool calls are
 * buffered until the turn ends. A turn ends when the provider closes the
 * stream, the caller aborts, or a transport watchdog fires (connect/idle
 * timeouts enforced in providers/http.ts).
 */
function runProviderTurn(
  provider: AIProvider,
  model: string,
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<{ text: string; calls: ProviderToolCall[] }> {
  return new Promise((resolve, reject) => {
    let text = ''
    const calls: ProviderToolCall[] = []
    let settled = false

    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }

    const handle = (event: ProviderEvent) => {
      if (event.type === 'text') {
        text += event.text
        onText(event.text)
      } else if (event.type === 'tool-call') {
        calls.push(event.call)
      } else if (event.type === 'error') {
        finish(() => reject(new Error(event.message)))
      } else if (event.type === 'done') {
        finish(() => resolve({ text, calls }))
      }
    }

    provider
      .stream({ messages, model, tools, signal }, handle)
      .then(() => finish(() => resolve({ text, calls })))
      .catch((error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))))
  })
}

/** Drops the oldest tool traffic once the transcript grows too large. */
function trimMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) return messages
  const system = messages.filter(message => message.role === 'system')
  const rest = messages.filter(message => message.role !== 'system')
  const keep = rest.slice(-(MAX_HISTORY_MESSAGES - system.length - 1))

  // A tool result must never lead the transcript: its matching assistant turn
  // would be missing and providers reject that shape.
  while (keep.length > 0 && keep[0].role === 'tool') keep.shift()

  return [
    ...system,
    { role: 'user', content: '[Historique tronqué: les échanges les plus anciens ont été retirés pour rester dans la fenêtre de contexte.]' },
    ...keep,
  ]
}

export class AgentRuntime {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly provider: AIProvider,
    private readonly model: ModelInfo,
  ) {}

  async run(
    input: AgentRunInput,
    signal: AbortSignal,
    emit: (event: AgentRuntimeEvent) => void,
  ): Promise<AgentRunResult> {
    if (!this.model.supportsTools) {
      throw new Error(`Le modèle ${this.model.label} ne supporte pas les outils. Choisis un autre modèle pour le mode Agent.`)
    }

    const schemas = this.registry.schemas()
    const system = buildSystemPrompt({
      workspace: input.workspace,
      toolNames: this.registry.names(),
      activeFilePath: input.activeFilePath,
      activeFileExcerpt: input.activeFileExcerpt,
      platform: `${process.platform} (${process.arch})`,
      tasksSummary: input.tasksSummary,
    })

    let messages: ChatMessage[] = [{ role: 'system', content: system }]
    for (const entry of input.history ?? []) {
      if (entry.content.trim().length === 0) continue
      messages.push({ role: entry.role, content: entry.content })
    }
    messages.push({ role: 'user', content: input.prompt })

    const context: ToolContext = {
      workspace: input.workspace,
      signal,
      onProgress: text => emit({ type: 'status', text }),
    }

    let toolCalls = 0
    let emptyTurns = 0
    let filesChanged = false
    let lastText = ''

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      if (signal.aborted) throw new Error('Agent interrompu')

      emit({ type: 'status', text: turn === 1 ? 'Analyse de la demande' : `Réflexion (étape ${turn})` })
      messages = trimMessages(messages)

      const { text, calls } = await runProviderTurn(
        this.provider,
        this.model.id,
        messages,
        schemas,
        signal,
        chunk => emit({ type: 'text', text: chunk }),
      )

      if (text.trim().length > 0) lastText = text

      if (calls.length === 0) {
        if (text.trim().length > 0) {
          return { text, turns: turn, toolCalls, filesChanged }
        }

        emptyTurns += 1
        if (emptyTurns > MAX_EMPTY_TURNS) {
          throw new Error('Le modèle n\'a renvoyé aucune réponse exploitable après plusieurs tentatives')
        }
        messages.push({
          role: 'user',
          content: 'Réponds maintenant en français, en texte clair, avec le résumé de ce que tu as fait ou ta conclusion. N\'appelle plus d\'outil.',
        })
        continue
      }

      emptyTurns = 0
      messages.push({ role: 'assistant', content: text, toolCalls: calls })

      let mutatedThisTurn = false
      for (const call of calls) {
        if (signal.aborted) throw new Error('Agent interrompu')
        toolCalls += 1

        emit({ type: 'tool-call', id: call.id, tool: call.name, args: summarizeArgs(call.arguments) })
        const outcome = await this.registry.execute(call.name, call.arguments, context)
        const tool = this.registry.get(call.name)
        const mutated = outcome.success && (tool?.mutates ?? false)
        if (mutated) {
          filesChanged = true
          mutatedThisTurn = true
        }

        emit({
          type: 'tool-result',
          id: call.id,
          tool: call.name,
          success: outcome.success,
          summary: summarizeResult(outcome.success, outcome.success ? outcome.result : outcome.error),
          mutated,
        })

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content: outcome.success ? formatToolResult(outcome.result) : `ERREUR: ${outcome.error}`,
        })
      }

      if (mutatedThisTurn) emit({ type: 'files-changed' })
    }

    // Turn budget exhausted: request a written wrap-up instead of failing.
    emit({ type: 'status', text: 'Rédaction du résumé final' })
    messages = trimMessages(messages)
    messages.push({
      role: 'user',
      content: 'Le budget d\'étapes est atteint. Résume en français ce qui a été fait, ce qui fonctionne et ce qui reste à faire. N\'appelle plus d\'outil.',
    })

    const wrapUp = await runProviderTurn(
      this.provider,
      this.model.id,
      messages,
      undefined,
      signal,
      chunk => emit({ type: 'text', text: chunk }),
    )

    const finalText = wrapUp.text.trim().length > 0 ? wrapUp.text : lastText
    if (finalText.trim().length === 0) {
      throw new Error('L\'agent n\'a pas produit de réponse exploitable')
    }
    return { text: finalText, turns: MAX_TURNS, toolCalls, filesChanged }
  }
}
