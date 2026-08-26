import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { shellFor } from '../agent/tools/terminal.js'
import { installCommand } from './detect.js'
import type { PackageManager } from './types.js'

/** Lines kept from the dev-server output; enough to diagnose a failure. */
const MAX_LOG_LINES = 300
const PROBE_TIMEOUT_MS = 2500

/** Ports tried when the dev server does not announce its URL. */
const FALLBACK_PORTS = [5173, 3000, 4321, 4173, 8080, 5174, 3001, 8000]

/**
 * Matches the URL a dev server prints on startup.
 *
 * Vite prints "Local:   http://localhost:5173/", Next prints
 * "- Local:        http://localhost:3000", Astro prints
 * "┃ Local    http://localhost:4321/". Capturing the URL directly is far more
 * reliable than assuming a port, because every one of them falls back to
 * another port when the default is taken.
 */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d{2,5}))?(\/[^\s"'`]*)?/gi

/** Strips ANSI escapes so log lines and URL matching stay clean. */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001B[()][AB0-2]/g, '')
}

/**
 * Rewrites a dev-server URL to the loopback IP.
 *
 * "localhost" can resolve to ::1 while the server only listens on 127.0.0.1,
 * which makes the preview appear broken even though the server is up.
 */
export function normalizeLocalUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (!/^https?:$/.test(parsed.protocol)) return null
  const host = parsed.hostname.toLowerCase()
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '::1' && host !== '[::1]') {
    return null
  }
  parsed.hostname = '127.0.0.1'
  if (parsed.port.length === 0) parsed.port = parsed.protocol === 'https:' ? '443' : '80'
  return parsed.toString()
}

/** Extracts every local URL announced in a chunk of dev-server output. */
export function extractLocalUrls(text: string): string[] {
  const clean = stripAnsi(text)
  const out: string[] = []
  URL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(clean)) !== null) {
    const normalized = normalizeLocalUrl(match[0])
    if (normalized && !out.includes(normalized)) out.push(normalized)
  }
  return out
}

/** Resolves true when the URL answers with any HTTP status. */
export function probeUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const request = http.get(url, { timeout: timeoutMs }, response => {
      // Any status proves something is listening and speaking HTTP; a 404 on
      // the root is still a live dev server.
      response.resume()
      finish(true)
    })
    request.on('timeout', () => {
      request.destroy()
      finish(false)
    })
    request.on('error', () => finish(false))
  })
}

export interface RunCommandResult {
  command: string
  exitCode: number | null
  success: boolean
  output: string
}

/** Runs a one-shot command to completion (used for the install step). */
export function runOnce(options: {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onLine?: (line: string) => void
}): Promise<RunCommandResult> {
  const { file, args, verbatim } = shellFor(options.command)

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
    })

    let output = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    const onAbort = () => child.kill('SIGKILL')
    options.signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
    }

    const consume = (chunk: string) => {
      output += chunk
      if (!options.onLine) return
      for (const line of stripAnsi(chunk).split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length > 0) options.onLine(trimmed.slice(0, 300))
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)

    child.on('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        command: options.command,
        exitCode: code,
        success: !timedOut && code === 0,
        output: stripAnsi(output).slice(-20000),
      })
    })
  })
}

export function installDependencies(options: {
  manager: PackageManager
  cwd: string
  signal: AbortSignal
  onLine?: (line: string) => void
}): Promise<RunCommandResult> {
  return runOnce({
    command: installCommand(options.manager),
    cwd: options.cwd,
    // Installing a framework from scratch is slow; a short timeout would abort
    // a perfectly healthy install.
    timeoutMs: 600000,
    signal: options.signal,
    onLine: options.onLine,
  })
}

export interface DevServerHandle {
  command: string
  cwd: string
  url: string
  pid: number | null
  /** Resolves once the process has exited. */
  stop(): Promise<void>
  /** True while the child process is alive. */
  alive(): boolean
}

/**
 * Kills a process tree.
 *
 * `child.kill()` only signals the shell wrapper on Windows, leaving the actual
 * node/vite process running and the port bound. `taskkill /T` removes the whole
 * tree; on POSIX the negative PID signals the process group.
 */
function killTree(child: ChildProcess): Promise<void> {
  return new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    child.once('exit', finish)

    if (process.platform === 'win32' && typeof child.pid === 'number') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => child.kill('SIGKILL'))
    } else if (typeof child.pid === 'number') {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    } else {
      child.kill('SIGKILL')
    }

    // Never hang the caller if the process refuses to report its exit.
    setTimeout(finish, 5000)
  })
}

export interface StartDevServerOptions {
  command: string
  cwd: string
  defaultPort: number
  signal: AbortSignal
  /** Wall-clock budget for the server to answer an HTTP request. */
  readyTimeoutMs: number
  onLine(line: string): void
}

/**
 * Spawns a dev command and waits until an HTTP endpoint answers.
 *
 * Readiness is decided by a real HTTP probe rather than by output matching
 * alone: several frameworks print their banner before the server accepts
 * connections, and a preview shown too early renders a connection error.
 */
export async function startDevServer(options: StartDevServerOptions): Promise<DevServerHandle> {
  const { file, args, verbatim } = shellFor(options.command)
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      BROWSER: 'none',
      // Vite and CRA open a browser by default; the preview lives in-app.
      OPEN: 'false',
    },
    windowsVerbatimArguments: verbatim,
    windowsHide: true,
    // A process group lets the whole tree be killed on POSIX.
    detached: process.platform !== 'win32',
  })

  const announced: string[] = []
  let exited: { code: number | null; signal: string | null } | null = null
  const logTail: string[] = []

  const consume = (chunk: string) => {
    for (const url of extractLocalUrls(chunk)) {
      if (!announced.includes(url)) announced.push(url)
    }
    for (const line of stripAnsi(chunk).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      logTail.push(trimmed.slice(0, 300))
      if (logTail.length > MAX_LOG_LINES) logTail.shift()
      options.onLine(trimmed.slice(0, 300))
    }
  }

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)

  const spawnFailure = new Promise<never>((_resolve, reject) => {
    child.once('error', error => reject(error))
  })
  child.once('exit', (code, signal) => {
    exited = { code, signal: signal ?? null }
  })

  const deadline = Date.now() + options.readyTimeoutMs
  let ready: string | null = null

  const findReadyUrl = async (): Promise<string | null> => {
    while (Date.now() < deadline) {
      if (options.signal.aborted) throw new Error('Prévisualisation annulée')
      if (exited) {
        const detail = logTail.slice(-12).join('\n')
        throw new Error(
          `La commande "${options.command}" s'est arrêtée (code ${exited.code ?? 'inconnu'}) avant d'exposer une URL.`
          + (detail.length > 0 ? `\n${detail}` : ''),
        )
      }

      const candidates = announced.length > 0
        ? announced
        : [
          ...(options.defaultPort > 0 ? [`http://127.0.0.1:${options.defaultPort}/`] : []),
          ...FALLBACK_PORTS.map(port => `http://127.0.0.1:${port}/`),
        ]

      for (const candidate of candidates) {
        if (await probeUrl(candidate, 1200)) return candidate
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    return null
  }

  try {
    ready = await Promise.race([findReadyUrl(), spawnFailure])
  } catch (error) {
    await killTree(child)
    throw error
  }

  if (!ready) {
    await killTree(child)
    const detail = logTail.slice(-12).join('\n')
    throw new Error(
      `La commande "${options.command}" n'a exposé aucune URL locale en ${Math.round(options.readyTimeoutMs / 1000)} s.`
      + (detail.length > 0 ? `\n${detail}` : ''),
    )
  }

  return {
    command: options.command,
    cwd: path.resolve(options.cwd),
    url: ready,
    pid: child.pid ?? null,
    stop: () => killTree(child),
    alive: () => child.exitCode === null && child.signalCode === null,
  }
}
