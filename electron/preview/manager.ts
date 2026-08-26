import path from 'node:path'
import { detectPreviewTarget, findPreviewTargets, installCommand } from './detect.js'
import { startStaticServer, type StaticServerHandle } from './server.js'
import { installDependencies, probeUrl, startDevServer, type DevServerHandle } from './runner.js'
import { capturePreview, readCapture, CAPTURE_DIRECTORY, CAPTURE_FILENAME } from './capture.js'
import type {
  PreviewCapture,
  PreviewEvent,
  PreviewState,
  PreviewStatus,
  PreviewTarget,
} from './types.js'

/** Time a dev command gets to expose a working URL. */
const READY_TIMEOUT_MS = 120000
const MAX_LOG_LINES = 300
/** Settle time before the automatic capture, so the first paint is included. */
const AUTO_CAPTURE_DELAY_MS = 1200

export interface PreviewManagerOptions {
  /** Broadcasts every state change to the renderer. */
  emit(event: PreviewEvent): void
  /**
   * Captures `.preview/latest.png` as soon as the served page answers.
   * Disabled outside Electron, where `BrowserWindow` is unavailable.
   */
  autoCapture?: boolean
}

/**
 * Owns the single running preview.
 *
 * Only one preview runs at a time: starting a second one stops the first. Two
 * dev servers on the same project would fight over the same port and leave
 * orphan processes behind.
 */
export class PreviewManager {
  private state: PreviewState = 'idle'
  private workspace: string | null = null
  private target: PreviewTarget | null = null
  private url: string | null = null
  private command: string | null = null
  private message = 'Aucune prévisualisation en cours.'
  private log: string[] = []
  private startedAt: number | null = null
  private readyAt: number | null = null

  private staticServer: StaticServerHandle | null = null
  private devServer: DevServerHandle | null = null
  private controller: AbortController | null = null
  /** Serializes start/stop so overlapping calls cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: PreviewManagerOptions) {}

  status(): PreviewStatus {
    return {
      state: this.state,
      workspace: this.workspace,
      target: this.target,
      url: this.url,
      command: this.command,
      pid: this.devServer?.pid ?? null,
      message: this.message,
      log: [...this.log],
      startedAt: this.startedAt,
      readyAt: this.readyAt,
    }
  }

  private publish(): PreviewStatus {
    const status = this.status()
    this.options.emit({ type: 'status', status })
    return status
  }

  private appendLog(line: string): void {
    this.log.push(line)
    if (this.log.length > MAX_LOG_LINES) this.log.shift()
    this.options.emit({ type: 'log', line })
  }

  private setState(state: PreviewState, message: string): void {
    this.state = state
    this.message = message
    this.publish()
  }

  /** Runs `task` after any in-flight start/stop has settled. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    // Keep the chain alive even when a task rejects.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  detect(workspace: string, relativePath: string): Promise<PreviewTarget> {
    return detectPreviewTarget(workspace, relativePath)
  }

  candidates(workspace: string): Promise<PreviewTarget[]> {
    return findPreviewTargets(workspace)
  }

  /** True when the served directory is affected by a workspace write. */
  private servesPath(changed: string): boolean {
    if (!this.target) return false
    const root = path.resolve(this.target.root)
    const resolved = path.resolve(changed)
    const relative = path.relative(root, resolved)
    return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  /**
   * Signals that files changed on disk.
   *
   * The static server has no watcher, so it needs an explicit revision bump for
   * open pages to reload. A dev server has its own HMR and is left alone.
   */
  notifyFilesChanged(changedPath: string): void {
    if (this.state !== 'running') return
    if (!this.servesPath(changedPath)) return
    if (this.staticServer) {
      this.staticServer.touch()
      this.options.emit({ type: 'reload', reason: 'Fichiers modifiés' })
    }
  }

  async start(input: { workspace: string; relativePath: string; install: boolean }): Promise<PreviewStatus> {
    return this.enqueue(async () => {
      await this.teardown()

      const workspace = path.resolve(input.workspace)
      this.workspace = workspace
      this.log = []
      this.url = null
      this.command = null
      this.readyAt = null
      this.startedAt = Date.now()

      const controller = new AbortController()
      this.controller = controller

      try {
        this.setState('starting', 'Détection du projet')
        const target = await this.detect(workspace, input.relativePath)
        this.target = target
        this.publish()

        if (!target.previewable) {
          throw new Error(target.hint.length > 0 ? target.hint : 'Ce dossier ne contient rien de prévisualisable.')
        }

        if (target.servedBy === 'static') {
          this.setState('starting', `Démarrage du serveur statique (${target.relativeRoot})`)
          const server = await startStaticServer(target.root)
          this.staticServer = server
          const entry = target.entryFile && !target.entryFile.endsWith('index.html')
            ? new URL(path.posix.basename(target.entryFile), server.url).toString()
            : server.url

          if (!await probeUrl(entry)) {
            throw new Error('Le serveur statique n\'a pas répondu.')
          }

          this.url = entry
          this.command = null
          this.readyAt = Date.now()
          this.appendLog(`Serveur statique: ${entry}`)
          this.setState('running', `Aperçu servi depuis ${target.relativeRoot}`)
          this.autoCapture(entry, workspace)
          return this.status()
        }

        if (target.needsInstall) {
          if (!input.install) {
            throw new Error(
              `Les dépendances ne sont pas installées. Lance "${installCommand(target.packageManager)}" `
              + 'ou relance la prévisualisation avec l\'installation activée.',
            )
          }
          this.setState('installing', `Installation des dépendances (${installCommand(target.packageManager)})`)
          const outcome = await installDependencies({
            manager: target.packageManager,
            cwd: target.root,
            signal: controller.signal,
            onLine: line => this.appendLog(line),
          })
          if (!outcome.success) {
            throw new Error(
              `L'installation a échoué (code ${outcome.exitCode ?? 'inconnu'}).\n${outcome.output.slice(-1200)}`,
            )
          }
        }

        this.setState('starting', `Démarrage: ${target.command}`)
        const dev = await startDevServer({
          command: target.command,
          cwd: target.root,
          defaultPort: target.defaultPort,
          signal: controller.signal,
          readyTimeoutMs: READY_TIMEOUT_MS,
          onLine: line => this.appendLog(line),
        })
        this.devServer = dev
        this.url = dev.url
        this.command = dev.command
        this.readyAt = Date.now()
        this.setState('running', `Aperçu servi par "${dev.command}"`)
        this.autoCapture(dev.url, workspace)
        return this.status()
      } catch (error: unknown) {
        await this.teardown()
        this.state = 'error'
        this.message = error instanceof Error ? error.message : String(error)
        this.publish()
        return this.status()
      }
    })
  }

  async stop(): Promise<PreviewStatus> {
    return this.enqueue(async () => {
      const wasRunning = this.state === 'running' || this.state === 'starting' || this.state === 'installing'
      await this.teardown()
      this.state = wasRunning ? 'stopped' : this.state === 'error' ? 'error' : 'idle'
      this.message = wasRunning ? 'Prévisualisation arrêtée.' : this.message
      this.publish()
      return this.status()
    })
  }

  /** Captures the running preview, or an explicit URL. */
  async capture(input: { url?: string; workspace?: string; width?: number; height?: number }): Promise<PreviewCapture> {
    const workspace = input.workspace ? path.resolve(input.workspace) : this.workspace
    if (!workspace) throw new Error('Aucun workspace ouvert pour enregistrer la capture.')

    const url = input.url && input.url.trim().length > 0 ? input.url.trim() : this.url
    if (!url) throw new Error('Aucune URL à capturer: démarre d\'abord la prévisualisation.')

    const capture = await capturePreview({ url, workspace, width: input.width, height: input.height })
    this.options.emit({ type: 'screenshot', capture })
    return capture
  }

  /**
   * Screenshots a freshly started preview in the background.
   *
   * Fire-and-forget on purpose: `start()` must return the URL immediately, and a
   * capture failure (a page that never paints, an offscreen window refused by
   * the OS) must not turn a working preview into an error.
   */
  private autoCapture(url: string, workspace: string): void {
    if (this.options.autoCapture === false) return

    void (async () => {
      // Let the first paint settle; dev servers answer before they render.
      await new Promise(resolve => setTimeout(resolve, AUTO_CAPTURE_DELAY_MS))
      // The user may have stopped or restarted the preview meanwhile.
      if (this.state !== 'running' || this.url !== url) return
      try {
        await this.capture({ url, workspace })
        this.appendLog(`Capture enregistrée: ${CAPTURE_DIRECTORY}/${CAPTURE_FILENAME}`)
      } catch (error: unknown) {
        this.appendLog(`Capture automatique impossible: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  latestCapture(workspace: string): Promise<PreviewCapture | null> {
    return readCapture(workspace)
  }

  /** Releases every resource without touching the reported state. */
  private async teardown(): Promise<void> {
    this.controller?.abort()
    this.controller = null

    const server = this.staticServer
    this.staticServer = null
    if (server) await server.close()

    const dev = this.devServer
    this.devServer = null
    if (dev) await dev.stop()
  }

  /** Called on app shutdown. */
  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      await this.teardown()
      this.state = 'idle'
    })
  }
}
