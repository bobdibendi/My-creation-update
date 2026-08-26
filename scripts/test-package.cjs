/**
 * Release verification.
 *
 * Runs against the artifacts in release/ and checks the things that only break
 * once the app is packaged:
 *
 *  1. the unpacked build and the Setup installer exist and are valid PE files;
 *  2. app.asar contains the renderer, the main process and nothing else;
 *  3. the packaged executable, copied outside the project, really starts and its
 *     renderer answers every IPC group (files, providers, terminal, git,
 *     preview, project, chat, agent);
 *  4. LICENSE and README.txt sit next to the installer.
 *
 * Step 3 drives the running application through the Chrome DevTools Protocol, so
 * no test-only code has to ship inside the app.
 *
 * Usage: node scripts/test-package.cjs [--keep]
 */
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const unpackedDir = path.join(releaseDir, 'win-unpacked')
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

const productName = pkg.build.productName
const version = pkg.version
const executableName = `${pkg.build.win.executableName}.exe`
const setupName = `${productName} Setup ${version}.exe`

const DEBUG_PORT = 9333
const keepArtifacts = process.argv.includes('--keep')

let failures = 0
let checks = 0
let skips = 0

function check(condition, label, detail) {
  checks += 1
  if (condition) {
    console.log(`PASS  ${label}`)
    return true
  }
  failures += 1
  console.log(`FAIL  ${label}`)
  if (detail) {
    for (const line of String(detail).trim().split('\n').slice(0, 10)) console.log(`      ${line}`)
  }
  return false
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Reads the asar file listing without adding a dependency. */
function asarEntries(archive) {
  // Header layout: 4-byte pickle size, 4-byte header size, 4-byte string size,
  // 4-byte JSON length, then the JSON directory tree.
  const handle = fs.openSync(archive, 'r')
  try {
    const prefix = Buffer.alloc(16)
    fs.readSync(handle, prefix, 0, 16, 0)
    const jsonLength = prefix.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    fs.readSync(handle, json, 0, jsonLength, 16)
    const tree = JSON.parse(json.toString('utf8'))

    const out = []
    const walk = (node, prefixPath) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const full = prefixPath ? `${prefixPath}/${name}` : name
        if (value.files) walk(value, full)
        else out.push({ path: full, size: value.size ?? 0 })
      }
    }
    walk(tree, '')
    return out
  } finally {
    fs.closeSync(handle)
  }
}

/** True when the file starts with the MZ signature of a Windows binary. */
function isWindowsExecutable(target) {
  const handle = fs.openSync(target, 'r')
  try {
    const magic = Buffer.alloc(2)
    fs.readSync(handle, magic, 0, 2, 0)
    return magic.toString('latin1') === 'MZ'
  } finally {
    fs.closeSync(handle)
  }
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyDirectory(from, to)
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to)
    else fs.copyFileSync(from, to)
  }
}

function removeDirectory(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
  } catch {
    // A file handle may still be open; the temp directory is disposable.
  }
}

function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => { request.destroy(); reject(new Error('timeout')) })
    request.on('error', reject)
  })
}

/** Waits for the DevTools endpoint to expose the application's page target. */
async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'aucune reponse du port de debogage'
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`)
      const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return page
      lastError = `aucune cible "page" (${targets.map(t => t.type).join(', ') || 'liste vide'})`
    } catch (error) {
      lastError = error.message
    }
    await delay(500)
  }
  throw new Error(lastError)
}

/** Minimal CDP client over the global WebSocket shipped with Node 22+. */
class DevToolsSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  static connect(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('connexion DevTools expiree'))
      }, timeoutMs)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve(new DevToolsSession(socket))
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('connexion DevTools refusee'))
      })
    })
  }

  send(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: pas de reponse en ${timeoutMs / 1000} s`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Evaluates an async expression in the page and returns its resolved value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 110000,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'exception dans le renderer'
      throw new Error(text)
    }
    return result.result.value
  }

  close() {
    try { this.socket.close() } catch { /* already closing */ }
  }
}

/**
 * The probe executed inside the packaged renderer.
 *
 * Every entry returns `{ ok, detail, info }` so a single failing subsystem is
 * reported precisely instead of collapsing the whole launch into one FAIL.
 * `detail` explains a failure, `info` annotates a success.
 */
function probeScript(workspace) {
  return `(async () => {
  const results = {}
  const record = (name, ok, failure) => {
    results[name] = { ok: Boolean(ok), detail: ok ? '' : (failure || ''), info: '' }
  }
  const workspace = ${JSON.stringify(workspace)}
  const bridge = window.electronAPI

  // Auth Supabase obligatoire : sans session confirmee, l'app affiche
  // l'ecran Onboarding — c'est un montage valide, pas un echec.
  let uiState = 'none'
  const mountDeadline = Date.now() + 20000
  while (Date.now() < mountDeadline) {
    if (document.querySelector('.app-shell')) { uiState = 'session'; break }
    if (document.querySelector('.onboarding')) { uiState = 'onboarding'; break }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  const authed = uiState === 'session'
  record('React a monte l\\'interface', uiState !== 'none',
    'ni .app-shell ni .onboarding apres 20 s')
  if (!authed) {
    results['__authed'] = undefined
  }
  if (uiState === 'onboarding') {
    const emailInput = document.querySelector('.onboarding input[type="email"], .onboarding input[type="password"], .onboarding button')
    record('ecran Onboarding interactif (auth requise)', Boolean(emailInput), 'formulaire introuvable')
  }
  if (authed) {
    record('la barre de titre est rendue', Boolean(document.querySelector('.titlebar')))
    record('la barre d\\'activite est rendue', Boolean(document.querySelector('.activitybar')))
    record('la barre d\\'etat est rendue', Boolean(document.querySelector('.statusbar')))
    record('l\\'ecran d\\'accueil est rendu', Boolean(document.querySelector('.home')
      || document.querySelector('.welcome')))
  } else {
    for (const label of ['la barre de titre est rendue', 'la barre d\\'activite est rendue',
      'la barre d\\'etat est rendue', 'l\\'ecran d\\'accueil est rendu']) {
      results[label] = { ok: false, skip: true, detail: 'session Supabase non disponible dans la sonde', info: '' }
    }
  }

  const background = getComputedStyle(document.body).backgroundColor
  record('la feuille de style est appliquee', background !== 'rgba(0, 0, 0, 0)' && background !== '',
    'fond calcule: ' + background)

  const fonts = document.querySelectorAll('link[href^="http"], style[data-external]')
  record('aucune ressource distante requise', fonts.length === 0)

  record('le pont preload est expose', Boolean(bridge))
  if (!bridge) return results

  const expected = {
    window: ['minimize', 'maximize', 'close', 'isMaximized', 'openDevTools', 'onMaximized'],
    git: ['status', 'branches', 'root', 'run'],
    files: ['openFolder', 'read', 'write', 'list', 'listRecursive', 'create', 'delete', 'rename', 'exists'],
    terminal: ['create', 'write', 'resize', 'kill', 'onData', 'onExit'],
    api: ['storeKey', 'checkKey', 'deleteKey', 'listProviders'],
    ai: ['chat', 'cancel', 'onChunk'],
    agent: ['start', 'cancel', 'onEvent'],
    preview: ['detect', 'candidates', 'start', 'stop', 'status', 'capture', 'latestCapture', 'openExternal', 'onEvent'],
    project: ['analyze', 'graph'],
  }
  const missing = []
  for (const group of Object.keys(expected)) {
    const section = bridge[group]
    if (!section) { missing.push(group); continue }
    for (const method of expected[group]) {
      if (typeof section[method] !== 'function') missing.push(group + '.' + method)
    }
  }
  record('l\\'API du preload est complete', missing.length === 0, 'manquant: ' + missing.join(', '))

  const attempt = async (name, task) => {
    try {
      const info = await task()
      results[name] = { ok: true, detail: '', info: info || '' }
    } catch (error) {
      results[name] = { ok: false, detail: error && error.message ? error.message : String(error), info: '' }
    }
  }

  await attempt('IPC fenetre: window.isMaximized', async () => {
    const value = await bridge.window.isMaximized()
    if (typeof value !== 'boolean') throw new Error('reponse inattendue: ' + JSON.stringify(value))
    return 'maximise=' + value
  })

  await attempt('IPC fichiers: write, read, list, exists, delete', async () => {
    const file = workspace + '\\\\sonde.txt'
    await bridge.files.write(file, 'contenu de la sonde')
    const content = await bridge.files.read(file)
    if (content !== 'contenu de la sonde') throw new Error('relecture incorrecte: ' + content)
    const listing = await bridge.files.list(workspace)
    if (!Array.isArray(listing) || listing.length === 0) throw new Error('listage vide')
    if (await bridge.files.exists(file) !== true) throw new Error('exists a renvoye false')
    await bridge.files.delete(file)
    if (await bridge.files.exists(file) !== false) throw new Error('le fichier survit a la suppression')
    return listing.length + ' entrees'
  })

  await attempt('IPC fichiers: listRecursive', async () => {
    const listing = await bridge.files.listRecursive(workspace)
    if (!Array.isArray(listing)) throw new Error('reponse inattendue')
    return listing.length + ' entrees'
  })

  await attempt('Providers: listProviders renvoie les modeles', async () => {
    const providers = await bridge.api.listProviders()
    if (!Array.isArray(providers) || providers.length === 0) throw new Error('aucun fournisseur')
    const expectedIds = ['anthropic', 'openai', 'google', 'tools']
    const ids = providers.map(provider => provider.id)
    for (const id of expectedIds) {
      if (!ids.includes(id)) throw new Error('fournisseur absent: ' + id)
    }
    const withoutModels = providers.filter(provider => !provider.models || provider.models.length === 0)
    if (withoutModels.length > 0) {
      throw new Error('sans modele: ' + withoutModels.map(provider => provider.id).join(', '))
    }
    const total = providers.reduce((sum, provider) => sum + provider.models.length, 0)
    return providers.length + ' fournisseurs, ' + total + ' modeles'
  })

  await attempt('Trousseau: checkKey lit le stockage chiffre', async () => {
    const status = await bridge.api.checkKey('anthropic')
    if (!status || status.success !== true) throw new Error(JSON.stringify(status))
    return 'configuree=' + status.configured
  })

  await attempt('Trousseau: storeKey refuse une cle trop courte', async () => {
    const status = await bridge.api.storeKey('anthropic', 'court')
    if (status.success !== false) throw new Error('la validation n\\'a pas rejete la cle')
    return status.error || ''
  })

  await attempt('Chat: ai.chat signale un modele inconnu', async () => {
    // The listener must be installed before the call: the main process rejects an
    // unknown model immediately, so the error event can arrive before invoke()
    // has even resolved.
    let received = null
    let resolveEvent = null
    const settled = new Promise(resolve => { resolveEvent = resolve })
    const off = bridge.ai.onChunk(event => {
      if (received && event.requestId !== received) return
      if (event.type === 'error' || event.type === 'done') resolveEvent(event)
    })
    try {
      const response = await bridge.ai.chat({
        messages: [{ role: 'user', content: 'sonde' }],
        model: 'modele-inexistant-pour-la-sonde',
        workspace,
      })
      received = response.requestId
      if (!received) throw new Error('aucun requestId')
      const outcome = await Promise.race([
        settled,
        new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 20000)),
      ])
      if (outcome.type !== 'error') throw new Error('evenement inattendu: ' + outcome.type)
      return outcome.message
    } finally {
      off()
    }
  })

  await attempt('Agent: agent.start valide ses entrees', async () => {
    let received = null
    let resolveEvent = null
    const settled = new Promise(resolve => { resolveEvent = resolve })
    const off = bridge.agent.onEvent(event => {
      if (received && event.sessionId !== received) return
      if (event.type === 'error' || event.type === 'done') resolveEvent(event)
    })
    try {
      const response = await bridge.agent.start({ prompt: '', workspace, model: 'x' })
      received = response.sessionId
      if (!received) throw new Error('aucun sessionId')
      const outcome = await Promise.race([
        settled,
        new Promise(resolve => setTimeout(() => resolve({ type: 'timeout' }), 20000)),
      ])
      if (outcome.type !== 'error') throw new Error('evenement inattendu: ' + outcome.type)
      return outcome.message
    } finally {
      off()
    }
  })

  await attempt('Terminal: cmd.exe execute une commande', async () => {
    const id = await bridge.terminal.create(workspace)
    if (!id) throw new Error('aucun identifiant de session')
    const output = await new Promise(resolve => {
      let buffer = ''
      const timer = setTimeout(() => { off(); resolve(buffer) }, 25000)
      const off = bridge.terminal.onData(payload => {
        if (payload.id !== id) return
        buffer += payload.data
        if (buffer.includes('SONDE-TERMINAL-OK')) {
          clearTimeout(timer)
          off()
          resolve(buffer)
        }
      })
      bridge.terminal.write(id, 'echo SONDE-TERMINAL-OK\\r\\n')
    })
    await bridge.terminal.kill(id)
    if (!output.includes('SONDE-TERMINAL-OK')) {
      throw new Error('sortie inattendue: ' + JSON.stringify(output.slice(-160)))
    }
    return 'echo relaye'
  })

  await attempt('Git: git.status repond', async () => {
    const status = await bridge.git.status(workspace)
    if (typeof status !== 'string') throw new Error('reponse inattendue')
    return status.trim().length === 0 ? 'hors depot (attendu)' : 'depot detecte'
  })

  await attempt('Preview: status et detection', async () => {
    const status = await bridge.preview.status()
    if (!status || typeof status.state !== 'string') throw new Error('statut illisible')
    const target = await bridge.preview.detect(workspace, '')
    if (!target || typeof target.previewable !== 'boolean') throw new Error('detection illisible')
    return 'etat=' + status.state + ', previewable=' + target.previewable
  })

  await attempt('Preview: demarrage d\\'un serveur statique', async () => {
    await bridge.files.write(workspace + '\\\\index.html',
      '<!doctype html><html><body><h1>Sonde</h1></body></html>')
    const status = await bridge.preview.start(workspace, '', false)
    if (status.state !== 'running' || !status.url) {
      throw new Error('etat=' + status.state + ' ' + (status.message || ''))
    }
    const url = status.url
    await bridge.preview.stop()
    return url
  })

  await attempt('Preview: openExternal refuse une URL distante', async () => {
    try {
      await bridge.preview.openExternal('https://exemple.invalide/')
    } catch (error) {
      return error.message.split('\\n')[0]
    }
    throw new Error('une URL distante a ete acceptee')
  })

  await attempt('Analyse: project.analyze', async () => {
    const analysis = await bridge.project.analyze(workspace, '')
    if (!analysis || typeof analysis !== 'object') throw new Error('resultat illisible')
    return 'analyse produite'
  })

  await attempt('Analyse: project.graph', async () => {
    const graph = await bridge.project.graph(workspace, '', 3)
    if (!graph || typeof graph !== 'object') throw new Error('resultat illisible')
    return 'graphe produit'
  })

  if (!authed) {
  results['Editeur: Monaco s\\'instancie'] = { ok: false, skip: true, detail: 'UI principale indisponible hors session', info: '' }
  } else await attempt('Editeur: Monaco s\\'instancie', async () => {
    // Ctrl+N opens an untitled buffer, which mounts the editor and pulls in the
    // Monaco chunk. Resource timing is empty under file://, so the DOM that
    // Monaco builds is the only reliable evidence that the chunk really ran.
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true,
    }))

    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (document.querySelector('.monaco-editor .view-lines')) {
        const tabs = document.querySelectorAll('.editor-tabs .tab, .tabs .tab').length
        return 'editeur monte' + (tabs > 0 ? ', ' + tabs + ' onglet(s)' : '')
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    const host = document.querySelector('.editor__monaco')
    throw new Error(host
      ? 'conteneur present mais Monaco n\\'a pas rendu de lignes'
      : 'l\\'editeur ne s\\'est pas monte apres Ctrl+N')
  })

  if (!authed) {
  results['Assistant: le panneau s\\'ouvre'] = { ok: false, skip: true, detail: 'UI principale indisponible hors session', info: '' }
  } else await attempt('Assistant: le panneau s\\'ouvre', async () => {
    const buttons = Array.from(document.querySelectorAll('.activitybar button'))
    const agent = buttons.find(button => (button.getAttribute('title') || '').includes('Assistant'))
    if (!agent) throw new Error('bouton Assistant introuvable')
    agent.click()
    await new Promise(resolve => setTimeout(resolve, 900))
    const panel = document.querySelector('.assistant, .agent-panel')
    if (!panel) throw new Error('panneau introuvable apres le clic')
    return 'panneau ouvert'
  })

  await attempt('Monaco: les workers demarrent reellement', async () => {
    // The editor can silently fall back to a main-thread worker when worker
    // creation fails, which hides packaging bugs. Spawn each dedicated worker
    // exactly the way monaco does; a module worker whose script fails to load
    // or evaluate always fires error/messageerror, so surviving the window
    // means the chunk really booted.
    const env = self.MonacoEnvironment
    if (!env || typeof env.getWorker !== 'function') throw new Error('MonacoEnvironment.getWorker absent')
    const labels = ['typescript', 'css', 'html', 'json', 'editorWorkerService']
    for (const label of labels) {
      const worker = await Promise.resolve(env.getWorker('workerMain.js', label))
      if (!(worker instanceof Worker)) throw new Error('worker ' + label + ' : objet inattendu')
      await new Promise((resolve, reject) => {
        const fail = why => { clearTimeout(timer); worker.terminate(); reject(new Error('worker ' + label + ' : ' + why)) }
        const timer = setTimeout(() => { worker.terminate(); resolve() }, 2500)
        worker.onerror = () => fail('erreur de chargement/evaluation')
        worker.onmessageerror = () => fail('message non serialisable')
      })
    }
    return '5 workers evalues sous file:// (' + labels.join(', ') + ')'
  })

  return results
})()`
}

async function verifyPackagedApp(executable) {
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-probe-'))
  await fsp.writeFile(path.join(workspace, 'exemple.txt'), 'contenu', 'utf8')

  const child = spawn(executable, [`--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: path.dirname(executable),
    env: {
      ...process.env,
      ELECTRON_DEV: 'false',
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    stdio: 'ignore',
    windowsHide: false,
    detached: process.platform !== 'win32',
  })

  let exitInfo = null
  child.on('exit', code => { exitInfo = code })

  let session = null
  try {
    const target = await waitForPageTarget(DEBUG_PORT, 90000)
    check(true, 'l\'application packagee demarre et expose son renderer')
    check(/app\.asar[\\/]dist[\\/]index\.html$/.test(decodeURIComponent(target.url))
      || target.url.includes('index.html'),
    'le renderer est charge depuis l\'archive', `url: ${target.url}`)

    session = await DevToolsSession.connect(target.webSocketDebuggerUrl)
    await session.send('Runtime.enable')

    // The window is created hidden and shown on ready-to-show; give React's
    // mount effects (provider list, settings, layout) time to settle.
    await delay(3500)

    const results = await session.evaluate(probeScript(workspace))
    for (const [label, outcome] of Object.entries(results)) {
      if (outcome.skip) {
        skips += 1
        console.log(`SKIP  ${label} (${outcome.detail || 'non applicable'})`)
        continue
      }
      check(outcome.ok, label, outcome.detail)
      if (outcome.ok && outcome.info) console.log(`      ${outcome.info}`)
    }
  } catch (error) {
    check(false, 'l\'application packagee demarre et repond',
      `${error.message}${exitInfo !== null ? ` (processus arrete, code ${exitInfo})` : ''}`)
  } finally {
    if (session) session.close()
    killTree(child)
    await delay(1200)
    await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

void (async () => {
  console.log(`Verification de ${productName} ${version}`)

  // ── Artifacts ──────────────────────────────────────────
  section('Artefacts')

  const setupPath = path.join(releaseDir, setupName)
  const executablePath = path.join(unpackedDir, executableName)
  const asarPath = path.join(unpackedDir, 'resources', 'app.asar')

  const hasSetup = check(fs.existsSync(setupPath), `installateur present: release/${setupName}`)
  check(fs.existsSync(unpackedDir), 'build decompresse present: release/win-unpacked')
  const hasExecutable = check(fs.existsSync(executablePath), `executable present: win-unpacked/${executableName}`)
  const hasAsar = check(fs.existsSync(asarPath), 'archive presente: resources/app.asar')

  if (hasSetup) {
    const stats = fs.statSync(setupPath)
    check(isWindowsExecutable(setupPath), 'l\'installateur est un binaire Windows valide')
    check(stats.size > 40 * 1024 * 1024, `taille de l'installateur plausible (${megabytes(stats.size)})`)
  }

  if (hasExecutable) {
    check(isWindowsExecutable(executablePath), 'l\'executable de l\'application est un binaire Windows valide')
  }

  // ── Archive contents ───────────────────────────────────
  section('Contenu de l\'archive')

  if (hasAsar) {
    let entries = []
    try {
      entries = asarEntries(asarPath)
    } catch (error) {
      check(false, 'lecture de app.asar', error.message)
    }

    const paths = entries.map(entry => entry.path)
    check(paths.includes('dist-electron/main.js'), 'dist-electron/main.js est empaquete')
    check(paths.includes('dist-electron/preload.js'), 'dist-electron/preload.js est empaquete')
    check(paths.includes('dist/index.html'), 'dist/index.html est empaquete')
    check(paths.some(entry => /^dist\/assets\/index-.*\.js$/.test(entry)), 'le bundle applicatif est empaquete')
    check(paths.some(entry => /^dist\/assets\/react-.*\.js$/.test(entry)), 'React est empaquete')
    check(paths.some(entry => /^dist\/assets\/monaco-.*\.js$/.test(entry)), 'Monaco est empaquete')
    check(paths.some(entry => /^dist\/assets\/xterm-.*\.js$/.test(entry)), 'xterm est empaquete')
    check(paths.includes('package.json'), 'package.json est empaquete')

    const maps = paths.filter(entry => entry.endsWith('.map'))
    check(maps.length === 0, 'aucune source map empaquetee', maps.slice(0, 5).join('\n'))

    const sources = paths.filter(entry => /\.(ts|tsx)$/.test(entry))
    check(sources.length === 0, 'aucun fichier TypeScript empaquete', sources.slice(0, 5).join('\n'))

    const stray = paths.filter(entry => entry.startsWith('src/') || entry.startsWith('scripts/')
      || entry.startsWith('backup/') || entry.startsWith('release/') || entry.startsWith('build/'))
    check(stray.length === 0, 'aucun fichier de developpement empaquete', stray.slice(0, 5).join('\n'))

    console.log(`      ${entries.length} fichiers, ${megabytes(entries.reduce((sum, e) => sum + e.size, 0))}`)
  }

  // ── Standalone launch ──────────────────────────────────
  section('Fonctionnement sans le projet source')

  if (hasExecutable) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-clone-standalone-'))
    const copiedApp = path.join(sandbox, 'app')
    try {
      console.log('      copie du build hors du dossier du projet...')
      copyDirectory(unpackedDir, copiedApp)
      const copiedExecutable = path.join(copiedApp, executableName)
      check(fs.existsSync(copiedExecutable), 'le build fonctionne depuis un dossier arbitraire')
      await verifyPackagedApp(copiedExecutable)
    } finally {
      if (keepArtifacts) console.log(`      build conserve: ${copiedApp}`)
      else removeDirectory(sandbox)
    }
  }

  // ── Distribution files ─────────────────────────────────
  section('Fichiers de distribution')

  for (const item of [
    { source: path.join(projectRoot, 'LICENSE'), name: 'LICENSE' },
    { source: path.join(projectRoot, 'build', 'README.txt'), name: 'README.txt' },
  ]) {
    if (!fs.existsSync(item.source)) {
      check(false, `source presente: ${item.name}`)
      continue
    }
    fs.copyFileSync(item.source, path.join(releaseDir, item.name))
    check(fs.existsSync(path.join(releaseDir, item.name)), `release/${item.name}`)
  }

  check(fs.existsSync(path.join(releaseDir, 'latest.yml')), 'release/latest.yml (metadonnees de mise a jour)')

  // ── Summary ────────────────────────────────────────────
  section('Bilan')
  console.log(`${checks - failures}/${checks} verifications reussies` + (skips > 0 ? ` (${skips} skip)` : ''))
  if (failures === 0) {
    console.log(`\nInstallateur: ${setupPath}`)
    if (fs.existsSync(setupPath)) console.log(`Taille: ${megabytes(fs.statSync(setupPath).size)}`)
    console.log('Statut: PRET A DISTRIBUER')
  } else {
    console.log(`\n${failures} verification(s) en echec.`)
  }
  process.exit(failures === 0 ? 0 : 1)
})()
