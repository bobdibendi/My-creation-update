import { spawn } from 'node:child_process'
import type { Tool } from '../types.js'
import { asRecord, objectSchema, optionalNumber, optionalString, requireString } from '../validate.js'
import { resolveInWorkspace, toRelative } from '../workspace.js'

const MAX_OUTPUT_CHARS = 60000
const DEFAULT_TIMEOUT_MS = 180000
const MAX_TIMEOUT_MS = 900000

/**
 * Commands that would damage the machine beyond the workspace.
 * The agent is allowed to run project tooling, not to reformat disks.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bformat\s+[a-z]:/i, reason: 'formatage de disque' },
  { pattern: /\b(shutdown|logoff)\b/i, reason: 'arrêt ou déconnexion du système' },
  { pattern: /\bdiskpart\b/i, reason: 'partitionnement de disque' },
  { pattern: /\bvssadmin\b/i, reason: 'suppression des clichés instantanés' },
  { pattern: /\bcipher\s+\/w/i, reason: 'effacement sécurisé du disque' },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'formatage de système de fichiers' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: 'écriture brute sur périphérique' },
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(\s|$)/i, reason: 'suppression de la racine du système' },
  { pattern: /(^|\s)(rd|rmdir)\s+\/s[^\n]*\s[a-z]:\\?(\s|$)/i, reason: 'suppression d\'une racine de disque' },
  { pattern: /\breg\s+delete\s+hk(lm|cu)\b/i, reason: 'suppression de clés de registre' },
  { pattern: /\bnetsh\s+.*\bfirewall\b.*\b(off|disable)\b/i, reason: 'désactivation du pare-feu' },
]

function assertAllowed(command: string): void {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Commande refusée (${reason}). Reformule une commande limitée au projet.`)
    }
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  return {
    text: `${text.slice(0, half)}\n... [sortie tronquée] ...\n${text.slice(-half)}`,
    truncated: true,
  }
}

export interface CommandOutcome {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  success: boolean
}

export interface ShellInvocation {
  file: string
  args: string[]
  /**
   * True on Windows: Node's default argument escaping rewrites embedded quotes,
   * which silently corrupts commands like `node -e "process.exit(1)"`. Passing
   * the command verbatim inside `cmd /d /s /c "..."` preserves it exactly.
   */
  verbatim: boolean
}

export function shellFor(command: string): ShellInvocation {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true }
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command], verbatim: false }
}

/** Runs a shell command, streaming progress lines while it executes. */
export function runShellCommand(options: {
  command: string
  cwd: string
  timeoutMs: number
  signal: AbortSignal
  onOutput?: (chunk: string) => void
}): Promise<CommandOutcome> {
  const { file, args, verbatim } = shellFor(options.command)
  const started = Date.now()

  return new Promise<CommandOutcome>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' },
      windowsVerbatimArguments: verbatim,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
    }
    options.signal.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      options.onOutput?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      options.onOutput?.(chunk)
    })

    child.on('error', error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      const out = truncate(stdout)
      const err = truncate(stderr)
      resolve({
        command: options.command,
        cwd: options.cwd,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        success: !timedOut && code === 0,
      })
    })
  })
}

export function createTerminalTools(): Tool[] {
  const runCommand: Tool = {
    name: 'runCommand',
    description: 'Exécute une commande shell avec le workspace comme répertoire de travail (npm, git, node, tsc...). Renvoie stdout, stderr et le code de sortie.',
    mutates: true,
    parameters: objectSchema({
      command: { type: 'string', description: 'Commande complète à exécuter.' },
      cwd: { type: 'string', description: 'Sous-dossier de travail relatif au workspace (défaut ".").' },
      timeoutSeconds: { type: 'integer', description: 'Délai maximal en secondes (défaut 180, max 900).' },
    }, ['command']),
    async execute(args, context) {
      const record = asRecord(args, 'runCommand')
      const command = requireString(record, 'command')
      const cwdInput = optionalString(record, 'cwd', '.')
      const timeoutMs = optionalNumber(record, 'timeoutSeconds', DEFAULT_TIMEOUT_MS / 1000, 1, MAX_TIMEOUT_MS / 1000) * 1000

      assertAllowed(command)
      const cwd = await resolveInWorkspace(context.workspace, cwdInput)

      context.onProgress(`$ ${command}`)
      const outcome = await runShellCommand({
        command,
        cwd,
        timeoutMs,
        signal: context.signal,
        onOutput: chunk => {
          const line = chunk.split('\n').map(part => part.trim()).filter(Boolean).pop()
          if (line) context.onProgress(line.slice(0, 160))
        },
      })

      if (outcome.timedOut) {
        throw new Error(`La commande a dépassé ${Math.round(timeoutMs / 1000)} s et a été interrompue: ${command}`)
      }

      return { ...outcome, cwd: toRelative(context.workspace, cwd) }
    },
  }

  return [runCommand]
}
