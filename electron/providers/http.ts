import type { ProviderEvent } from './registry.js'

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function isAbort(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Transport watchdogs: a provider that never opens (connect) or goes silent
 * mid-stream (idle) must fail the turn instead of hanging it forever.
 */
export const CONNECT_TIMEOUT_MS = 45_000
export const IDLE_TIMEOUT_MS = 120_000

const kDetachBridge = Symbol('postJson.abort-bridge')
type BridgedResponse = Response & { [kDetachBridge]?: () => void }

/** Reads an SSE body and yields each `data:` payload, skipping `[DONE]`.
 *  Fails when the transport stays silent longer than `idleTimeoutMs`. */
export async function* readSSE(
  bridgedResponse: BridgedResponse,
  idleTimeoutMs: number = IDLE_TIMEOUT_MS,
): AsyncGenerator<string> {
  const reader = bridgedResponse.body?.getReader()
  if (!reader) throw new ProviderError('The provider returned an empty response body')

  const decoder = new TextDecoder()
  let buffer = ''

  type Chunk = Awaited<ReturnType<typeof reader.read>>
  const nextChunk = (): Promise<Chunk> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ProviderError(`Aucune donnée reçue du fournisseur depuis ${Math.round(idleTimeoutMs / 1000)} s — flux interrompu`))
      }, idleTimeoutMs)
      reader.read().then(
        value => { clearTimeout(timer); resolve(value) },
        error => { clearTimeout(timer); reject(error) },
      )
    })

  try {
    while (true) {
      const { done, value } = await nextChunk()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary = buffer.indexOf('\n')
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '')
        buffer = buffer.slice(boundary + 1)
        boundary = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        yield payload
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload && payload !== '[DONE]') yield payload
    }
  } finally {
    bridgedResponse[kDetachBridge]?.()
    reader.releaseLock()
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  connectTimeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<BridgedResponse> {
  // Bridge the caller signal so the socket can always be cancelled, and race
  // the header phase against a wall clock. The detach callback is consumed by
  // readSSE once the body is fully consumed (keeps abort forwarding alive for
  // the whole streaming phase).
  const bridge = new AbortController()
  const forwardAbort = () => bridge.abort(signal.reason)
  if (signal.aborted) forwardAbort()
  else signal.addEventListener('abort', forwardAbort)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: bridge.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(`Le fournisseur n'a pas répondu en ${Math.round(connectTimeoutMs / 1000)} s`)),
          connectTimeoutMs,
        )
      }),
    ]) as BridgedResponse

    if (!response.ok) {
      let detail = ''
      try { detail = (await response.text()).slice(0, 600) } catch { detail = '' }
      throw new ProviderError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
    }

    response[kDetachBridge] = () => signal.removeEventListener('abort', forwardAbort)
    return response
  } catch (error) {
    signal.removeEventListener('abort', forwardAbort)
    if (!signal.aborted) bridge.abort(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wraps a provider stream implementation so that:
 *  - aborts resolve silently,
 *  - every other failure surfaces exactly one `error` event,
 *  - `done` is emitted at most once.
 */
export async function guardStream(
  providerName: string,
  onEvent: (event: ProviderEvent) => void,
  run: (emit: (event: ProviderEvent) => void) => Promise<void>,
): Promise<void> {
  let finished = false
  const emit = (event: ProviderEvent) => {
    if (finished) return
    if (event.type === 'done' || event.type === 'error') finished = true
    onEvent(event)
  }

  try {
    await run(emit)
  } catch (error: unknown) {
    if (isAbort(error)) {
      finished = true
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message: `${providerName}: ${message}` })
  }
}
