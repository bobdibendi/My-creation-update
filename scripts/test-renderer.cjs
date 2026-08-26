/**
 * Renderer smoke test.
 *
 * Boots a real BrowserWindow with the production preload and the built bundle,
 * then asserts from inside the page that React mounted, the preload bridge is
 * complete, and every IPC channel answers. Run after `npm run build`.
 *
 * Usage: node scripts/test-renderer.cjs [--dev]
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist')
const electronDist = path.join(projectRoot, 'dist-electron')
const useDevServer = process.argv.includes('--dev')

// Profil isole : sinon les conversations persistees par une vraie session de
// l'app (meme nom d'app, meme dossier userData) remplissent `entries`, masquent
// l'ecran d'accueil et font echouer le check des suggestions.
app.setName('cursor-clone')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-clone-renderer-profile-')))
app.disableHardwareAcceleration()

// Destroying the test window would otherwise trigger Electron's default quit
// before the report is written.
app.on('window-all-closed', () => {})

const problems = []
const logs = []

function record(condition, message) {
  if (!condition) problems.push(message)
}

async function main() {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    problems.push('dist/index.html manquant. Lance "npm run build".')
    return
  }
  if (!fs.existsSync(path.join(electronDist, 'preload.js'))) {
    problems.push('dist-electron/preload.js manquant. Lance "npm run build".')
    return
  }

  // Minimal stand-ins for the handlers the renderer calls on mount.
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-renderer-'))
  await fsp.writeFile(path.join(workspace, 'exemple.txt'), 'contenu', 'utf8')

  ipcMain.handle('api:listProviders', () => ([
    {
      id: 'tools',
      name: 'Top Tools AI',
      configured: true,
      models: [{ id: 'Top-Tools-Ai', label: 'Top Tools AI', provider: 'tools', supportsTools: true }],
    },
  ]))
  ipcMain.handle('api:checkKey', (_event, provider) => ({
    success: true, provider: String(provider), configured: true, maskedKey: 'sk-abc...7890',
  }))
  ipcMain.handle('api:storeKey', (_event, provider) => ({
    success: true, provider: String(provider), configured: true, maskedKey: 'sk-abc...7890',
  }))
  ipcMain.handle('api:deleteKey', (_event, provider) => ({
    success: true, provider: String(provider), configured: false,
  }))
  ipcMain.handle('files:list', async (_event, target) => {
    const entries = await fsp.readdir(String(target), { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      path: path.join(String(target), entry.name),
      kind: entry.isDirectory() ? 'directory' : 'file',
    }))
  })
  ipcMain.handle('files:read', (_event, target) => fsp.readFile(String(target), 'utf8'))
  ipcMain.handle('files:list-recursive', () => [])
  ipcMain.handle('git:status', () => '## main\n')
  ipcMain.handle('window:isMaximized', () => false)

  // Session + licence valides : l'application n'affiche le shell qu'apres la
  // chaine splash -> auth (Supabase) -> licence. Sans ces stubs, l'ecran de
  // connexion remplace AppShell et tous les checks UI echouent.
  const fakeUser = { id: 1, email: 'test@example.com', name: 'Test', createdAt: Date.now() }
  ipcMain.handle('auth:get-session', () => ({ user: fakeUser, expiresAt: Date.now() + 86400000 }))
  ipcMain.handle('auth:ensure-supabase', () => ({ success: true, user: fakeUser, sessionToken: 'renderer-test-token' }))
  ipcMain.handle('license:get-status', () => ({ active: true, type: 'lifetime', expiresAt: null }))
  ipcMain.handle('license:get-licenses', () => [])
  ipcMain.handle('subscription:usage', () => ({
    plan: { id: 'free', name: 'FREE', dailyTokenLimit: 10000000, features: [], price: 'Gratuit', description: '' },
    period: { start: 0, end: 86400000, key: 'test' },
    inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0,
    byKind: {
      chat: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      agent: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      other: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    },
    dailyTokenLimit: 10000000, remainingTokens: 10000000, percentUsed: 0, nextResetAt: 86400000,
  }))

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(electronDist, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.on('console-message', (_event, level, message) => {
    logs.push('[console:' + level + '] ' + message)
  })
  window.webContents.on('did-fail-load', (_event, code, description) => {
    problems.push('chargement du renderer echoue: ' + code + ' ' + description)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    problems.push('processus renderer arrete: ' + details.reason)
  })

  try {
    if (useDevServer) await window.loadURL('http://127.0.0.1:5173')
    else await window.loadFile(path.join(distDir, 'index.html'))
  } catch (error) {
    problems.push('impossible de charger le renderer: ' + error.message)
    return
  }

  // Amorce une session Supabase (format storage supabase-js) puis recharge :
  // le shell n'apparait que lorsque useAuth restore cette session et l'a
  // pontee vers le compte local via auth:ensure-supabase.
  try {
    const env = fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8')
    const refMatch = env.match(/VITE_SUPABASE_URL\s*=\s*https:\/\/([^.]+)\./)
    if (!refMatch) throw new Error('VITE_SUPABASE_URL introuvable dans .env.local')
    const nowSec = Math.floor(Date.now() / 1000)
    const session = {
      access_token: 'renderer-test-access',
      refresh_token: 'renderer-test-refresh',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: nowSec + 3600,
      user: {
        id: 'renderer-test-0000-0000-0000-000000000001',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'test@example.com',
        email_confirmed_at: new Date().toISOString(),
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { name: 'Test' },
        identities: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }
    await window.webContents.executeJavaScript(
      `localStorage.setItem('sb-${refMatch[1]}-auth-token', ${JSON.stringify(JSON.stringify(session))});`
      + `localStorage.setItem('cursor-clone:session-token', 'renderer-test-token')`,
      true,
    )
    await window.reload()
  } catch (error) {
    problems.push('amorçage de session impossible: ' + error.message)
    return
  }

  // Give React a moment to mount and run its effects.
  await new Promise(resolve => setTimeout(resolve, 2500))

  const script = `(async () => {
    const out = { errors: [] }
    const bridge = window.electronAPI
    out.bridgePresent = Boolean(bridge)

    const expected = {
      window: ['minimize', 'maximize', 'close', 'isMaximized', 'openDevTools', 'onMaximized'],
      git: ['status', 'branches', 'run'],
      files: ['openFolder', 'read', 'write', 'list', 'listRecursive', 'create', 'delete', 'rename', 'exists'],
      terminal: ['create', 'write', 'resize', 'kill', 'onData', 'onExit'],
      api: ['storeKey', 'checkKey', 'deleteKey', 'listProviders'],
      ai: ['chat', 'cancel', 'onChunk'],
      agent: ['start', 'cancel', 'onEvent'],
    }
    out.missing = []
    if (bridge) {
      for (const group of Object.keys(expected)) {
        const section = bridge[group]
        if (!section) { out.missing.push(group); continue }
        for (const method of expected[group]) {
          if (typeof section[method] !== 'function') out.missing.push(group + '.' + method)
        }
      }
    }

    const root = document.getElementById('root')
    out.rootChildren = root ? root.children.length : 0
    out.hasShell = Boolean(document.querySelector('.app-shell'))
    out.hasTitlebar = Boolean(document.querySelector('.titlebar'))
    out.hasActivityBar = Boolean(document.querySelector('.activitybar'))
    out.hasStatusbar = Boolean(document.querySelector('.statusbar'))
    out.hasExplorer = Boolean(document.querySelector('.sidebar'))
    out.hasWelcome = Boolean(document.querySelector('.welcome'))
    out.statusText = (document.querySelector('.status-indicator') || {}).textContent || ''
    out.bodyBackground = getComputedStyle(document.body).backgroundColor

    try { out.providers = await bridge.api.listProviders() }
    catch (error) { out.errors.push('listProviders: ' + error.message) }

    try { out.keyStatus = await bridge.api.checkKey('tools') }
    catch (error) { out.errors.push('checkKey: ' + error.message) }

    try { out.maximized = await bridge.window.isMaximized() }
    catch (error) { out.errors.push('isMaximized: ' + error.message) }

    try { out.listing = await bridge.files.list(WORKSPACE_PATH) }
    catch (error) { out.errors.push('files.list: ' + error.message) }

    try {
      const off = bridge.agent.onEvent(function () {})
      out.listenerOk = typeof off === 'function'
      off()
    } catch (error) { out.errors.push('agent.onEvent: ' + error.message) }

    const buttons = Array.prototype.slice.call(document.querySelectorAll('.activitybar button'))
    const agentButton = buttons.filter(function (button) {
      return (button.getAttribute('title') || '').indexOf('Assistant') >= 0
    })[0]
    if (agentButton) {
      agentButton.click()
      await new Promise(function (resolve) { setTimeout(resolve, 600) })
      out.agentPanelOpen = Boolean(document.querySelector('.agent-panel'))
      out.agentComposer = Boolean(document.querySelector('.agent-composer textarea'))
      out.agentModel = (document.querySelector('.model-select-label') || {}).textContent || ''
      out.agentSuggestions = document.querySelectorAll('.agent-suggestions button').length
    } else {
      out.errors.push('bouton Assistant introuvable')
    }

    // Regression React #310 : la page Historique montait un nombre variable
    // de hooks selon le contenu. On navigue vers chaque vue centrale et on
    // verifie qu'elles restent montees sans erreur.
    async function openNavView(title, selector) {
      const btn = Array.prototype.slice.call(document.querySelectorAll('button'))
        .find(function (b) { return (b.getAttribute('title') || '') === title })
      if (!btn) { out.errors.push('navigation ' + title + ' introuvable'); return }
      btn.click()
      // Les transitions de vue sont animees : on attend l'apparition reellement.
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        if (document.querySelector(selector)) return
        await new Promise(function (resolve) { setTimeout(resolve, 200) })
      }
      if (!document.querySelector(selector)) {
        out.errors.push('vue ' + title + ' non montee (' + selector + ' absent)')
      }
    }
    await openNavView('Historique', '.history-page')
    await openNavView('Todo', '.todo-page')
    await openNavView('Accueil', '.welcome')

    return out
  })()`.replace('WORKSPACE_PATH', JSON.stringify(workspace))

  const report = await window.webContents.executeJavaScript(script)

  record(report.bridgePresent, 'window.electronAPI absent: le preload ne s\'est pas charge')
  record(report.missing.length === 0, 'API du preload incomplete: ' + report.missing.join(', '))
  record(report.rootChildren > 0, 'React n\'a rien monte dans #root')
  record(report.hasShell, '.app-shell absent')
  record(report.hasTitlebar, '.titlebar absent')
  record(report.hasActivityBar, '.activitybar absent')
  record(report.hasStatusbar, '.statusbar absent')
  record(report.hasExplorer, 'panneau explorateur absent')
  record(report.hasWelcome, 'page d\'accueil absente')
  record(String(report.statusText).indexOf('Electron') >= 0, 'indicateur Electron inattendu: ' + report.statusText)
  record(report.bodyBackground !== 'rgba(0, 0, 0, 0)', 'la feuille de style n\'est pas appliquee')
  record(Array.isArray(report.providers) && report.providers.length > 0, 'listProviders ne renvoie rien')
  record(report.keyStatus && report.keyStatus.configured === true, 'checkKey ne renvoie pas un etat exploitable')
  record(report.maximized === false, 'window.isMaximized ne repond pas')
  record(Array.isArray(report.listing) && report.listing.length > 0, 'files.list ne renvoie rien')
  record(report.listenerOk === true, 'agent.onEvent ne renvoie pas de fonction de desinscription')
  record(report.agentPanelOpen === true, 'le panneau Assistant ne s\'ouvre pas')
  record(report.agentComposer === true, 'le composeur de l\'assistant est absent')
  record(String(report.agentModel).trim().length > 0, 'aucun modele affiche dans l\'assistant')
  record(report.agentSuggestions > 0, 'aucune suggestion affichee dans l\'assistant')
  for (const error of report.errors || []) problems.push('renderer: ' + error)

  const fatalLogs = logs.filter(entry => /\[console:3\]/.test(entry) && !/DevTools|Autofill/i.test(entry))
  record(fatalLogs.length === 0, 'erreurs console: ' + fatalLogs.slice(0, 3).join(' | '))

  window.destroy()
  await fsp.rm(workspace, { recursive: true, force: true })
}

app.whenReady()
  .then(main)
  .catch(error => {
    problems.push(error && error.stack ? error.stack : String(error))
  })
  .then(() => {
    if (problems.length === 0) {
      report('PASS  Renderer (Electron + React + Vite + preload + IPC)')
      app.exit(0)
      return
    }
    report('FAIL  Renderer: ' + problems.length + ' probleme(s)')
    for (const problem of problems) report('      ' + problem)
    for (const entry of logs.slice(0, 10)) report('      ' + entry)
    app.exit(1)
  })
