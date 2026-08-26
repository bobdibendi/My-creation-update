import { app, BrowserWindow, dialog, ipcMain, shell, safeStorage } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'

import { ProviderRegistry } from './providers/registry.js'
import { createAnthropicProvider } from './providers/anthropic.js'
import { createOpenAIProvider } from './providers/openai.js'
import { createGoogleProvider } from './providers/google.js'
import { createToolsProvider } from './providers/tools.js'
import { ToolRegistry, defaultTools } from './agent/registry.js'
import { AgentRuntime } from './agent/runtime.js'
import { buildChatSystemPrompt } from './agent/prompt.js'
import { KeyStore, maskKey } from './keystore.js'
import { TerminalManager } from './terminal.js'
import { IGNORED_DIRECTORIES } from './agent/workspace.js'
import { PreviewManager } from './preview/manager.js'
import { analyzeProject } from './preview/analyze.js'
import { buildProjectGraph } from './preview/graph.js'
import { initDatabase, closeDatabase, getDatabase } from './database.js'
import { AuthService } from './auth.js'
import { LicenseService } from './license.js'
import { GumroadService, readGumroadConfig } from './gumroad.js'
import { QuotaService, type UsageKind } from './quota.js'
import { PLANS, getPlan } from './plans.js'
import { TaskService } from './tasks.js'
import { ProviderFallbackManager } from './fallback.js'
import { describeError } from './errors.js'
import { planFromVerifiedStatus } from './license-plan.js'
import { KIM_PRO, OX_ALPHA_FREE, readEnvKeys, BUILTIN_FREE_PROVIDERS } from './config/ai-providers.js'
import { createOpenCodeZenProvider } from './providers/opencode-zen.js'
import { setupUpdater } from './updater.js'
import { keyFingerprint, setStreamDiagLogger } from './providers/openai-compatible.js'

/** Fournisseurs intégrés dont la clé appartient à la couche administrateur. */
const BUILTIN_FREE_IDS = new Set(BUILTIN_FREE_PROVIDERS.map(provider => provider.id))

setStreamDiagLogger((event, details) => {
  const parts = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(' ')
  aiLog(`[AI] ${event} ${parts}`)
})
import type {
  AIChatRequest,
  AIStreamEvent,
  AgentEvent,
  AgentStartInput,
  FileNode,
  PreviewEvent,
  ProviderInfo,
  ProviderKeyStatus,
} from './types.js'
import type { AIProvider, ProviderEvent, ChatMessage as ProviderChatMessage } from './providers/registry.js'

const execFileAsync = promisify(execFile)

// ─── Crash diagnostics (temporary) ─────────────────────
// Installed BEFORE any Electron/native call so a native abort is attributed
// to the last STEP log printed.
let __stepCounter = 0
function step(label: string): void {
  __stepCounter += 1
  console.info(`[main] STEP ${__stepCounter}: ${label}`)
}

process.on('uncaughtException', error => {
  console.error(`[main] uncaught exception after STEP ${__stepCounter}:`, error)
})
process.on('unhandledRejection', reason => {
  console.error(`[main] unhandled rejection after STEP ${__stepCounter}:`, reason)
})

// Development is opt-in so `npm start` always loads the built renderer.
const isDev = process.env.ELECTRON_DEV === 'true'

const chatRequests = new Map<string, AbortController>()
const agentSessions = new Map<string, AbortController>()

let mainWindow: BrowserWindow | null = null
let keyStore: KeyStore | null = null
let terminals: TerminalManager | null = null
let preview: PreviewManager | null = null

function keys(): KeyStore {
  if (!keyStore) keyStore = new KeyStore()
  return keyStore
}

// ─── [AI-CRASH] journal persistant de diagnostic ───────
// %APPDATA%\<app>\logs\ai-crash.log — jamais de clé/JWT/secret ici.
export function aiLog(line: string): void {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.appendFileSync(path.join(dir, 'ai-crash.log'), `${new Date().toISOString()} ${line}\n`)
  } catch { /* le diagnostic ne doit jamais faire crasher */ }
}

/**
 * Provisionnement administrateur des clés pour l'EXE PACKAGÉ.
 *
 * Une clé enregistrée en développement vit dans un profil userData lié à
 * l'identité de l'app de dev ; le profil de l'EXE installé ne peut pas la
 * déchiffrer (le chiffrement safeStorage est lié au profil). Mécanisme
 * officiel pour provisionner une installation :
 *
 *   %APPDATA%\\<appName>\\admin-keys.json
 *   { "tools": "...", "opencode-zen": "..." }
 *
 * Ce fichier est déposé par L'ADMINISTRATEUR du logiciel (GPO, script de
 * déploiement, session admin) — jamais par l'utilisateur final. Au premier
 * démarrage : chaque provider valide est injecté dans le KeyStore (re-chiffré
 * via safeStorage dans le profil de l'app), puis le fichier est renommé
 * `.imported`. Un fichier illisible est renommé `.invalid-<horodatage>` pour
 * ne pas boucler. Rien n'est jamais envoyé au renderer ni logué en clair.
 */
async function importAdminKeysFile(): Promise<void> {
  const dir = app.getPath('userData')
  const file = path.join(dir, 'admin-keys.json')

  try {
    if (!fsSync.existsSync(file)) {
      console.info('[ADMIN] provisioning: aucun admin-keys.json dans ce profil — les modèles intégrés dépendront des clés déjà enregistrées')
      return
    }

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(fsSync.readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      const rejected = path.join(dir, `admin-keys.invalid-${Date.now()}`)
      await fs.rename(file, rejected)
      console.info(`[ADMIN] admin-keys.json illisible (JSON invalide) -> renommé ${path.basename(rejected)}`)
      return
    }

    let imported = 0
    for (const [providerId, value] of Object.entries(raw)) {
      if (typeof value !== 'string' || value.trim().length < 8) continue
      try {
        keys().set(providerId, value)
        imported += 1
        console.info(`[AI-DIAG] clé admin importée pour ${providerId} (empreinte ${keyFingerprint(value)})`)
      } catch (error: unknown) {
        console.info(`[ADMIN] import impossible pour ${providerId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    await fs.rename(file, `${file}.imported`)
    console.info(`[ADMIN] provisioning terminé: ${imported} clé(s) importée(s), fichier archivé en .imported`)
  } catch (error: unknown) {
    console.info(`[ADMIN] provisioning: erreur inattendue: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Broadcasts a terminal event to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function terminalManager(): TerminalManager {
  if (!terminals) {
    terminals = new TerminalManager({
      onData: (id, data) => broadcast('terminal:data', { id, data }),
      onExit: (id, code) => broadcast('terminal:exit', { id, code }),
      onError: (id, message) => broadcast('terminal:error', { id, message }),
    }, app.getPath('home'))
  }
  return terminals
}

/**
 * The single preview instance, shared between the UI and the agent tools so a
 * preview started by the agent appears in the Preview tab.
 */
function previewManager(): PreviewManager {
  if (!preview) {
    preview = new PreviewManager({
      emit: (event: PreviewEvent) => broadcast('preview:event', event),
      // Screenshot every started preview so the Analyse tab has an image
      // without the user asking for one.
      autoCapture: true,
    })
  }
  return preview
}

const providers = new ProviderRegistry()
step('ProviderRegistry: avant register anthropic')
providers.register(createAnthropicProvider(() => keys().get('anthropic')))
step('ProviderRegistry: anthropic OK')
providers.register(createOpenAIProvider(() => keys().get('openai')))
step('ProviderRegistry: openai OK')
providers.register(createGoogleProvider(() => keys().get('google')))
step('ProviderRegistry: google OK')
// Kim Pro (backend Top Tools AI masqué) et Ox Alpha Free (OpenCode Zen) :
// clés administrateur via pool + clé personnelle optionnelle.
providers.register(createToolsProvider(
  () => keys().get('tools'),
  () => readEnvKeys(KIM_PRO.keyEnvVars),
))
step('ProviderRegistry: Kim Pro OK')
providers.register(createOpenCodeZenProvider(
  () => keys().get('opencode-zen'),
  () => readEnvKeys(OX_ALPHA_FREE.keyEnvVars),
))
step('ProviderRegistry: Ox Alpha Free OK')

/**
 * Vrai lorsqu'un administrateur a fourni au moins une clé d'infrastructure
 * pour ce fournisseur intégré (variables d'environnement du main process).
 * Journalisé au démarrage uniquement — jamais exposé au renderer.
 */
const adminPoolAvailable = new Map<string, boolean>([
  [KIM_PRO.id, readEnvKeys(KIM_PRO.keyEnvVars) !== null],
  [OX_ALPHA_FREE.id, readEnvKeys(OX_ALPHA_FREE.keyEnvVars) !== null],
])
for (const [id, present] of adminPoolAvailable) {
  console.info(`[main] pool admin ${id}: ${present ? 'présent' : 'absent'}`)
}

/**
 * Fournisseurs autorisés pour un compte : Kim Pro partout, Ox Alpha à partir
 * de PRO, modèles premium (clé personnelle) en PRO ULTIMATE. Le mode local
 * sans session équivaut au plan FREE. C'est la barrière réelle : le filtrage
 * du sélecteur côté renderer n'est que cosmétique.
 */
function allowedProviderIdsFor(userId: number | null): Set<string> {
  const plan = userId !== null ? quotas().getPlan(userId) : getPlan('free')
  const permissions = plan.permissions
  const allowed = new Set<string>()
  if (permissions.builtinFreeModels) allowed.add(KIM_PRO.id)
  if (permissions.oxAlphaModels) allowed.add(OX_ALPHA_FREE.id)
  if (permissions.premiumModels) {
    for (const provider of providers.list()) {
      if (!BUILTIN_FREE_IDS.has(provider.id)) allowed.add(provider.id)
    }
  }
  return allowed
}

/** Refus lisible quand un modèle n'appartient pas au plan de l'utilisateur. */
function modelNotAllowedMessage(providerId: string): string {
  if (providerId === OX_ALPHA_FREE.id) {
    return 'Le modèle Ox Alpha est inclus à partir du plan PRO. Passez à Pro depuis Paramètres → Licence pour l’utiliser.'
  }
  return 'Ce modèle n’est pas inclus dans votre plan actuel. Il est disponible avec My Creation PRO ULTIMATE.'
}

/**
 * Construit le fournisseur effectif pour une requête : le modèle demandé
 * d'abord, puis les autres fournisseurs intégrés gratuits AUTORISÉS en repli
 * UNIQUEMENT sur erreur temporaire (voir ProviderFallbackManager).
 */
function buildChainProvider(primary: AIProvider, allowedIds: Set<string>): AIProvider {
  if (primary.tier !== 'free') return primary
  const others = providers.list().filter(candidate =>
    candidate.id !== primary.id && candidate.tier === 'free' && allowedIds.has(candidate.id))
  if (others.length === 0) return primary

  const manager = new ProviderFallbackManager([primary, ...others])
  return {
    id: primary.id,
    name: primary.name,
    tier: primary.tier,
    models: primary.models,
    stream: (request, onEvent) => manager.stream(request, onEvent),
  }
}

/**
 * Plan IA effectif : la licence prime (claim `plan` du JWT, forme historique
 * type='pro_ultimate' supportée), sinon l'abonnement interne. Une licence
 * inactive ou expirée retombe sur FREE sans redémarrage.
 */
function syncPlanFromLicense(userId: number): void {
  // Plan issu UNIQUEMENT du statut vérifié (claim du JWT RS256 re-validé
  // ou Product ID résolu chez le fournisseur). Ne JAMAIS relire le JSON
  // brut licenseData de SQLite : ce fichier est éditable sur disque.
  const licensedPlan = planFromVerifiedStatus(licenseService?.getLicenseStatus(userId))
  if (quotas().getPlan(userId).id !== licensedPlan) quotas().assignPlan(userId, licensedPlan)
}

// ─── Validation ────────────────────────────────────────
function assertPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Chemin invalide: une chaîne non vide est requise')
  }
  return path.resolve(value)
}

function assertText(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} doit être une chaîne`)
  return value
}

function toHistory(messages: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((entry): entry is { role: string; content: string } =>
      Boolean(entry) && typeof entry === 'object'
      && typeof (entry as { content?: unknown }).content === 'string'
      && ((entry as { role?: unknown }).role === 'user' || (entry as { role?: unknown }).role === 'assistant'))
    .map(entry => ({ role: entry.role as 'user' | 'assistant', content: entry.content }))
}

// ─── Window ────────────────────────────────────────────
function createWindow(): void {
  step('createWindow: avant new BrowserWindow')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  step('createWindow: BrowserWindow créée')

  const win = mainWindow
  win.once('ready-to-show', () => win.show())
  step('createWindow: ready-to-show branché')

  if (isDev) {
    // 127.0.0.1 matches the Vite host: "localhost" can resolve to ::1, which is unbound.
    const url = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
    console.info(`[main] renderer: ${url}`)
    step(`createWindow: loadURL ${url}`)
    void win.loadURL(url)
  } else {
    const file = path.join(__dirname, '..', 'dist', 'index.html')
    console.info(`[main] renderer: ${file}`)
    step(`createWindow: loadFile ${file}`)
    void win.loadFile(file)
  }
  step('createWindow: load* appelé')

    win.webContents.on('did-finish-load', () => {
      console.info('[main] renderer ready')
      console.info('[MY-CREATION-STARTUP] renderer loaded — startup complete')
      // Deep link déjà en attente : renvoyé au cas où le push initial serait
      // arrivé avant l'abonnement du renderer (les doublons sont ignorés).
      if (pendingAuthCallbackUrl && !win.isDestroyed()) {
        win.webContents.send('auth:callback', pendingAuthCallbackUrl)
      }
    })

    // ─── [AI-CRASH] capture des morts de processus ───────
    win.webContents.on('render-process-gone', (_event, details) => {
      const payload = JSON.stringify(details)
      aiLog(`RENDERER-GONE ${payload}`)
      console.error(`[AI-CRASH] renderer gone: ${payload}`)
    })
    win.webContents.on('unresponsive', () => {
      aiLog('WEBCONTENTS-UNRESPONSIVE')
      console.error('[AI-CRASH] webContents unresponsive')
    })
    win.webContents.on('responsive', () => {
      aiLog('WEBCONTENTS-RESPONSIVE')
    })
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      aiLog(`DID-FAIL-LOAD code=${code} desc=${description} url=${url}`)
    })
    app.on('render-process-gone', (_event, _wc, details) => {
      aiLog(`APP-RENDERER-GONE ${JSON.stringify(details)}`)
    })
    app.on('child-process-gone', (_event, details) => {
      aiLog(`CHILD-GONE type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${(details as unknown as { name?: string }).name ?? ''} service=${(details as unknown as { serviceName?: string }).serviceName ?? ''}`)
    })

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`[main] renderer load failed: ${code} ${description}`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] renderer gone: ${details.reason} (exitCode=${details.exitCode})`)
  })

  // Never let the renderer navigate away or spawn native windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))
  win.on('closed', () => { mainWindow = null })
}

// ─── IPC ───────────────────────────────────────────────
function setupWindowIPC(): void {
  ipcMain.handle('window:minimize', event => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:maximize', event => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle('window:close', event => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:isMaximized', event =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)

  ipcMain.handle('window:devtools', event => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools({ mode: 'detach' })
  })
}

function setupFileIPC(): void {
  ipcMain.handle('files:open-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('files:read', (_event, target: unknown) => fs.readFile(assertPath(target), 'utf8'))

  ipcMain.handle('files:write', async (_event, target: unknown, content: unknown) => {
    const file = assertPath(target)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, assertText(content, 'content'), 'utf8')
  })

  ipcMain.handle('files:list', async (_event, target: unknown): Promise<FileNode[]> => {
    const dir = assertPath(target)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => !entry.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(entry => ({
        name: entry.name,
        path: path.join(dir, entry.name),
        kind: entry.isDirectory() ? 'directory' : 'file',
      }))
  })

  ipcMain.handle('files:list-recursive', async (_event, target: unknown): Promise<FileNode[]> => {
    const root = assertPath(target)
    const out: FileNode[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || out.length >= 8000) return
      let entries
      try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (out.length >= 8000) return
        if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        const isDirectory = entry.isDirectory()
        out.push({ name: entry.name, path: full, kind: isDirectory ? 'directory' : 'file' })
        if (isDirectory) await walk(full, depth + 1)
      }
    }

    await walk(root, 0)
    return out
  })

  ipcMain.handle('files:create', async (_event, parent: unknown, name: unknown, isDir: unknown): Promise<FileNode> => {
    const entryName = assertText(name, 'name').trim()
    if (entryName.length === 0 || /[\\/]/.test(entryName)) throw new Error('Nom de fichier invalide')
    const full = path.join(assertPath(parent), entryName)

    if (isDir === true) await fs.mkdir(full, { recursive: true })
    else {
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, '', { encoding: 'utf8', flag: 'wx' })
    }
    return { name: entryName, path: full, kind: isDir === true ? 'directory' : 'file' }
  })

  ipcMain.handle('files:delete', async (_event, target: unknown) => {
    await fs.rm(assertPath(target), { recursive: true, force: true })
  })

  ipcMain.handle('files:rename', async (_event, target: unknown, newName: unknown): Promise<FileNode> => {
    const name = assertText(newName, 'newName').trim()
    if (name.length === 0 || /[\\/]/.test(name)) throw new Error('Nouveau nom invalide')
    const source = assertPath(target)
    const destination = path.join(path.dirname(source), name)
    await fs.rename(source, destination)
    const stats = await fs.stat(destination)
    return { name, path: destination, kind: stats.isDirectory() ? 'directory' : 'file' }
  })

  ipcMain.handle('files:exists', async (_event, target: unknown): Promise<boolean> => {
    try {
      await fs.access(assertPath(target))
      return true
    } catch {
      return false
    }
  })
}

function setupTerminalIPC(): void {
  ipcMain.handle('terminal:create', (_event, cwd: unknown, kind: unknown) =>
    terminalManager().create(
      typeof cwd === 'string' ? cwd : null,
      kind === 'powershell' ? 'powershell' : 'cmd',
    ))

  ipcMain.handle('terminal:write', (_event, id: unknown, data: unknown) => {
    terminalManager().write(String(id), assertText(data, 'data'))
  })

  // Resizing needs a real PTY; the renderer reflows xterm on its own.
  ipcMain.handle('terminal:resize', () => undefined)

  ipcMain.handle('terminal:kill', (_event, id: unknown) => {
    terminalManager().kill(String(id))
  })
}

function setupGitIPC(): void {
  /**
   * Resolves the repository that owns a directory.
   *
   * Git searches upwards, so a folder that is not itself a repository can
   * resolve to an unrelated ancestor repository (for example the user's home
   * directory). Every git operation is therefore reported and scoped relative
   * to this root, and staging is limited to the opened folder.
   */
  const repositoryRoot = async (cwd: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 15000 })
      const root = stdout.trim()
      return root.length > 0 ? path.resolve(root) : null
    } catch {
      return null
    }
  }

  ipcMain.handle('git:status', async (_event, cwd: unknown) => {
    const dir = assertPath(cwd)
    if (!await repositoryRoot(dir)) return ''
    try {
      // The `-- .` pathspec keeps the listing limited to the opened folder.
      // `--untracked-files=all` is required: the default collapses an untracked
      // directory into a single entry (`?? paquet/`, or `?? ./` when the opened
      // folder is itself untracked), which tells the user nothing about which
      // files actually changed.
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--short', '--branch', '--untracked-files=all', '--', '.'],
        { cwd: dir, timeout: 15000 },
      )
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('git:branches', async (_event, cwd: unknown) => {
    const dir = assertPath(cwd)
    if (!await repositoryRoot(dir)) return []
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--format=%(refname:short)'], { cwd: dir, timeout: 15000 })
      return stdout.split(/\r?\n/).filter(Boolean)
    } catch {
      return []
    }
  })

  ipcMain.handle('git:root', async (_event, cwd: unknown) => {
    const dir = assertPath(cwd)
    const root = await repositoryRoot(dir)
    if (!root) return null
    return { root, isRoot: root === dir }
  })

  ipcMain.handle('git:run', async (_event, cwd: unknown, args: unknown) => {
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
      throw new Error('Arguments git invalides')
    }
    const dir = assertPath(cwd)
    if (!await repositoryRoot(dir)) throw new Error('Ce dossier n\'appartient à aucun dépôt Git')
    const { stdout, stderr } = await execFileAsync('git', args as string[], { cwd: dir, timeout: 60000 })
    return `${stdout}${stderr}`
  })
}

function setupKeyIPC(): void {
  ipcMain.handle('api:storeKey', (_event, provider: unknown, key: unknown): ProviderKeyStatus => {
    const id = String(provider)
    if (typeof key !== 'string' || key.trim().length < 8) {
      return { success: false, provider: id, configured: keys().get(id) !== null, error: 'La clé API est trop courte' }
    }
    if (!providers.get(id)) {
      return { success: false, provider: id, configured: false, error: `Fournisseur inconnu: ${id}` }
    }

    try {
      keys().set(id, key)
      const stored = keys().get(id)
      return stored
        ? { success: true, provider: id, configured: true, maskedKey: maskKey(stored) }
        : { success: false, provider: id, configured: false, error: 'La clé n\'a pas été enregistrée' }
    } catch (error: unknown) {
      return {
        success: false,
        provider: id,
        configured: false,
        error: `Enregistrement impossible: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })

  ipcMain.handle('api:checkKey', (_event, provider: unknown): ProviderKeyStatus => {
    const id = String(provider)
    try {
      const key = keys().get(id)
      return {
        success: true,
        provider: id,
        configured: key !== null,
        maskedKey: key ? maskKey(key) : undefined,
      }
    } catch (error: unknown) {
      return {
        success: false,
        provider: id,
        configured: false,
        error: `Lecture impossible: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })

  ipcMain.handle('api:deleteKey', (_event, provider: unknown): ProviderKeyStatus => {
    const id = String(provider)
    try {
      keys().remove(id)
      return { success: true, provider: id, configured: keys().get(id) !== null }
    } catch (error: unknown) {
      return {
        success: false,
        provider: id,
        configured: keys().get(id) !== null,
        error: `Suppression impossible: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  })

  // Catalogue filtré selon le plan de la session passée en argument :
  // sans session (mode local) ou FREE -> Kim Pro seul ; PRO ajoute Ox Alpha ;
  // PRO ULTIMATE expose tout. Appelé SANS token (Paramètres), le catalogue
  // complet est renvoyé pour la gestion des clés personnelles.
  ipcMain.handle('api:listProviders', (_event, sessionToken: unknown): ProviderInfo[] => {
    const scoped = typeof sessionToken === 'string' && sessionToken.length > 0
    const allowed = scoped ? allowedProviderIdsFor(resolveOptionalUserId(sessionToken)) : null
    return providers.list()
      .filter(provider => !allowed || allowed.has(provider.id))
      .map(provider => ({
        id: provider.id,
        name: provider.name,
        // Fournisseurs intégrés ('admin') : les clés administrateur sont
        // gérées exclusivement côté main process. L'utilisateur n'a jamais de
        // clé à saisir -> toujours « prêt » aux yeux du renderer. Le vrai état
        // de la clé est revérifié côté main à l'envoi (message clair si absent).
        configured: BUILTIN_FREE_IDS.has(provider.id)
          ? true
          : keys().get(provider.id) !== null,
        tier: provider.tier ?? 'premium',
        models: provider.models.map(model => ({
          id: model.id,
          label: model.label,
          provider: provider.id,
          supportsTools: model.supportsTools,
        })),
      }))
  })
}

function setupChatIPC(): void {
  ipcMain.handle('ai:chat', (event, request: AIChatRequest) => {
    const requestId = randomUUID()
    const sender = event.sender
    const emit = (payload: AIStreamEvent) => {
      if (!sender.isDestroyed()) sender.send('ai:chunk', payload)
    }

    const controller = new AbortController()
    chatRequests.set(requestId, controller)

    void (async () => {
      try {
        if (!request || !Array.isArray(request.messages) || typeof request.model !== 'string') {
          throw new Error('Paramètres de conversation invalides')
        }
        const resolved = providers.resolveModel(request.model)
        if (!resolved) throw new Error(`Modèle inconnu: ${request.model}`)

        const history = toHistory(request.messages)
        if (history.length === 0) throw new Error('Aucun message à envoyer')

        // Quota gate: the request is refused BEFORE reaching the provider.
        const userId = resolveUserId(request.sessionToken)
        if (userId !== null) {
          const promptText = history.map(message => message.content).join('\n')
          const check = quotas().checkQuota(userId, QuotaService.estimateTokens(promptText))
          if (!check.allowed) {
            emit({ type: 'error', requestId, message: check.reason ?? 'Quota quotidien atteint.' })
            return
          }
        }

        // Plan gate : le modèle demandé doit appartenir au plan effectif.
        const allowedProviders = allowedProviderIdsFor(userId)
        if (!allowedProviders.has(resolved.provider.id)) {
          emit({ type: 'error', requestId, message: modelNotAllowedMessage(resolved.provider.id) })
          return
        }

        const messages: ProviderChatMessage[] = [
          {
            role: 'system',
            content: buildChatSystemPrompt({
              workspace: request.workspace ?? null,
              activeFilePath: request.activeFilePath,
              activeFileExcerpt: request.activeFileExcerpt,
              tasksSummary: userId !== null
                ? tasks().summaryForPrompt(userId)
                : tasks().summaryForPrompt(null),
            }),
          },
          ...history,
        ]

        emit({ type: 'start', requestId })
        aiLog(`[AI] request:start id=${requestId} provider=${resolved.provider.id} model=${resolved.model.id}`)

        let failure: string | null = null
        let answerText = ''
        let usageRecorded = false
        // Chaîne de repli : le modèle demandé, puis les autres fournisseurs
        // intégrés gratuits AUTORISÉS par le plan, uniquement sur erreur temporaire.
        await buildChainProvider(resolved.provider, allowedProviders).stream({
          messages,
          model: resolved.model.id,
          signal: controller.signal,
        }, providerEvent => {
          if (providerEvent.type === 'text') {
            answerText += providerEvent.text
            emit({ type: 'text', requestId, text: providerEvent.text })
          } else if (providerEvent.type === 'reasoning') {
            // Modèle « thinking » : signalé comme statut, jamais confondu
            // avec la réponse.
            emit({ type: 'reasoning', requestId, text: providerEvent.text })
          } else if (providerEvent.type === 'usage' && userId !== null) {
            usageRecorded = true
            recordAndBroadcast(
              userId, 'chat', resolved.provider.id, resolved.model.id,
              { inputTokens: providerEvent.inputTokens, outputTokens: providerEvent.outputTokens },
            )
          } else if (providerEvent.type === 'error') failure = describeError(new Error(providerEvent.message)).message
        })

        if (failure) {
          aiLog(`[AI] stream error id=${requestId}: ${String(failure).slice(0, 200)}`)
          emit({ type: 'error', requestId, message: failure })
        } else {
          aiLog(`[AI] stream completed id=${requestId}`)
          emit({ type: 'done', requestId })
        }

        // Estimated accounting when the backend sent no usage summary.
        if (userId !== null && !usageRecorded && !controller.signal.aborted) {
          recordAndBroadcast(
            userId, 'chat', resolved.provider.id, resolved.model.id,
            { inputTokens: 0, outputTokens: 0 },
            messages.map(message => message.content).join('\n'),
            answerText,
          )
        }
      } catch (error: unknown) {
        emit({ type: 'error', requestId, message: describeError(error).message })
      } finally {
        chatRequests.delete(requestId)
      }
    })()

    return { requestId }
  })

  ipcMain.handle('ai:cancel', (_event, requestId: unknown) => {
    if (typeof requestId === 'string' && requestId.length > 0) {
      chatRequests.get(requestId)?.abort()
      chatRequests.delete(requestId)
      return
    }
    for (const controller of chatRequests.values()) controller.abort()
    chatRequests.clear()
  })
}

function setupAgentIPC(): void {
  ipcMain.handle('agent:start', (event, input: AgentStartInput) => {
    const sessionId = randomUUID()
    const sender = event.sender
    const emit = (payload: AgentEvent) => {
      if (!sender.isDestroyed()) sender.send('agent:event', payload)
    }

    const controller = new AbortController()
    agentSessions.set(sessionId, controller)

    void (async () => {
      try {
        if (!input || typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
          throw new Error('La demande est vide')
        }
        if (typeof input.workspace !== 'string' || input.workspace.trim().length === 0) {
          throw new Error('Ouvre un dossier de travail avant d\'utiliser le mode Agent')
        }

        const workspace = path.resolve(input.workspace)
        const stats = await fs.stat(workspace).catch(() => null)
        if (!stats?.isDirectory()) throw new Error(`Workspace introuvable: ${workspace}`)

        const resolved = providers.resolveModel(input.model)
        if (!resolved) throw new Error(`Modèle inconnu: ${input.model}`)

        // Quota gate: refused BEFORE the agent consumes anything.
        const userId = resolveUserId(input.sessionToken)
        if (userId !== null) {
          const estimateSource = [
            input.prompt,
            ...(input.history ?? []).map(entry => entry.content),
            input.activeFileExcerpt ?? '',
          ].join('\n')
          // The agent runs several provider turns; keep a safety margin.
          const check = quotas().checkQuota(userId, QuotaService.estimateTokens(estimateSource) * 4)
          if (!check.allowed) {
            emit({ type: 'error', sessionId, message: check.reason ?? 'Quota quotidien atteint.' })
            return
          }
        }

        // Plan gate : même barrière que pour le chat, évaluée côté main.
        const allowedProviders = allowedProviderIdsFor(userId)
        if (!allowedProviders.has(resolved.provider.id)) {
          throw new Error(modelNotAllowedMessage(resolved.provider.id))
        }

        // The agent shares the application's preview manager, so startPreview
        // shows up in the Preview tab rather than in a hidden second server.
        // Les outils Todo sont scopes au compte de la session (null = local).
        const taskUserId = userId !== null ? userId : null
        const registry = new ToolRegistry(defaultTools(previewManager(), {
          userId: taskUserId,
          service: tasks(),
        }))
        const { provider: talliedProvider, tally } = withUsageTally(buildChainProvider(resolved.provider, allowedProviders))
        const runtime = new AgentRuntime(registry, talliedProvider, resolved.model)

        let historyText = ''
        for (const entry of input.history ?? []) historyText += `${entry.content}\n`

        const result = await runtime.run({
          prompt: input.prompt,
          workspace,
          activeFilePath: input.activeFilePath,
          activeFileExcerpt: input.activeFileExcerpt,
          history: toHistory(input.history),
          tasksSummary: tasks().summaryForPrompt(taskUserId),
        }, controller.signal, runtimeEvent => {
          switch (runtimeEvent.type) {
            case 'status':
              emit({ type: 'status', sessionId, text: runtimeEvent.text })
              break
            case 'text':
              emit({ type: 'text', sessionId, text: runtimeEvent.text })
              break
            case 'tool-call':
              emit({ type: 'tool-call', sessionId, id: runtimeEvent.id, tool: runtimeEvent.tool, args: runtimeEvent.args })
              break
            case 'tool-result':
              emit({
                type: 'tool-result',
                sessionId,
                id: runtimeEvent.id,
                tool: runtimeEvent.tool,
                success: runtimeEvent.success,
                summary: runtimeEvent.summary,
              })
              break
            case 'files-changed':
              // The static preview has no file watcher, so it needs an explicit
              // signal for open pages to reload.
              previewManager().notifyFilesChanged(workspace)
              emit({ type: 'files-changed', sessionId, workspace })
              break
          }
        })

        emit({ type: 'done', sessionId, text: result.text, turns: result.turns, toolCalls: result.toolCalls })

        if (userId !== null && !controller.signal.aborted) {
          recordAndBroadcast(
            userId, 'agent', resolved.provider.id, resolved.model.id, tally,
            `${historyText}${input.prompt}${input.activeFileExcerpt ?? ''}`,
            result.text,
          )
        }
      } catch (error: unknown) {
        emit({ type: 'error', sessionId, message: describeError(error).message })
      } finally {
        agentSessions.delete(sessionId)
      }
    })()

    return { sessionId }
  })

  ipcMain.handle('agent:cancel', (_event, sessionId: unknown) => {
    const id = String(sessionId)
    agentSessions.get(id)?.abort()
    agentSessions.delete(id)
  })

  /** Utilisé par la déconnexion : coupe TOUS les flux IA/agent en cours. */
  ipcMain.handle('agent:cancel-all', () => {
    for (const controller of agentSessions.values()) controller.abort()
    agentSessions.clear()
    return true
  })
}

function setupPreviewIPC(): void {
  const relative = (value: unknown): string => (typeof value === 'string' ? value : '')

  ipcMain.handle('preview:detect', (_event, workspace: unknown, target: unknown) =>
    previewManager().detect(assertPath(workspace), relative(target)))

  ipcMain.handle('preview:candidates', (_event, workspace: unknown) =>
    previewManager().candidates(assertPath(workspace)))

  ipcMain.handle('preview:start', (_event, workspace: unknown, target: unknown, install: unknown) =>
    previewManager().start({
      workspace: assertPath(workspace),
      relativePath: relative(target),
      install: install !== false,
    }))

  ipcMain.handle('preview:stop', () => previewManager().stop())

  ipcMain.handle('preview:status', () => previewManager().status())

  ipcMain.handle('preview:capture', (_event, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>
    return previewManager().capture({
      workspace: assertPath(record.workspace),
      url: typeof record.url === 'string' && record.url.trim().length > 0 ? record.url : undefined,
      width: typeof record.width === 'number' ? record.width : undefined,
      height: typeof record.height === 'number' ? record.height : undefined,
    })
  })

  ipcMain.handle('preview:latest-capture', (_event, workspace: unknown) =>
    previewManager().latestCapture(assertPath(workspace)))

  // Only loopback preview URLs may be handed to the OS browser: the renderer
  // must not be able to use this channel as a generic "open anything" shell.
  ipcMain.handle('preview:open-external', async (_event, url: unknown) => {
    const value = assertText(url, 'url')
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new Error('URL invalide')
    }
    const host = parsed.hostname.toLowerCase()
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    if (!/^https?:$/.test(parsed.protocol) || !isLoopback) {
      throw new Error('Seules les URL locales de prévisualisation peuvent être ouvertes')
    }
    await shell.openExternal(parsed.toString())
    return true
  })
}

function setupProjectIPC(): void {
  ipcMain.handle('project:analyze', (_event, workspace: unknown, target: unknown) =>
    analyzeProject({
      workspace: assertPath(workspace),
      previewPath: typeof target === 'string' ? target : '',
    }))

  ipcMain.handle('project:graph', (_event, workspace: unknown, target: unknown, maxDepth: unknown) =>
    buildProjectGraph({
      workspace: assertPath(workspace),
      relativeRoot: typeof target === 'string' ? target : '',
      maxDepth: typeof maxDepth === 'number' ? maxDepth : undefined,
    }))
}

// ─── Auth & License IPC ────────────────────────────────
let authService: AuthService | null = null
let licenseService: LicenseService | null = null
let gumroadService: GumroadService | null = null
let quotaService: QuotaService | null = null
let taskService: TaskService | null = null

function quotas(): QuotaService {
  if (!quotaService) quotaService = new QuotaService(getDatabase())
  return quotaService
}

function tasks(): TaskService {
  if (!taskService) {
    taskService = new TaskService()
    taskService.setChangeNotifier((userId, origin) => {
      broadcast('tasks:changed', { tasks: taskService!.list(userId), origin })
    })
  }
  return taskService
}

/** Session optionnelle : les tâches existent aussi hors compte (FREE local). */
function resolveOptionalUserId(sessionToken: unknown): number | null {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return null
  try {
    const session = authService?.verifySession(sessionToken)
    return session?.user.id ?? null
  } catch {
    return null
  }
}

/** Resolves the account behind an optional session token (null when absent). */
function resolveUserId(sessionToken: unknown): number | null {
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) return null
  try {
    const session = authService?.verifySession(sessionToken)
    return session?.user.id ?? null
  } catch {
    return null
  }
}

interface TokenTally {
  inputTokens: number
  outputTokens: number
}

/**
 * Wraps a provider so every `usage` event of a multi-turn run is accumulated.
 * The renderer-visible stream is untouched.
 */
function withUsageTally(provider: AIProvider): { provider: AIProvider; tally: TokenTally } {
  const tally: TokenTally = { inputTokens: 0, outputTokens: 0 }
  const wrapped: AIProvider = {
    id: provider.id,
    name: provider.name,
    models: provider.models,
    async stream(request, onEvent: (event: ProviderEvent) => void): Promise<void> {
      return provider.stream(request, event => {
        if (event.type === 'usage') {
          tally.inputTokens += event.inputTokens
          tally.outputTokens += event.outputTokens
        }
        onEvent(event)
      })
    },
  }
  return { provider: wrapped, tally }
}

/**
 * Records real consumption and broadcasts the fresh summary plus any newly
 * crossed alert threshold (80 / 90 / 100 %).
 */
function recordAndBroadcast(userId: number, kind: UsageKind, providerId: string, modelId: string, tally: TokenTally, fallbackInputText?: string, fallbackOutputText?: string): void {
  let inputTokens = tally.inputTokens
  let outputTokens = tally.outputTokens

  // The backend reported nothing: fall back to a character-count estimate so
  // the accounting stays truthful about being an estimate.
  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens = QuotaService.estimateTokens(fallbackInputText)
    outputTokens = QuotaService.estimateTokens(fallbackOutputText)
  }

  const service = quotas()
  const event = service.recordUsage(userId, {
    kind,
    provider: providerId,
    model: modelId,
    inputTokens,
    outputTokens,
  })

  broadcast('quota:update', event.summary)
  for (const threshold of event.crossedThresholds) {
    broadcast('quota:alert', { threshold, summary: event.summary })
  }
}

/** Resolves the session from a token or throws for unauthenticated calls. */
function requireSession(token: unknown): { userId: number; user: ReturnType<AuthService['getUserById']> } {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Session invalide')
  }
  const session = authService!.verifySession(token)
  if (!session) throw new Error('Session expirée ou inexistante')
  return { userId: session.user.id, user: session.user }
}

function setupAuthIPC(): void {
  step('setupAuthIPC: avant new AuthService')
  authService = new AuthService()
  step('setupAuthIPC: AuthService OK (bcrypt + DB chargés)')
  licenseService = new LicenseService()
  step('setupAuthIPC: LicenseService OK')
  // Gumroad : deuxième source de licences (lifetime), vérifiée via l'API
  // officielle CÔTÉ MAIN PROCESS. Les Product IDs viennent de
  // l'environnement ; le renderer n'a jamais à les connaître.
  gumroadService = new GumroadService(readGumroadConfig())
  licenseService.setGumroadService(gumroadService)
  licenseService.setPlanChangeNotifier(() => broadcast('plan:update', { reason: 'license-refreshed' }))
  step(`setupAuthIPC: Gumroad OK (produits configurés: ${gumroadService.configured ? 'oui' : 'non'})`)

  ipcMain.handle('auth:register', async (_event, email: unknown, password: unknown, name: unknown) => {
    assertText(email, 'email')
    assertText(password, 'password')
    assertText(name, 'name')
    const result = await authService!.register({ email: String(email).trim().toLowerCase(), password: String(password), name: String(name).trim() })
    return result
  })

  ipcMain.handle('auth:login', async (_event, email: unknown, password: unknown) => {
    assertText(email, 'email')
    assertText(password, 'password')
    return authService!.login({ email: String(email).trim().toLowerCase(), password: String(password) })
  })

  ipcMain.handle('auth:logout', (_event, token: unknown) => {
    if (typeof token === 'string') authService!.logout(token)
  })

  // Pont Supabase : l'identité a déjà été vérifiée par Supabase Auth côté
  // renderer (JWT de session). Ici on synchronise uniquement le miroir local.
  ipcMain.handle('auth:ensure-supabase', async (_event, input: unknown) => {
    const identity = (input ?? {}) as { supabaseId?: unknown; email?: unknown; name?: unknown }
    assertText(identity.supabaseId, 'supabaseId')
    assertText(identity.email, 'email')
    return authService!.ensureSupabaseUser({
      supabaseId: String(identity.supabaseId),
      email: String(identity.email),
      name: typeof identity.name === 'string' ? identity.name : null,
    })
  })

  ipcMain.handle('auth:get-session', (_event, token: unknown) => {
    if (typeof token !== 'string' || token.length === 0) return null
    return authService!.verifySession(token)
  })

  // Deep link d'auth : tirage unique au démarrage du renderer (cas froid où
  // l'application a été lancée PAR le lien e-mail). Consommé une seule fois ;
  // les liens chauds arrivent en plus via le canal push « auth:callback ».
  ipcMain.handle('auth:take-auth-callback', () => {
    const url = pendingAuthCallbackUrl
    pendingAuthCallbackUrl = null
    return url
  })

  ipcMain.handle('auth:update-profile', (_event, token: unknown, changes: unknown) => {
    const { userId } = requireSession(token)
    const input = (changes ?? {}) as { name?: unknown; email?: unknown }
    const result = authService!.updateProfile(userId, {
      name: typeof input.name === 'string' ? input.name : undefined,
      email: typeof input.email === 'string' ? input.email : undefined,
    })
    if (result.success) broadcast('plan:update', { reason: 'profile-updated' })
    return result
  })

  ipcMain.handle('auth:change-password', async (_event, token: unknown, currentPassword: unknown, newPassword: unknown) => {
    const { userId } = requireSession(token)
    assertText(currentPassword, 'currentPassword')
    assertText(newPassword, 'newPassword')
    // Aucun mot de passe n'est journalisé.
    const result = await authService!.changePassword(userId, String(currentPassword), String(newPassword))
    return result
  })

  ipcMain.handle('license:activate', (_event, token: unknown, licenseKey: unknown) => {
    const { userId } = requireSession(token)
    assertText(licenseKey, 'licenseKey')
    const result = licenseService!.activateLicense(userId, String(licenseKey).trim())
    if (result.success && result.license) {
      // Upgrade/downgrade : le plan effectif est recalculé immédiatement et
      // poussé au renderer (permissions, modèles, badge) sans redémarrage.
      syncPlanFromLicense(userId)
      broadcast('plan:update', { reason: 'license-activated', licenseType: result.license.type })
      return {
        success: true,
        license: {
          id: result.license.id,
          type: result.license.type,
          product: result.license.product,
          version: result.license.version,
          activatedAt: result.license.activatedAt,
          expiresAt: result.license.expiresAt,
        },
      }
    }
    return { success: false, error: result.error }
  })

  ipcMain.handle('license:get-status', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    return licenseService!.getLicenseStatus(userId)
  })

  // ─── Gumroad : deuxième source d'activation (lifetime) ───
  ipcMain.handle('license:activate-gumroad', async (_event, token: unknown, licenseKey: unknown) => {
    const { userId } = requireSession(token)
    assertText(licenseKey, 'licenseKey')
    if (!gumroadService) return { success: false, error: 'Service Gumroad indisponible' }
    const result = await licenseService!.activateGumroadLicense(userId, String(licenseKey).trim(), gumroadService)
    if (result.success && result.license) {
      syncPlanFromLicense(userId)
      broadcast('plan:update', { reason: 'license-activated', licenseType: result.license.type })
      return {
        success: true,
        license: {
          id: result.license.id,
          type: result.license.type,
          product: result.license.product,
          version: result.license.version,
          activatedAt: result.license.activatedAt,
          expiresAt: result.license.expiresAt,
        },
      }
    }
    return { success: false, error: result.error }
  })

  /**
   * Désactivation LOCALE de toutes les licences du compte : l'utilisateur
   * retombe sur FREE immédiatement. Ni le License Generator ni Gumroad ne
   * sont impactés — seule la référence locale est supprimée.
   */
  ipcMain.handle('license:deactivate', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    const removed = licenseService!.deactivateAllForUser(userId)
    syncPlanFromLicense(userId)
    broadcast('plan:update', { reason: 'license-deactivated' })
    return { success: true, removed }
  })

  ipcMain.handle('license:get-licenses', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    return licenseService!
      .getUserLicenses(userId)
      .map(l => ({
        id: l.id,
        type: l.type,
        product: l.product,
        version: l.version,
        activatedAt: l.activatedAt,
        expiresAt: l.expiresAt,
      }))
  })

  // ─── Abonnement IA (distinct de la licence produit) ───
  ipcMain.handle('subscription:get', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    syncPlanFromLicense(userId)
    const summary = quotas().getUsage(userId)
    const status = licenseService!.getLicenseStatus(userId)
    return {
      plan: summary.plan,
      dailyTokenLimit: summary.dailyTokenLimit,
      percentUsed: summary.percentUsed,
      licenseType: status.type,
      licenseExpiresAt: status.expiresAt,
    }
  })

  ipcMain.handle('subscription:usage', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    syncPlanFromLicense(userId)
    return quotas().getUsage(userId)
  })

  ipcMain.handle('subscription:plans', () => PLANS)

  /** Droits effectifs : plan + licence évalués côté main, jamais côté UI. */
  ipcMain.handle('permissions:get', (_event, token: unknown) => {
    const { userId } = requireSession(token)
    syncPlanFromLicense(userId)
    const plan = quotas().getPlan(userId)
    return {
      planId: plan.id,
      planName: plan.name,
      permissions: plan.permissions,
      dailyTokenLimit: plan.dailyTokenLimit,
    }
  })
}

// ─── Package IPC ───────────────────────────────────────
interface PackagingState {
  running: boolean
  stage: string
  child: import('node:child_process').ChildProcess | null
  startedAt: number
}

const packaging: PackagingState = { running: false, stage: '', child: null, startedAt: 0 }

function packagingStage(stage: string): void {
  packaging.stage = stage
  broadcast('package:progress', { stage, line: `[${stage}]` })
}

/** Spawns one shell command inside the workspace, streaming every line. */
function runPackagingStep(command: string, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const shellPath = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
    const child = spawn(shellPath, args, { cwd, windowsHide: true })
    packaging.child = child

    const consume = (chunk: Buffer | string) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed.length > 0) broadcast('package:progress', { stage: packaging.stage, line: trimmed.slice(0, 500) })
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    child.on('error', reject)
    child.on('close', code => {
      packaging.child = null
      if (code === 0) resolve(0)
      else reject(new Error(`La commande "${command}" a échoué (code ${code ?? 'inconnu'}).`))
    })
  })
}

async function findInstaller(workspace: string, startedAt: number): Promise<string | null> {
  let manifest: { build?: { directories?: { output?: string }; artifactName?: string } } = {}
  try {
    manifest = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'))
  } catch { /* handled by caller */ }
  const outputDirName = manifest.build?.directories?.output ?? 'release'
  const outputDir = path.join(workspace, outputDirName)
  const extensions = ['.exe', '.dmg', '.AppImage']

  let bestFile = ''
  let bestMtime = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'win-unpacked' || entry.name === 'mac' || entry.name === 'linux-unpacked') continue
        await walk(full)
        continue
      }
      if (!extensions.some(extension => entry.name.toLowerCase().endsWith(extension))) continue
      const stats = await fs.stat(full).catch(() => null)
      if (!stats || stats.mtimeMs < startedAt - 1000) continue
      if (stats.mtimeMs > bestMtime) {
        bestFile = full
        bestMtime = stats.mtimeMs
      }
    }
  }

  await walk(outputDir)
  return bestFile.length > 0 ? bestFile : null
}

function setupTasksIPC(): void {
  const service = () => tasks()

  ipcMain.handle('tasks:list', (_event, token: unknown) =>
    service().list(resolveOptionalUserId(token)))

  ipcMain.handle('tasks:get', (_event, token: unknown, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Identifiant invalide')
    return service().get(resolveOptionalUserId(token), id)
  })

  ipcMain.handle('tasks:create', (_event, token: unknown, input: unknown) => {
    const record = (input ?? {}) as Record<string, unknown>
    const title = assertText(record.title, 'title').trim()
    if (title.length === 0) throw new Error('Le titre de la tâche ne peut pas être vide')
    return service().create(resolveOptionalUserId(token), {
      title,
      description: typeof record.description === 'string' ? record.description : null,
      priority: typeof record.priority === 'string' ? record.priority as never : undefined,
      status: typeof record.status === 'string' ? record.status as never : undefined,
      source: record.source === 'ai' ? 'ai' : 'user',
      projectId: typeof record.projectId === 'string' ? record.projectId : null,
      blockedReason: typeof record.blockedReason === 'string' ? record.blockedReason : null,
    })
  })

  ipcMain.handle('tasks:update', (_event, token: unknown, id: unknown, changes: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Identifiant invalide')
    const input = (changes ?? {}) as Record<string, unknown>
    const clean: Parameters<TaskService['update']>[2] = {}
    if (typeof input.title === 'string') clean.title = input.title
    if (typeof input.description === 'string' || input.description === null) clean.description = input.description as string | null
    if (typeof input.priority === 'string') clean.priority = input.priority as never
    if (typeof input.status === 'string') clean.status = input.status as never
    if (typeof input.projectId === 'string' || input.projectId === null) clean.projectId = input.projectId as string | null
    if (typeof input.blockedReason === 'string' || input.blockedReason === null) clean.blockedReason = input.blockedReason as string | null
    return service().update(resolveOptionalUserId(token), id, clean)
  })

  ipcMain.handle('tasks:complete', (_event, token: unknown, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Identifiant invalide')
    return service().complete(resolveOptionalUserId(token), id)
  })

  ipcMain.handle('tasks:reopen', (_event, token: unknown, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Identifiant invalide')
    return service().reopen(resolveOptionalUserId(token), id)
  })

  ipcMain.handle('tasks:remove', (_event, token: unknown, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) throw new Error('Identifiant invalide')
    return service().remove(resolveOptionalUserId(token), id)
  })

  // Annulation : restaure un instantané complet renvoyé par le renderer.
  ipcMain.handle('tasks:restore', (_event, token: unknown, snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Instantané invalide')
    const s = snapshot as Record<string, unknown>
    if (typeof s.id !== 'string' || typeof s.title !== 'string' || typeof s.status !== 'string') {
      throw new Error('Instantané de tâche invalide')
    }
    return service().restoreSnapshot(resolveOptionalUserId(token), s as never)
  })

  ipcMain.handle('tasks:clear-completed', (_event, token: unknown) =>
    service().clearCompleted(resolveOptionalUserId(token)))

  ipcMain.handle('tasks:activity-log', (_event, token: unknown, limit: unknown) =>
    service().activityLog(resolveOptionalUserId(token), typeof limit === 'number' ? limit : undefined))
}

function setupPackageIPC(): void {
  ipcMain.handle('package:start', async (_event, token: unknown, workspace: unknown) => {
    requireSession(token)

    if (packaging.running) throw new Error('Un packaging est déjà en cours.')
    const root = assertPath(workspace)
    const stats = await fs.stat(root).catch(() => null)
    if (!stats?.isDirectory()) throw new Error(`Workspace introuvable: ${root}`)

    let manifest: {
      name?: string
      version?: string
      productName?: string
      scripts?: Record<string, string>
      devDependencies?: Record<string, string>
      build?: { directories?: { output?: string } }
    }
    try {
      manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    } catch {
      throw new Error('Ce dossier ne contient pas de package.json lisible : rien à empaqueter.')
    }

    const scripts = manifest.scripts ?? {}
    const hasBuilder = Boolean(manifest.devDependencies?.['electron-builder'])
    if (!hasBuilder && !scripts.dist && !scripts.package) {
      throw new Error(
        'Aucun système d\'empaquetage détecté. Ajoutez electron-builder aux devDependencies '
        + 'ou un script "dist" dans le package.json du projet.',
      )
    }

    const buildCommand = typeof scripts.build === 'string' && scripts.build.length > 0 ? 'npm run build' : null
    const packageCommand = scripts.dist
      ? 'npm run dist'
      : scripts.package
        ? 'npm run package'
        : `npx electron-builder --${process.platform === 'darwin' ? 'mac' : process.platform === 'linux' ? 'linux' : 'win'} --x64 --publish never`

    packaging.running = true
    packaging.startedAt = Date.now()
    const startedAt = packaging.startedAt

    // Asynchronous on purpose: the renderer follows progress events.
    void (async () => {
      try {
        packagingStage('preparing')
        broadcast('package:progress', { stage: 'preparing', line: `Projet: ${manifest.name ?? path.basename(root)} v${manifest.version ?? '?'}` })

        if (buildCommand) {
          packagingStage('building')
          await runPackagingStep(buildCommand, root)
        }

        packagingStage('packaging')
        await runPackagingStep(packageCommand, root)

        packagingStage('creating-installer')
        const installer = await findInstaller(root, startedAt)
        if (!installer) {
          throw new Error('Aucun installeur trouvé après la construction. Vérifie les logs ci-dessus.')
        }

        broadcast('package:progress', { stage: 'done', line: installer })
        broadcast('package:complete', {
          installerPath: installer,
          version: manifest.version ?? null,
          productName: manifest.productName ?? manifest.name ?? path.basename(root),
        })
      } catch (error: unknown) {
        broadcast('package:error', { message: error instanceof Error ? error.message : String(error) })
      } finally {
        packaging.running = false
        packaging.stage = ''
      }
    })()

    return { started: true }
  })

  ipcMain.handle('package:cancel', () => {
    const child = packaging.child
    if (!child || typeof child.pid !== 'number') return false
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
    return true
  })

  /** Opens the installer itself; restricted to paths under the workspace output dir. */
  ipcMain.handle('package:open', async (_event, installerPath: unknown) => {
    const target = assertPath(installerPath)
    const errorMessage = await shell.openPath(target)
    if (errorMessage) throw new Error(errorMessage)
    return true
  })

  ipcMain.handle('package:show-in-folder', (_event, installerPath: unknown) => {
    shell.showItemInFolder(assertPath(installerPath))
    return true
  })
}

function setupSystemIPC(): void {
  ipcMain.handle('system:get-versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    devMode: !app.isPackaged,
  }))
  ipcMain.handle('diag:log', (_event, line: unknown) => {
    if (typeof line === 'string' && line.length < 2000) aiLog(`[renderer] ${line}`)
  })

  // ─── Export / Import des données utilisateur ─────────
  // Le composeur est le renderer ; le main ne fait qu'écrire/lire un fichier
  // JSON choisi par l'utilisateur. Aucun secret n'y transite (clés API et
  // jetons de session restent dans le KeyStore/localStorage du profil).
  ipcMain.handle('data:export', async (_event, payload: unknown) => {
    const json = assertText(payload, 'payload')
    const result = await dialog.showSaveDialog({
      title: 'Exporter les données My Creation',
      defaultPath: `my-creation-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await fs.writeFile(result.filePath, json, 'utf8')
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Importer des données My Creation',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return { loaded: false }
    const raw = await fs.readFile(result.filePaths[0], 'utf8')
    return { loaded: true, payload: raw }
  })
}

function setupIPC(): void {
  setupSystemIPC()
  setupWindowIPC()
  setupFileIPC()
  setupTerminalIPC()
  setupGitIPC()
  setupKeyIPC()
  setupChatIPC()
  setupAgentIPC()
  setupPreviewIPC()
  setupProjectIPC()
  setupAuthIPC()
  setupTasksIPC()
  setupPackageIPC()
}

// ─── Lifecycle ─────────────────────────────────────────
// ─── Callback d'authentification Supabase (deep link mycreation://) ────
/**
 * Le lien de confirmation e-mail s'ouvre dans le navigateur EXTERNE puis
 * revient vers l'application via le schéma « mycreation:// ». L'URL complète
 * (?code=… PKCE ou #error=…) est transmise au renderer qui l'échange contre
 * une session Supabase (traitement unique : voir src/lib/authCallback.ts).
 */
const AUTH_PROTOCOL = 'mycreation'

/** Dernière URL de callback reçue et pas encore consommée par le renderer. */
let pendingAuthCallbackUrl: string | null = null

/** Retourne la première URL de deep link d'auth trouvée dans une liste d'arguments. */
function findAuthCallbackUrl(entries: readonly string[]): string | null {
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.toLowerCase().startsWith(`${AUTH_PROTOCOL}://`)) {
      return entry
    }
  }
  return null
}

/** Mémorise l'URL puis la pousse au renderer si une fenêtre est prête. */
function deliverAuthCallbackUrl(url: string): void {
  pendingAuthCallbackUrl = url
  const win = mainWindow
  if (win && !win.isDestroyed()) win.webContents.send('auth:callback', url)
}

// Enregistrement du schéma : l'installateur NSIS le déclare aussi (build.protocols)
// ; cet appel couvre le mode développement et les lancements hors installeur.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL)
} else if (process.argv[1]) {
  app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
}

// Lancement à froid par le deep link (application fermée) : l'URL est dans argv.
pendingAuthCallbackUrl = findAuthCallbackUrl(process.argv)

function shutdown(): void {
  terminals?.killAll()
  void preview?.dispose()
  for (const controller of chatRequests.values()) controller.abort()
  chatRequests.clear()
  for (const controller of agentSessions.values()) controller.abort()
  agentSessions.clear()
  closeDatabase()
}

if (!app.requestSingleInstanceLock()) {
  // Une instance détient déjà le verrou. Quitter silencieusement ressemble à
  // un crash pour l'utilisateur (fenêtre jamais affichée) : on explique.
  // Exception : lancement déclenché par le deep link d'auth pendant que
  // l'application tourne — l'instance primaire reçoit déjà l'URL via
  // l'événement second-instance, aucun dialogue n'est nécessaire.
  console.info('[MY-CREATION-STARTUP] verrou single-instance refusé: une instance existe déjà')
  if (!findAuthCallbackUrl(process.argv)) {
    dialog.showErrorBox(
      'My Creation',
      'My Creation est déjà en cours d’exécution.\n\n'
      + 'Si aucune fenêtre n’est visible, une instance résiduelle bloque le '
      + 'démarrage : fermez « My Creation.exe » depuis le Gestionnaire des '
      + 'tâches, puis relancez l’application.',
    )
  }
  app.exit(0)
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Deep link reçu pendant que l'application tourne (clic sur le lien
    // e-mail) : transmis au renderer avant le simple focus.
    const callbackUrl = findAuthCallbackUrl(commandLine)
    if (callbackUrl) deliverAuthCallbackUrl(callbackUrl)
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  // macOS : les deep links arrivent via open-url plutôt qu'en argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (url && url.toLowerCase().startsWith(`${AUTH_PROTOCOL}://`)) deliverAuthCallbackUrl(url)
  })

  // ─── Crash diagnostics (temporary) ───────────────────
  step('app: requestSingleInstanceLock OK')
  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error(`[main] app render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  app.on('child-process-gone', (_event, details) => {
    console.error(`[main] app child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })
  process.on('exit', code => {
    console.info(`[main] process exit code=${code} (dernier STEP=${__stepCounter})`)
  })

  app.whenReady().then(async () => {
    console.info(`[main] development mode = ${isDev}`)
    step('whenReady résolu')

    // ─── [MY-CREATION-STARTUP] diagnostic de boot ────────
    console.info('[MY-CREATION-STARTUP] app ready')
    console.info(`[MY-CREATION-STARTUP] paths: userData=${app.getPath('userData')} resources=${process.resourcesPath} cwd=${process.cwd()}`)
    let safeStorageState = 'indisponible'
    try { safeStorageState = safeStorage.isEncryptionAvailable() ? 'disponible' : 'non chiffré (fallback plaintext)' } catch { /* ignore */ }
    console.info(`[MY-CREATION-STARTUP] safeStorage: ${safeStorageState}`)

    step('avant new KeyStore (userData + mkdir)')
    keyStore = new KeyStore()
    step('KeyStore OK')

    console.info('[MY-CREATION-STARTUP] admin provisioning…')
    step('import admin-keys.json (provision EXE)')
    await importAdminKeysFile()
    step('import admin-keys OK')
    console.info('[MY-CREATION-STARTUP] admin provisioning terminé')

    step('avant initDatabase (better-sqlite3 natif)')
    initDatabase()
    step('initDatabase OK')
    console.info('[MY-CREATION-STARTUP] database: OK (SQLite)')

    step('avant setupIPC')
    setupIPC()
    step('setupIPC OK')
    console.info('[MY-CREATION-STARTUP] providers + IPC: OK')

    // Mises à jour (GitHub Releases) : inerte en développement.
    setupUpdater(broadcast)
    step('setupUpdater OK')

    step('avant createWindow')
    createWindow()
    step('createWindow terminé')
    console.info('[MY-CREATION-STARTUP] window created')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  }).catch((error: unknown) => {
    console.error('[MY-CREATION-STARTUP] ÉCHEC DU DÉMARRAGE:', error instanceof Error ? error.stack : error)
    dialog.showErrorBox(
      'My Creation',
      'Le démarrage a échoué.\n\n'
      + `Détail technique : ${error instanceof Error ? error.message : String(error)}`,
    )
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    shutdown()
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', shutdown)
}
