import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface TerminalEvents {
  onData(id: string, data: string): void
  onExit(id: string, code: number | null): void
  /** Spawn-level failures (shell missing, permission…), distinct from output. */
  onError(id: string, message: string): void
}

interface Session {
  child: ChildProcessWithoutNullStreams
}

/**
 * Manages interactive shell sessions for the integrated terminal.
 *
 * These are pipe-backed shells, not PTYs: there is no node-pty dependency, so
 * resizing is a renderer-side concern and full-screen TUIs are out of scope.
 * Everything a project needs (npm, git, node, python) works.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly events: TerminalEvents, private readonly fallbackCwd: string) {}

  async create(
    requestedCwd: string | null | undefined,
    /** Shell flavour; cmd.exe stays the default for maximum compatibility. */
    kind: 'cmd' | 'powershell' = 'cmd',
  ): Promise<string> {
    const id = randomUUID()
    const isWindows = process.platform === 'win32'
    const usePowerShell = isWindows && kind === 'powershell'
    const shellPath = isWindows
      ? (usePowerShell ? 'powershell.exe' : (process.env.ComSpec || 'cmd.exe'))
      : (process.env.SHELL || '/bin/sh')

    let cwd = this.fallbackCwd
    if (typeof requestedCwd === 'string' && requestedCwd.trim().length > 0) {
      const candidate = path.resolve(requestedCwd)
      try {
        if ((await fs.stat(candidate)).isDirectory()) cwd = candidate
      } catch {
        // Keep the fallback directory.
      }
    }

    // cmd.exe emits OEM code page bytes by default, which arrive as mojibake
    // once decoded as UTF-8. `/K chcp 65001` switches the child console to UTF-8
    // for the whole session; `/Q` keeps the command itself off the transcript.
    const args = isWindows
      ? (usePowerShell ? ['-NoLogo'] : ['/Q', '/K', 'chcp 65001 > nul'])
      : ['-i']

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(shellPath, args, {
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
        stdio: 'pipe',
        windowsHide: true,
      })
    } catch (error: unknown) {
      this.events.onError(id, error instanceof Error ? error.message : String(error))
      throw error
    }
    this.sessions.set(id, { child })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.events.onData(id, chunk))
    child.stderr.on('data', (chunk: string) => this.events.onData(id, chunk))

    child.on('error', error => {
      this.events.onError(id, error.message)
      this.events.onData(id, `\r\nErreur du terminal: ${error.message}\r\n`)
    })

    child.on('exit', code => {
      this.sessions.delete(id)
      this.events.onData(id, `\r\n[processus termine, code ${code ?? 0}]\r\n`)
      this.events.onExit(id, code)
    })

    return id
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) throw new Error('Terminal indisponible')
    session.child.stdin.write(data)
  }

  /**
   * Kills the whole process tree. `child.kill()` only signals the shell
   * wrapper on Windows, leaving `npm run dev` and friends alive with their
   * ports bound; `taskkill /T /F` removes every descendant.
   */
  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    const { child } = session
    this.sessions.delete(id)

    if (process.platform === 'win32' && typeof child.pid === 'number') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.on('error', () => child.kill())
    } else {
      child.kill()
    }
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
  }
}
