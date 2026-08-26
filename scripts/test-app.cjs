/**
 * Full-application integration test.
 *
 * Loads the real compiled main process (dist-electron/main.js), which creates
 * the real window with the real preload and the built renderer, then drives the
 * app through the actual IPC handlers: filesystem CRUD, terminal, git, key
 * store and provider listing. Nothing is stubbed.
 *
 * Usage: node scripts/test.cjs app
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { app, BrowserWindow } = require('electron')
const { report } = require('./lib/reporter.cjs')

const execFileAsync = promisify(execFile)

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'dist-electron', 'main.js')

if (!fs.existsSync(mainEntry)) {
  report('FATAL dist-electron/main.js absent. Lance "npm run build".')
  process.exit(1)
}
if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  report('FATAL dist/index.html absent. Lance "npm run build".')
  process.exit(1)
}

const problems = []
const consoleLogs = []

function check(condition, message) {
  if (!condition) problems.push(message)
}

// Loading main.js registers every ipcMain handler and creates the window.
require(mainEntry)

function waitForWindow(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        resolve(windows[0])
        return
      }
      if (Date.now() > deadline) {
        reject(new Error('aucune fenetre creee par le processus principal'))
        return
      }
      setTimeout(poll, 100)
    }
    poll()
  })
}

function waitForLoad(win, timeoutMs) {
  if (!win.webContents.isLoading()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('le renderer n\'a pas fini de charger')), timeoutMs)
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer)
      resolve()
    })
    win.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer)
      reject(new Error(`chargement echoue: ${code} ${description}`))
    })
  })
}

async function main() {
  const win = await waitForWindow(20000)
  win.webContents.on('console-message', (_event, level, message) => {
    consoleLogs.push(`[${level}] ${message}`)
  })
  await waitForLoad(win, 30000)

  // ── Franchir les portes auth + licence avec les VRAIS handlers IPC ──
  // L'application n'affiche AppShell qu'apres une session valide et une
  // licence active ; ce test pilote donc le vrai flux d'activation.
  let privateKeyPath
  try {
    privateKeyPath = require('./keys.cjs').privateKeyPath()
  } catch (error) {
    report(`FATAL ${error.message}`)
    process.exit(1)
  }
  const jwt = require('jsonwebtoken')
  const licenseToken = jwt.sign(
    {
      iss: 'cursor-clone',
      sub: 'test@example.com',
      licenseId: `lic_${Date.now().toString(36)}`,
      type: 'lifetime',
      product: 'cursor-clone',
    },
    fs.readFileSync(privateKeyPath, 'utf8'),
    { algorithm: 'RS256' },
  )

  const supabaseId = 'app-test-' + Date.now() + '-0001'
  const bootEmail = 'app-test-' + Date.now() + '@example.com'
  const boot = await win.webContents.executeJavaScript(`
    (async () => {
      const bridge = window.electronAPI
      if (!bridge) return { error: 'bridge absent' }
      // Flux réel : l'identité Supabase est pontée vers le compte local SQLite.
      const bridged = await bridge.auth.ensureSupabase({
        supabaseId: ${JSON.stringify(supabaseId)},
        email: ${JSON.stringify(bootEmail)},
        name: 'Test',
      })
      if (!bridged.success || !bridged.sessionToken) {
        return { error: 'ensureSupabase: ' + (bridged.error || '?') }
      }
      const activated = await bridge.license.activate(bridged.sessionToken, ${JSON.stringify(licenseToken)})
      return {
        sessionToken: bridged.sessionToken,
        activated: activated.success === true,
        activateError: activated.error ?? null,
      }
    })()
  `, true)
  check(!boot.error, `boot auth/licence: ${boot.error ?? 'ok'}`)
  check(
    boot.activated === true,
    'activation de licence: ' + (boot.activateError ?? 'echec'),
  )
  if (!boot.sessionToken) {
    report('FATAL session non obtenue, suite du test impossible.')
    process.exit(1)
  }

  // Amorce la session Supabase (format storage supabase-js) que useAuth
  // restaure au démarrage, puis le jeton local ponté correspondant.
  const envContent = fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8')
  const refMatch = envContent.match(/VITE_SUPABASE_URL\s*=\s*https:\/\/([^.]+)\./)
  if (!refMatch) {
    report('FATAL VITE_SUPABASE_URL introuvable dans .env.local.')
    process.exit(1)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const fakeSupabaseSession = {
    access_token: 'app-test-access',
    refresh_token: 'app-test-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSec + 3600,
    user: {
      id: supabaseId,
      aud: 'authenticated',
      role: 'authenticated',
      email: bootEmail,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { name: 'Test' },
      identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  }
  await win.webContents.executeJavaScript(
    `localStorage.setItem('sb-${refMatch[1]}-auth-token', ${JSON.stringify(JSON.stringify(fakeSupabaseSession))});`
    + `localStorage.setItem('cursor-clone:session-token', ${JSON.stringify(boot.sessionToken)})`,
    true,
  )
  await win.reload()
  await waitForLoad(win, 30000)
  // Let React mount and run its effects.
  await new Promise(resolve => setTimeout(resolve, 2500))

  // The key round-trip below writes to the real key store, so snapshot it and
  // restore it afterwards. The user's existing keys must be untouched.
  const keyFile = path.join(app.getPath('userData'), 'config', '.api-keys.enc')
  const keyBackup = fs.existsSync(keyFile) ? fs.readFileSync(keyFile) : null

  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-app-'))
  await fsp.writeFile(path.join(workspace, 'lisez-moi.md'), '# Titre\n\ncontenu\n', 'utf8')
  await fsp.mkdir(path.join(workspace, 'sous-dossier'), { recursive: true })
  await fsp.writeFile(path.join(workspace, 'sous-dossier', 'imbrique.txt'), 'imbrique', 'utf8')
  await fsp.mkdir(path.join(workspace, 'node_modules'), { recursive: true })
  await fsp.writeFile(path.join(workspace, 'node_modules', 'ignore.js'), 'x', 'utf8')
  // Non-ASCII content proves the terminal decodes UTF-8 rather than the OEM page.
  await fsp.writeFile(path.join(workspace, 'accents.txt'), 'éàç café\n', 'utf8')

  // A static site so the preview, capture, analysis and graph handlers can be
  // exercised end to end: index.html is enough to be served by the built-in
  // static server, with no dependency install.
  await fsp.mkdir(path.join(workspace, 'site'), { recursive: true })
  await fsp.writeFile(
    path.join(workspace, 'site', 'index.html'),
    '<!doctype html><html lang="fr"><head><meta charset="utf-8">'
    + '<title>Sushis</title><link rel="stylesheet" href="styles.css"></head>'
    + '<body><h1>Sushis</h1><p>Aperçu de test.</p><script src="script.js"></script></body></html>\n',
    'utf8',
  )
  await fsp.writeFile(path.join(workspace, 'site', 'styles.css'), 'body { background: #101014; color: #fff }\n', 'utf8')
  await fsp.writeFile(path.join(workspace, 'site', 'script.js'), 'document.title = "Sushis"\n', 'utf8')

  // A real repository so the git handlers can be checked against tracked
  // content, plus a subdirectory to verify the status stays scoped.
  const repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-git-'))
  await fsp.writeFile(path.join(repoDir, 'racine.txt'), 'fichier a la racine\n', 'utf8')
  await fsp.mkdir(path.join(repoDir, 'paquet'), { recursive: true })
  await fsp.writeFile(path.join(repoDir, 'paquet', 'interne.txt'), 'fichier interne\n', 'utf8')
  const git = args => execFileAsync('git', args, { cwd: repoDir, timeout: 20000 })
  await git(['init', '-b', 'principale'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'user.name', 'Test'])

  // The temp directory may itself sit inside a repository (a developer machine
  // with a repository in the home directory), so detect it instead of assuming.
  const outsideIsTrulyOutside = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, timeout: 20000 })
    .then(() => false, () => true)

  const script = `(async () => {
    const out = { errors: [], steps: {} }
    const bridge = window.electronAPI
    out.bridgePresent = Boolean(bridge)
    if (!bridge) return out

    const W = WORKSPACE
    const join = (name) => W + '\\\\' + name
    const step = async (name, run) => {
      try { out.steps[name] = await run() }
      catch (error) { out.errors.push(name + ': ' + error.message) }
    }

    // ── Renderer state ──
    out.reactMounted = document.querySelectorAll('.app-shell').length === 1
    out.hasStatusbar = Boolean(document.querySelector('.statusbar'))

    // ── Providers and keys ──
    await step('listProviders', async () => {
      const list = await bridge.api.listProviders()
      return {
        count: list.length,
        ids: list.map(provider => provider.id),
        toolModels: list.reduce((total, provider) =>
          total + provider.models.filter(model => model.supportsTools).length, 0),
        configured: list.filter(provider => provider.configured).map(provider => provider.id),
      }
    })
    await step('checkKeyUnknown', async () => bridge.api.checkKey('inexistant'))
    await step('storeKeyRejectsShort', async () => bridge.api.storeKey('anthropic', 'abc'))
    await step('storeKeyRejectsUnknownProvider', async () => bridge.api.storeKey('inconnu', 'clef-valide-1234567890'))

    // Full key round-trip. Safe because this test runs with Electron's default
    // userData directory, not the one used by the packaged application.
    await step('keyRoundTrip', async () => {
      const secret = 'sk-test-' + '1234567890abcdef'
      const stored = await bridge.api.storeKey('openai', secret)
      const checked = await bridge.api.checkKey('openai')
      const listed = await bridge.api.listProviders()
      const removed = await bridge.api.deleteKey('openai')
      const afterRemoval = await bridge.api.checkKey('openai')
      return {
        stored: stored.success && stored.configured,
        mask: stored.maskedKey,
        maskHidesSecret: typeof stored.maskedKey === 'string' && stored.maskedKey.indexOf('abcdef') < 0,
        checked: checked.configured,
        providerFlagged: listed.some(provider => provider.id === 'openai' && provider.configured),
        removed: removed.success && removed.configured === false,
        afterRemoval: afterRemoval.configured,
        leaked: JSON.stringify({ stored, checked, listed }).indexOf(secret) >= 0,
      }
    })

    // ── Filesystem ──
    await step('list', async () => {
      const entries = await bridge.files.list(W)
      return {
        names: entries.map(entry => entry.name),
        kinds: entries.map(entry => entry.kind),
      }
    })
    await step('listRecursive', async () => {
      const entries = await bridge.files.listRecursive(W)
      return {
        paths: entries.map(entry => entry.name),
        includesNested: entries.some(entry => entry.name === 'imbrique.txt'),
        skipsNodeModules: !entries.some(entry => entry.name === 'ignore.js'),
      }
    })
    await step('read', async () => (await bridge.files.read(join('lisez-moi.md'))).slice(0, 20))
    await step('createFile', async () => bridge.files.create(W, 'nouveau.txt', false))
    await step('write', async () => {
      await bridge.files.write(join('nouveau.txt'), 'ecrit depuis le renderer')
      return bridge.files.read(join('nouveau.txt'))
    })
    await step('createDir', async () => bridge.files.create(W, 'dossier-test', true))
    await step('rename', async () => bridge.files.rename(join('nouveau.txt'), 'renomme.txt'))
    await step('exists', async () => ({
      renamed: await bridge.files.exists(join('renomme.txt')),
      original: await bridge.files.exists(join('nouveau.txt')),
    }))
    await step('delete', async () => {
      await bridge.files.delete(join('renomme.txt'))
      return bridge.files.exists(join('renomme.txt'))
    })
    await step('rejectsBadName', async () => {
      try {
        await bridge.files.create(W, '../evasion.txt', false)
        return 'accepte'
      } catch (error) {
        return 'refuse: ' + error.message.slice(-60)
      }
    })

    // ── Terminal ──
    await step('terminal', async () => {
      const chunks = []
      const off = bridge.terminal.onData(payload => { chunks.push(payload) })
      const id = await bridge.terminal.create(W)
      await new Promise(resolve => setTimeout(resolve, 900))
      await bridge.terminal.write(id, 'echo marqueur-terminal\\r\\n')
      await new Promise(resolve => setTimeout(resolve, 1500))
      await bridge.terminal.write(id, 'type accents.txt\\r\\n')
      await new Promise(resolve => setTimeout(resolve, 1500))
      const text = chunks.filter(chunk => chunk.id === id).map(chunk => chunk.data).join('')
      await bridge.terminal.resize(id, 80, 24)
      await bridge.terminal.kill(id)
      off()
      return {
        id: Boolean(id),
        sawEcho: text.indexOf('marqueur-terminal') >= 0,
        sawAccents: text.indexOf('\\u00e9\\u00e0\\u00e7 caf\\u00e9') >= 0,
        length: text.length,
      }
    })

    // ── Git ──
    await step('git', async () => {
      const R = REPOSITORY
      const info = await bridge.git.root(R)
      const status = await bridge.git.status(R)
      const branches = await bridge.git.branches(R)
      const output = await bridge.git.run(R, ['status', '--short'])
      return {
        rootResolved: Boolean(info) && info.isRoot === true,
        branch: (status.split(/\\r?\\n/)[0] || ''),
        seesRootFile: /racine\\.txt/.test(status),
        branchesIsArray: Array.isArray(branches),
        runWorks: typeof output === 'string',
      }
    })

    // A subdirectory of a repository must report the owning root and keep the
    // status scoped to the opened folder rather than the whole repository.
    await step('gitSubdirectory', async () => {
      const S = SUBDIRECTORY
      const info = await bridge.git.root(S)
      const status = await bridge.git.status(S)
      return {
        rootMatches: Boolean(info) && info.root === REPOSITORY,
        isRoot: info ? info.isRoot : null,
        seesInternal: /interne\\.txt/.test(status),
        seesRootFile: /racine\\.txt/.test(status),
      }
    })

    // A folder that belongs to no repository at all. Skipped when the temp
    // directory itself sits inside a repository.
    await step('gitOutsideRepo', async () => {
      if (!OUTSIDE_AVAILABLE) return { skipped: true }
      return {
        skipped: false,
        root: await bridge.git.root(NO_REPO),
        status: await bridge.git.status(NO_REPO),
        run: await bridge.git.run(NO_REPO, ['status']).then(() => 'accepte', () => 'refuse'),
      }
    })

    // ── Chat and agent guards ──
    await step('chatRejectsUnknownModel', async () => {
      const events = []
      const off = bridge.ai.onChunk(event => events.push(event))
      const { requestId } = await bridge.ai.chat({ messages: [{ role: 'user', content: 'test' }], model: 'modele-inexistant' })
      await new Promise(resolve => setTimeout(resolve, 1200))
      off()
      const error = events.find(event => event.type === 'error' && event.requestId === requestId)
      return error ? error.message : 'aucune erreur emise'
    })
    await step('agentRejectsMissingWorkspace', async () => {
      const events = []
      const off = bridge.agent.onEvent(event => events.push(event))
      const { sessionId } = await bridge.agent.start({ prompt: 'test', model: 'Top-Tools-Ai', workspace: '' })
      await new Promise(resolve => setTimeout(resolve, 1200))
      off()
      const error = events.find(event => event.type === 'error' && event.sessionId === sessionId)
      return error ? error.message : 'aucune erreur emise'
    })
    await step('agentRejectsUnknownModel', async () => {
      const events = []
      const off = bridge.agent.onEvent(event => events.push(event))
      const { sessionId } = await bridge.agent.start({ prompt: 'test', model: 'modele-inexistant', workspace: W })
      await new Promise(resolve => setTimeout(resolve, 1200))
      off()
      const error = events.find(event => event.type === 'error' && event.sessionId === sessionId)
      return error ? error.message : 'aucune erreur emise'
    })
    await step('cancelIsSafe', async () => {
      await bridge.ai.cancel()
      await bridge.agent.cancel('session-inexistante')
      return 'ok'
    })

    // ── Preview, capture, analysis and graph ──
    await step('previewDetect', async () => {
      const candidates = await bridge.preview.candidates(W)
      const target = await bridge.preview.detect(W, 'site')
      return {
        candidateCount: candidates.length,
        sawSite: candidates.some(entry => entry.relativeRoot === 'site'),
        kind: target.kind,
        servedBy: target.servedBy,
        previewable: target.previewable,
        entryFile: target.entryFile,
      }
    })

    // The static site needs no install, so the whole lifecycle is fast and
    // deterministic: start, serve, auto-capture, stop.
    await step('previewLifecycle', async () => {
      const events = []
      const off = bridge.preview.onEvent(event => events.push(event))
      const started = await bridge.preview.start(W, 'site', false)
      // Give the automatic capture time to render and write the PNG.
      await new Promise(resolve => setTimeout(resolve, 4000))
      const status = await bridge.preview.status()
      const latest = await bridge.preview.latestCapture(W)
      const stopped = await bridge.preview.stop()
      off()
      return {
        state: started.state,
        url: started.url,
        loopback: typeof started.url === 'string' && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(started.url),
        runningStatus: status.state,
        sawStatusEvent: events.some(event => event.type === 'status'),
        sawScreenshotEvent: events.some(event => event.type === 'screenshot'),
        capturePath: latest ? latest.relativePath : null,
        captureIsPng: Boolean(latest) && latest.dataUrl.startsWith('data:image/png;base64,'),
        captureBytes: latest ? latest.bytes : 0,
        stoppedState: stopped.state,
        message: started.message,
      }
    })

    // start() reports failures as an error status rather than rejecting, so the
    // refusal is read from the returned state.
    await step('previewRejectsOutside', async () => {
      const status = await bridge.preview.start(W, '../evasion', false)
      return { state: status.state, message: status.message, url: status.url }
    })

    await step('openExternalRejectsRemote', async () => {
      try {
        await bridge.preview.openExternal('https://example.com')
        return 'accepte'
      } catch (error) {
        return 'refuse: ' + error.message.slice(-60)
      }
    })

    await step('projectAnalyze', async () => {
      const analysis = await bridge.project.analyze(W)
      return {
        name: analysis.name,
        typeLabel: analysis.typeLabel,
        files: analysis.stats.files,
        lines: analysis.stats.lines,
        state: analysis.state,
        hasIssuesArray: Array.isArray(analysis.issues),
        hasScriptsArray: Array.isArray(analysis.scripts),
        hasDependenciesArray: Array.isArray(analysis.dependencies),
        languages: analysis.languages.map(entry => entry.language),
      }
    })

    await step('projectGraph', async () => {
      const graph = await bridge.project.graph(W, '', 4)
      return {
        rootKind: graph.root.kind,
        nodeCount: graph.nodeCount,
        asciiHasSite: graph.ascii.indexOf('site') >= 0,
        asciiHasConnectors: /[├└]── /.test(graph.ascii),
        childLabels: graph.root.children.map(child => child.label),
      }
    })

    // ── Window controls ──
    await step('windowControls', async () => {
      const before = await bridge.window.isMaximized()
      await bridge.window.maximize()
      await new Promise(resolve => setTimeout(resolve, 400))
      const during = await bridge.window.isMaximized()
      await bridge.window.maximize()
      await new Promise(resolve => setTimeout(resolve, 400))
      const after = await bridge.window.isMaximized()
      return { before, during, after }
    })

    return out
  })()`
    .replace('WORKSPACE', JSON.stringify(workspace))
    .replace(/REPOSITORY/g, JSON.stringify(repoDir))
    .replace('SUBDIRECTORY', JSON.stringify(path.join(repoDir, 'paquet')))
    .replace(/NO_REPO/g, JSON.stringify(workspace))
    .replace(/OUTSIDE_AVAILABLE/g, String(outsideIsTrulyOutside))

  const result = await win.webContents.executeJavaScript(script)
  const steps = result.steps || {}

  check(result.bridgePresent, 'window.electronAPI absent: le preload n\'a pas ete charge')
  check(result.reactMounted, 'React n\'a pas monte .app-shell')
  check(result.hasStatusbar, 'barre de statut absente')

  check(steps.listProviders && steps.listProviders.count === 5,
    `listProviders devrait exposer 5 fournisseurs (recu ${steps.listProviders && steps.listProviders.count})`)
  check(steps.listProviders && steps.listProviders.toolModels > 0, 'aucun modele compatible outils expose')
  check(steps.checkKeyUnknown && steps.checkKeyUnknown.configured === false,
    'checkKey devrait signaler un fournisseur non configure')
  check(steps.storeKeyRejectsShort && steps.storeKeyRejectsShort.success === false,
    'storeKey devrait refuser une cle trop courte')
  check(steps.storeKeyRejectsUnknownProvider && steps.storeKeyRejectsUnknownProvider.success === false,
    'storeKey devrait refuser un fournisseur inconnu')

  const round = steps.keyRoundTrip
  check(round && round.stored === true, 'storeKey n\'a pas enregistre la cle de test')
  check(round && round.checked === true, 'checkKey ne voit pas la cle enregistree')
  check(round && round.providerFlagged === true, 'listProviders ne marque pas le fournisseur comme configure')
  check(round && round.maskHidesSecret === true, 'la cle masquee expose des caracteres sensibles')
  check(round && round.leaked === false, 'la cle en clair a fuite vers le renderer')
  check(round && round.removed === true, 'deleteKey n\'a pas supprime la cle')
  check(round && round.afterRemoval === false, 'la cle est encore presente apres suppression')

  check(steps.list && steps.list.names.includes('lisez-moi.md'), 'files.list ne renvoie pas lisez-moi.md')
  check(steps.list && steps.list.names.includes('sous-dossier'), 'files.list ne renvoie pas sous-dossier')
  check(steps.listRecursive && steps.listRecursive.includesNested, 'files.listRecursive ne descend pas dans les sous-dossiers')
  check(steps.listRecursive && steps.listRecursive.skipsNodeModules, 'files.listRecursive ne filtre pas node_modules')
  check(typeof steps.read === 'string' && steps.read.startsWith('# Titre'), 'files.read renvoie un contenu inattendu')
  check(steps.createFile && steps.createFile.kind === 'file', 'files.create n\'a pas cree de fichier')
  check(steps.write === 'ecrit depuis le renderer', 'files.write puis read ne restitue pas le contenu')
  check(steps.createDir && steps.createDir.kind === 'directory', 'files.create n\'a pas cree de dossier')
  check(steps.rename && steps.rename.name === 'renomme.txt', 'files.rename a echoue')
  check(steps.exists && steps.exists.renamed === true && steps.exists.original === false,
    'files.exists ne reflete pas le renommage')
  check(steps.delete === false, 'files.delete n\'a pas supprime le fichier')
  check(typeof steps.rejectsBadName === 'string' && steps.rejectsBadName.startsWith('refuse'),
    'files.create accepte un nom avec separateur de chemin')

  check(steps.terminal && steps.terminal.id === true, 'terminal.create n\'a pas renvoye d\'identifiant')
  check(steps.terminal && steps.terminal.sawEcho === true,
    `le terminal n'a pas renvoye la sortie de la commande (${steps.terminal && steps.terminal.length} octets recus)`)
  check(steps.terminal && steps.terminal.sawAccents === true,
    'le terminal ne decode pas correctement l\'UTF-8')

  check(steps.git && steps.git.rootResolved === true, 'git.root ne resout pas la racine du depot')
  check(steps.git && /principale/.test(steps.git.branch), `la branche n'est pas rapportee (${steps.git && steps.git.branch})`)
  check(steps.git && steps.git.seesRootFile === true, 'git.status ne voit pas le fichier a la racine')
  check(steps.git && steps.git.branchesIsArray === true, 'git.branches ne renvoie pas de tableau')
  check(steps.git && steps.git.runWorks === true, 'git.run ne renvoie pas de sortie')

  const sub = steps.gitSubdirectory
  check(sub && sub.rootMatches === true, 'git.root ne remonte pas au depot parent depuis un sous-dossier')
  check(sub && sub.isRoot === false, 'git.root devrait indiquer isRoot=false pour un sous-dossier')
  check(sub && sub.seesInternal === true, 'le statut d\'un sous-dossier ne voit pas ses propres fichiers')
  check(sub && sub.seesRootFile === false, 'le statut d\'un sous-dossier expose des fichiers hors de sa portee')

  const outside = steps.gitOutsideRepo
  if (outside && outside.skipped !== true) {
    check(outside.root === null, 'git.root devrait etre null hors depot')
    check(outside.status === '', 'git.status expose un depot ancetre')
    check(outside.run === 'refuse', 'git.run devrait refuser un dossier hors depot')
  }

  check(typeof steps.chatRejectsUnknownModel === 'string' && /Mod[eè]le inconnu/i.test(steps.chatRejectsUnknownModel),
    `ai.chat devrait rejeter un modele inconnu (recu: ${steps.chatRejectsUnknownModel})`)
  check(typeof steps.agentRejectsMissingWorkspace === 'string' && /dossier de travail/i.test(steps.agentRejectsMissingWorkspace),
    `agent.start devrait exiger un workspace (recu: ${steps.agentRejectsMissingWorkspace})`)
  check(typeof steps.agentRejectsUnknownModel === 'string' && /Mod[eè]le inconnu/i.test(steps.agentRejectsUnknownModel),
    `agent.start devrait rejeter un modele inconnu (recu: ${steps.agentRejectsUnknownModel})`)
  check(steps.cancelIsSafe === 'ok', 'annuler une session inexistante provoque une erreur')

  check(steps.windowControls && steps.windowControls.during === true && steps.windowControls.after === false,
    'les controles de fenetre ne fonctionnent pas')

  const detect = steps.previewDetect
  check(detect && detect.sawSite === true, 'preview.candidates ne detecte pas le dossier site')
  check(detect && detect.kind === 'html', `le site statique devrait etre de type html (recu ${detect && detect.kind})`)
  check(detect && detect.servedBy === 'static', 'le site statique devrait etre servi par le serveur integre')
  check(detect && detect.previewable === true, 'le site statique devrait etre previsualisable')
  check(detect && detect.entryFile === 'index.html', 'index.html n\'est pas retenu comme fichier d\'entree')

  const lifecycle = steps.previewLifecycle
  check(lifecycle && lifecycle.state === 'running',
    `l'apercu ne demarre pas (etat ${lifecycle && lifecycle.state}: ${lifecycle && lifecycle.message})`)
  check(lifecycle && lifecycle.loopback === true,
    `l'apercu devrait etre servi sur la boucle locale (recu ${lifecycle && lifecycle.url})`)
  check(lifecycle && lifecycle.runningStatus === 'running', 'preview.status ne reflete pas l\'apercu en cours')
  check(lifecycle && lifecycle.sawStatusEvent === true, 'aucun evenement de statut d\'apercu recu')
  check(lifecycle && lifecycle.sawScreenshotEvent === true,
    'la capture automatique n\'a pas emis d\'evenement screenshot')
  check(lifecycle && lifecycle.capturePath === '.preview/latest.png',
    `la capture devrait etre ecrite dans .preview/latest.png (recu ${lifecycle && lifecycle.capturePath})`)
  check(lifecycle && lifecycle.captureIsPng === true, 'la capture n\'est pas un PNG')
  check(lifecycle && lifecycle.captureBytes > 1000, 'la capture est trop petite pour contenir une image')
  check(lifecycle && lifecycle.stoppedState === 'stopped', 'preview.stop ne libere pas l\'apercu')

  check(steps.previewRejectsOutside && steps.previewRejectsOutside.state === 'error',
    `preview.start accepte un chemin hors du workspace (etat ${steps.previewRejectsOutside && steps.previewRejectsOutside.state})`)
  check(steps.previewRejectsOutside && /hors du workspace/i.test(steps.previewRejectsOutside.message || ''),
    `le refus hors workspace n'est pas explique (${steps.previewRejectsOutside && steps.previewRejectsOutside.message})`)
  check(steps.previewRejectsOutside && !steps.previewRejectsOutside.url,
    'un apercu refuse ne doit pas exposer d\'URL')
  check(typeof steps.openExternalRejectsRemote === 'string' && steps.openExternalRejectsRemote.startsWith('refuse'),
    'preview.openExternal accepte une URL distante')

  const analysis = steps.projectAnalyze
  check(analysis && analysis.files > 0, 'l\'analyse ne compte aucun fichier')
  check(analysis && analysis.lines > 0, 'l\'analyse ne compte aucune ligne')
  check(analysis && typeof analysis.typeLabel === 'string' && analysis.typeLabel.length > 0,
    'l\'analyse ne renvoie pas de type de projet')
  check(analysis && (analysis.state === 'PASS' || analysis.state === 'FAIL'),
    `l'analyse devrait renvoyer PASS ou FAIL (recu ${analysis && analysis.state})`)
  check(analysis && analysis.hasIssuesArray && analysis.hasScriptsArray && analysis.hasDependenciesArray,
    'l\'analyse ne renvoie pas les tableaux attendus (erreurs, scripts, dependances)')
  check(analysis && analysis.languages.indexOf('HTML') >= 0, 'l\'analyse ne detecte pas le langage HTML')

  const graph = steps.projectGraph
  check(graph && graph.rootKind === 'directory', 'la racine du graphe devrait etre un dossier')
  check(graph && graph.nodeCount > 1, 'le graphe ne contient aucun noeud')
  check(graph && graph.asciiHasSite === true, 'l\'arborescence texte ne contient pas le dossier site')
  check(graph && graph.asciiHasConnectors === true, 'l\'arborescence texte n\'utilise pas de connecteurs')
  check(graph && graph.childLabels.indexOf('site') >= 0, 'le graphe n\'expose pas site parmi les enfants de la racine')

  for (const error of result.errors || []) problems.push(`renderer: ${error}`)

  if (process.env.TEST_VERBOSE === 'true') {
    report(`[debug] etapes: ${Object.keys(steps).join(', ')}`)
    report(`[debug] ${JSON.stringify(steps).slice(0, 2500)}`)
  }

  const fatal = consoleLogs.filter(entry => entry.startsWith('[3]') && !/DevTools|Autofill/i.test(entry))
  check(fatal.length === 0, `erreurs console: ${fatal.slice(0, 3).join(' | ')}`)

  await fsp.rm(workspace, { recursive: true, force: true })
  await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => {})

  if (keyBackup) fs.writeFileSync(keyFile, keyBackup)
  else if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile)
}

app.whenReady()
  .then(main)
  .catch(error => {
    problems.push(error && error.stack ? error.stack : String(error))
  })
  .then(() => {
    if (problems.length === 0) {
      report('PASS  Application (main + preload + renderer + IPC reels)')
      app.exit(0)
      return
    }
    report(`FAIL  Application: ${problems.length} probleme(s)`)
    for (const problem of problems) report(`      ${problem}`)
    for (const entry of consoleLogs.slice(0, 8)) report(`      ${entry}`)
    app.exit(1)
  })
