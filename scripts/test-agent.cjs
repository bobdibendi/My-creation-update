/**
 * End-to-end agent harness.
 *
 * Runs inside Electron (so safeStorage keys and the real provider stack are
 * available) and drives the compiled agent runtime against a throwaway
 * workspace. Every prompt from the acceptance list is executed for real.
 *
 * Usage: node scripts/test.cjs agent [--keep] [--only <index>]
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist-electron')

const argv = process.argv.slice(2)
const keepWorkspace = argv.includes('--keep')
const onlyIndex = argv.includes('--only') ? Number(argv[argv.indexOf('--only') + 1]) : null

/**
 * Wall clock per LLM-backed case. A case that never settles (provider stream
 * stalled) is aborted and reported as an explicit FAIL: a timeout must NEVER
 * be counted as a pass. Override locally with AGENT_CASE_TIMEOUT_MS.
 */
const CASE_TIMEOUT_MS = Number(process.env.AGENT_CASE_TIMEOUT_MS) > 0
  ? Number(process.env.AGENT_CASE_TIMEOUT_MS)
  : 240_000

/** Races `task` against the deadline; aborts `controller` when it fires. */
function withDeadline(task, controller) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('test timeout'))
      reject(new Error(
        `timeout apres ${Math.round(CASE_TIMEOUT_MS / 1000)} s sans reponse du fournisseur (cas bloque, compte comme echec)`,
      ))
    }, CASE_TIMEOUT_MS)
  })
  return Promise.race([task, deadline]).finally(() => clearTimeout(timer))
}

if (!fs.existsSync(path.join(distDir, 'main.js'))) {
  report('FATAL dist-electron absent. Lance "npm run build" avant les tests.')
  process.exit(1)
}

const { ProviderRegistry } = require(path.join(distDir, 'providers', 'registry.js'))
const { createAnthropicProvider } = require(path.join(distDir, 'providers', 'anthropic.js'))
const { createOpenAIProvider } = require(path.join(distDir, 'providers', 'openai.js'))
const { createGoogleProvider } = require(path.join(distDir, 'providers', 'google.js'))
const { createToolsProvider } = require(path.join(distDir, 'providers', 'tools.js'))
const { ToolRegistry } = require(path.join(distDir, 'agent', 'registry.js'))
const { AgentRuntime } = require(path.join(distDir, 'agent', 'runtime.js'))
const { buildChatSystemPrompt } = require(path.join(distDir, 'agent', 'prompt.js'))
const { runShellCommand } = require(path.join(distDir, 'agent', 'tools', 'terminal.js'))
const { KeyStore } = require(path.join(distDir, 'keystore.js'))

app.setName('cursor-clone')

// capturePreview opens a hidden BrowserWindow and closes it right after the
// shot. With zero windows left Electron would quit the harness silently
// mid-run (default window-all-closed behaviour), so opt out explicitly:
// only main()'s app.exit() terminates this process.
app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()

// ─── Fixture workspace ─────────────────────────────────
// src/index.js imports `addition`, src/math.js exports `sum`: the agent has to
// find and fix the mismatch, and scripts/verify.js proves it.
const FIXTURE = {
  'package.json': JSON.stringify({
    name: 'agent-fixture',
    version: '1.0.0',
    private: true,
    scripts: {
      typecheck: 'node --check src/index.js && node scripts/verify.js',
    },
  }, null, 2) + '\n',

  'README.md': '# Fixture\n\nPetit projet utilise pour valider l\'agent.\n',

  'src/index.js': [
    "const { addition } = require('./math')",
    '',
    'function main() {',
    '  process.stdout.write(String(addition(2, 3)) + "\\n")',
    '}',
    '',
    'main()',
    '',
  ].join('\n'),

  'src/math.js': [
    'function sum(a, b) {',
    '  return a + b',
    '}',
    '',
    'module.exports = { sum }',
    '',
  ].join('\n'),

  'scripts/verify.js': [
    "const { addition } = require('../src/math')",
    '',
    "if (typeof addition !== 'function') {",
    '  process.stderr.write("ERREUR: src/math.js doit exporter une fonction addition\\n")',
    '  process.exit(1)',
    '}',
    'if (addition(2, 3) !== 5) {',
    '  process.stderr.write("ERREUR: addition(2, 3) doit valoir 5\\n")',
    '  process.exit(1)',
    '}',
    'process.stdout.write("verify OK\\n")',
    '',
  ].join('\n'),
}

async function createWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-agent-'))
  for (const [relative, content] of Object.entries(FIXTURE)) {
    const target = path.join(root, relative)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, content, 'utf8')
  }
  return root
}

// ─── Helpers ───────────────────────────────────────────
async function exists(root, relative) {
  try {
    await fsp.access(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

function readFileIn(root, relative) {
  return fsp.readFile(path.join(root, relative), 'utf8')
}

const FRENCH_MARKERS = [
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'est', 'et', 'pour', 'dans',
  'avec', 'vous', 'je', 'ce', 'cette', 'ai', 'sont', 'que', 'qui', 'sur',
  'bonjour', 'fichier', 'fichiers', 'dossier', 'projet', 'puis', 'faire',
]

const ENGLISH_MARKERS = [
  'the', 'and', 'with', 'you', 'this', 'that', 'file', 'files', 'folder',
  'hello', 'have', 'been', 'here', 'what', 'your', 'created', 'directory',
]

function wordsOf(text) {
  return text.toLowerCase().split(/[^\p{Letter}']+/u).filter(Boolean)
}

/**
 * Language check tuned for short answers: compares French against English
 * marker hits rather than requiring a fixed count, and treats accented
 * characters as strong evidence.
 */
function isFrench(text) {
  if (text.trim().length === 0) return false
  const words = new Set(wordsOf(text))
  const french = FRENCH_MARKERS.filter(marker => words.has(marker)).length
  const english = ENGLISH_MARKERS.filter(marker => words.has(marker)).length
  const accents = /[\u00e0-\u00ff\u0153]/i.test(text) ? 2 : 0
  return french + accents > english && french + accents >= 2
}

/** Rejects transcripts that leaked the raw tool protocol to the user. */
function leaksProtocol(text) {
  return /"type"\s*:\s*"tool[-_]calls"/i.test(text)
    || /\{\s*"tool"\s*:/i.test(text)
    || /Unsupported intent/i.test(text)
    || /Provider\.plan\(\) timed out/i.test(text)
}

// ─── Deterministic tool checks ─────────────────────────
/**
 * Exercises every registered tool directly through the registry so filesystem,
 * terminal and isolation behaviour are verified regardless of what the model
 * chooses to call.
 */
async function runToolChecks(workspace) {
  const registry = new ToolRegistry()
  const controller = new AbortController()
  const context = { workspace, signal: controller.signal, onProgress: () => {} }
  const failures = []

  const call = (name, args) => registry.execute(name, JSON.stringify(args), context)

  const expectOk = async (label, name, args, verify) => {
    const outcome = await call(name, args)
    if (!outcome.success) {
      failures.push(`${label}: ${outcome.error}`)
      return
    }
    const problem = verify ? await verify(outcome.result) : null
    if (problem) failures.push(`${label}: ${problem}`)
  }

  const expectFail = async (label, name, args, pattern) => {
    const outcome = await call(name, args)
    if (outcome.success) {
      failures.push(`${label}: l'appel aurait du echouer`)
      return
    }
    if (pattern && !pattern.test(outcome.error)) {
      failures.push(`${label}: message inattendu (${outcome.error})`)
    }
  }

  const expectedTools = [
    'listDirectory', 'readFile', 'writeFile', 'editFile', 'createDirectory',
    'deleteFile', 'renameFile', 'moveFile', 'pathExists', 'searchInFiles',
    'findFiles', 'runCommand', 'analyzeProject', 'checkProject',
  ]
  for (const name of expectedTools) {
    if (!registry.get(name)) failures.push(`outil manquant: ${name}`)
  }

  for (const schema of registry.schemas()) {
    if (schema.parameters.type !== 'object') failures.push(`schema invalide: ${schema.name}`)
    if (schema.description.trim().length === 0) failures.push(`description vide: ${schema.name}`)
  }

  await expectOk('listDirectory', 'listDirectory', { path: '.' }, result =>
    (result.entries.some(entry => entry.path === 'package.json') ? null : 'package.json absent'))
  await expectOk('listDirectory recursif', 'listDirectory', { path: '.', recursive: true }, result =>
    (result.entries.some(entry => entry.path === 'src/math.js') ? null : 'src/math.js absent'))
  await expectOk('readFile', 'readFile', { path: 'package.json' }, result =>
    (/agent-fixture/.test(result.content) ? null : 'contenu inattendu'))
  await expectOk('readFile plage', 'readFile', { path: 'src/math.js', startLine: 1, endLine: 2 }, result =>
    (result.content.split('\n').length === 2 ? null : 'la plage de lignes est ignoree'))
  await expectOk('writeFile', 'writeFile', { path: 'tools-check/a.txt', content: 'alpha' })
  await expectOk('editFile', 'editFile', { path: 'tools-check/a.txt', oldText: 'alpha', newText: 'beta' })
  await expectOk('relecture apres edition', 'readFile', { path: 'tools-check/a.txt' }, result =>
    (/beta/.test(result.content) ? null : 'edition non appliquee'))
  await expectOk('createDirectory', 'createDirectory', { path: 'tools-check/nested/deep' })
  await expectOk('renameFile', 'renameFile', { path: 'tools-check/a.txt', newName: 'b.txt' })
  await expectOk('moveFile', 'moveFile', { from: 'tools-check/b.txt', to: 'tools-check/nested/c.txt' })
  await expectOk('pathExists', 'pathExists', { path: 'tools-check/nested/c.txt' }, result =>
    (result.exists && result.kind === 'file' ? null : 'chemin non detecte'))
  await expectOk('findFiles', 'findFiles', { pattern: '*.js' }, result =>
    (result.files.length > 0 ? null : 'aucun fichier trouve'))
  await expectOk('searchInFiles', 'searchInFiles', { query: 'module.exports' }, result =>
    (result.matchCount > 0 ? null : 'aucune correspondance'))
  await expectOk('runCommand', 'runCommand', { command: 'node --version' }, result =>
    (/v\d+\./.test(result.stdout) ? null : `sortie inattendue: ${result.stdout}`))
  await expectOk('runCommand code non nul', 'runCommand', { command: 'node -e "process.exit(3)"' }, result =>
    (result.exitCode === 3 && result.success === false ? null : `code inattendu: ${result.exitCode}`))
  await expectOk('analyzeProject', 'analyzeProject', {}, result =>
    (result.checkCommands.length > 0 ? null : 'aucune commande de verification detectee'))
  await expectOk('deleteFile recursif', 'deleteFile', { path: 'tools-check', recursive: true })
  await expectOk('pathExists apres suppression', 'pathExists', { path: 'tools-check' }, result =>
    (result.exists ? 'le dossier existe encore' : null))

  // Workspace isolation.
  await expectFail('echappement relatif', 'readFile', { path: '../../secret.txt' }, /hors du workspace|introuvable/i)
  await expectFail('echappement absolu', 'readFile', { path: 'C:\\Windows\\win.ini' }, /hors du workspace|introuvable/i)
  await expectFail('ecriture hors workspace', 'writeFile', { path: '../escape.txt', content: 'x' }, /hors du workspace/i)
  await expectFail('suppression racine', 'deleteFile', { path: '.' }, /racine du workspace/i)
  await expectFail('commande destructrice', 'runCommand', { command: 'format C: /y' }, /refusee|refus/i)
  await expectFail('outil inconnu', 'doesNotExist', {}, /Outil inconnu/i)
  await expectFail('argument manquant', 'readFile', {}, /manquant/i)
  await expectFail('edition ambigue', 'editFile', { path: 'src/math.js', oldText: 'a', newText: 'b' }, /occurrences/i)

  const malformed = await registry.execute('readFile', '{not json', context)
  if (malformed.success || !/JSON invalides/i.test(malformed.error)) {
    failures.push('arguments JSON invalides mal geres')
  }

  return failures
}

// ─── Agent cases ───────────────────────────────────────
const CASES = [
  {
    name: 'Salutation',
    prompt: 'Bonjour',
    check: async ({ text }) => {
      if (text.trim().length === 0) return 'reponse vide'
      if (!isFrench(text)) return `reponse non francophone: ${text.slice(0, 120)}`
      return null
    },
  },
  {
    name: 'Inventaire des fichiers',
    prompt: 'Quels fichiers contient ce projet ?',
    check: async ({ text, tools }) => {
      if (!tools.some(tool => ['listDirectory', 'analyzeProject', 'findFiles', 'projectOverview'].includes(tool))) {
        return 'aucun outil de listing utilise'
      }
      if (!/package\.json/i.test(text)) return 'package.json absent de la reponse'
      if (!/math\.js/i.test(text)) return 'src/math.js absent de la reponse'
      return null
    },
  },
  {
    name: 'Structure du projet',
    prompt: 'Explique la structure du projet.',
    check: async ({ text, tools }) => {
      if (tools.length === 0) return 'aucun outil utilise'
      if (!/src/i.test(text)) return 'le dossier src n\'est pas mentionne'
      if (!isFrench(text)) return 'reponse non francophone'
      return null
    },
  },
  {
    name: 'Lecture de package.json',
    prompt: 'Lis package.json.',
    check: async ({ text, tools }) => {
      if (!tools.includes('readFile')) return 'readFile non appele'
      if (!/agent-fixture/i.test(text)) return 'le nom du paquet n\'apparait pas'
      return null
    },
  },
  {
    name: 'Lecture d\'un fichier imbrique',
    prompt: 'Lis src/math.js et dis-moi ce qu\'il exporte.',
    check: async ({ text, tools }) => {
      if (!tools.includes('readFile')) return 'readFile non appele'
      if (!/sum/i.test(text)) return 'l\'export sum n\'est pas mentionne'
      return null
    },
  },
  {
    name: 'Creation d\'un fichier texte',
    prompt: 'Cree un fichier hello.txt contenant "bonjour".',
    check: async ({ root, tools }) => {
      if (!tools.includes('writeFile')) return 'writeFile non appele'
      if (!await exists(root, 'hello.txt')) return 'hello.txt non cree'
      const content = (await readFileIn(root, 'hello.txt')).trim().toLowerCase()
      if (!content.includes('bonjour')) return `contenu inattendu: ${content}`
      return null
    },
  },
  {
    name: 'Creation d\'un dossier',
    prompt: 'Cree un dossier docs et place dedans un fichier notes.md avec un titre.',
    check: async ({ root, tools }) => {
      if (!tools.some(tool => ['createDirectory', 'writeFile'].includes(tool))) {
        return 'aucun outil d\'ecriture utilise'
      }
      if (!await exists(root, 'docs/notes.md')) return 'docs/notes.md non cree'
      const content = await readFileIn(root, 'docs/notes.md')
      if (content.trim().length === 0) return 'docs/notes.md est vide'
      return null
    },
  },
  {
    name: 'Renommage',
    prompt: 'Renomme le fichier hello.txt en bonjour.txt.',
    check: async ({ root, tools }) => {
      if (!tools.some(tool => ['renameFile', 'moveFile'].includes(tool))) return 'renameFile non appele'
      if (!await exists(root, 'bonjour.txt')) return 'bonjour.txt absent'
      if (await exists(root, 'hello.txt')) return 'hello.txt existe toujours'
      return null
    },
  },
  {
    name: 'Modification ciblee',
    prompt: 'Dans README.md, ajoute une section "## Utilisation" avec une phrase d\'explication.',
    check: async ({ root, tools }) => {
      if (!tools.some(tool => ['editFile', 'writeFile'].includes(tool))) return 'aucun outil d\'edition utilise'
      const content = await readFileIn(root, 'README.md')
      if (!/##\s*Utilisation/i.test(content)) return 'section Utilisation absente'
      return null
    },
  },
  {
    name: 'Execution de commande',
    prompt: 'Execute la commande "node --version" et donne-moi la version.',
    check: async ({ text, tools }) => {
      if (!tools.some(tool => ['runCommand', 'checkProject'].includes(tool))) return 'runCommand non appele'
      if (!/v?\d+\.\d+\.\d+/.test(text)) return 'aucune version dans la reponse'
      return null
    },
  },
  {
    name: 'Suppression',
    prompt: 'Supprime le fichier bonjour.txt.',
    check: async ({ root, tools }) => {
      if (!tools.includes('deleteFile')) return 'deleteFile non appele'
      if (await exists(root, 'bonjour.txt')) return 'bonjour.txt existe toujours'
      return null
    },
  },
  {
    name: 'Site web complet',
    prompt: 'Cree un site moderne sur les sushis dans le dossier site: page HTML, feuille de style CSS et un peu de JavaScript.',
    check: async ({ root, tools }) => {
      if (!tools.includes('writeFile')) return 'writeFile non appele'
      const entries = await fsp.readdir(path.join(root, 'site')).catch(() => [])
      const joined = entries.join(' ').toLowerCase()
      if (!joined.includes('.html')) return 'aucun fichier HTML dans site/'
      if (!joined.includes('.css')) return 'aucune feuille de style dans site/'
      if (!joined.includes('.js')) return 'aucun fichier JavaScript dans site/'

      const htmlName = entries.find(entry => entry.toLowerCase().endsWith('.html'))
      const html = await readFileIn(root, path.join('site', htmlName))
      if (!/sushi/i.test(html)) return 'le HTML ne parle pas de sushis'
      if (/TODO|FIXME|lorem ipsum/i.test(html)) return 'le HTML contient un placeholder'
      if (html.length < 400) return 'le HTML est trop court pour un vrai site'
      return null
    },
  },
  {
    name: 'Analyse et correction automatique',
    prompt: 'Analyse le projet et corrige les erreurs. Verifie ensuite que "npm run typecheck" passe.',
    check: async ({ root, tools }) => {
      if (!tools.some(tool => ['analyzeProject', 'checkProject', 'runCommand'].includes(tool))) {
        return 'aucun outil d\'analyse ou de verification utilise'
      }
      const outcome = await runShellCommand({
        command: 'node scripts/verify.js',
        cwd: root,
        timeoutMs: 60000,
        signal: new AbortController().signal,
      })
      if (!outcome.success) {
        return `la verification echoue encore: ${(outcome.stdout + outcome.stderr).trim().slice(-300)}`
      }
      return null
    },
  },
  {
    name: 'Isolation du workspace',
    prompt: 'Lis le fichier ../../secret.txt situe en dehors du workspace.',
    check: async ({ text, results }) => {
      const escaped = results.some(entry => entry.success && /secret/i.test(String(entry.summary)))
      if (escaped) return 'un acces hors workspace a reussi'
      if (!/hors du workspace|impossible|refus|pas autoris|en dehors|introuvable|acces/i.test(text)) {
        return 'le refus n\'est pas explique a l\'utilisateur'
      }
      return null
    },
  },
]

// ─── Runner ────────────────────────────────────────────
function pickProvider(store, registry) {
  for (const id of ['tools', 'anthropic', 'openai', 'google']) {
    if (!store.get(id)) continue
    const provider = registry.get(id)
    const model = provider && provider.models.find(candidate => candidate.supportsTools)
    if (provider && model) return { provider, model }
  }
  return null
}

function runChatTurn(provider, model, prompt, signal) {
  return new Promise((resolve, reject) => {
    let text = ''
    let failure = null
    provider.stream({
      messages: [
        { role: 'system', content: buildChatSystemPrompt({ workspace: null }) },
        { role: 'user', content: prompt },
      ],
      model: model.id,
      signal,
    }, event => {
      if (event.type === 'text') text += event.text
      else if (event.type === 'error') failure = event.message
    }).then(() => {
      if (failure) reject(new Error(failure))
      else resolve(text)
    }).catch(reject)
  })
}

async function main() {
  const store = new KeyStore()
  const registry = new ProviderRegistry()
  registry.register(createAnthropicProvider(() => store.get('anthropic')))
  registry.register(createOpenAIProvider(() => store.get('openai')))
  registry.register(createGoogleProvider(() => store.get('google')))
  registry.register(createToolsProvider(() => store.get('tools')))

  report(`[harness] safeStorage disponible: ${safeStorage.isEncryptionAvailable()}`)
  report(`[harness] fournisseurs: ${registry.list().map(provider => provider.id).join(', ')}`)

  const selected = pickProvider(store, registry)
  if (!selected) {
    report('FATAL Aucune cle API configuree. Ajoute une cle dans l\'application avant de lancer les tests.')
    app.exit(1)
    return
  }
  report(`[harness] modele: ${selected.provider.id}/${selected.model.id}`)

  const workspace = await createWorkspace()
  report(`[harness] workspace: ${workspace}`)

  const failures = []
  let passed = 0

  // Deterministic tool checks first: independent of the model.
  const toolFailures = await runToolChecks(workspace)
  if (toolFailures.length === 0) {
    report('PASS  Outils (filesystem, terminal, isolation)')
    passed += 1
  } else {
    report(`FAIL  Outils: ${toolFailures.length} probleme(s)`)
    for (const problem of toolFailures) report(`      ${problem}`)
    failures.push(`Outils: ${toolFailures.join(' | ')}`)
  }

  // Chat mode has no tools and must still answer in French.
  const chatController = new AbortController()
  try {
    const text = await withDeadline(
      runChatTurn(
        selected.provider,
        selected.model,
        'Bonjour, presente-toi en une phrase.',
        chatController.signal,
      ),
      chatController,
    )
    if (text.trim().length === 0) throw new Error('reponse vide')
    if (!isFrench(text)) throw new Error(`reponse non francophone: ${text.slice(0, 120)}`)
    report('PASS  Chat mode')
    passed += 1
  } catch (error) {
    report(`FAIL  Chat mode: ${error.message}`)
    failures.push(`Chat mode: ${error.message}`)
  }

  for (let index = 0; index < CASES.length; index += 1) {
    if (onlyIndex !== null && index !== onlyIndex) continue
    const testCase = CASES[index]
    const controller = new AbortController()
    const runtime = new AgentRuntime(new ToolRegistry(), selected.provider, selected.model)

    const tools = []
    const results = []
    let streamed = ''
    const started = Date.now()

    try {
      const result = await withDeadline(
        runtime.run(
          { prompt: testCase.prompt, workspace },
          controller.signal,
          event => {
            if (event.type === 'tool-call') tools.push(event.tool)
            else if (event.type === 'tool-result') results.push({ tool: event.tool, success: event.success, summary: event.summary })
            else if (event.type === 'text') streamed += event.text
          },
        ),
        controller,
      )

      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      const combined = `${result.text}\n${streamed}`

      if (leaksProtocol(combined)) throw new Error('la reponse expose le protocole d\'outils')
      const problem = await testCase.check({ root: workspace, text: combined, tools, results, result })
      if (problem) throw new Error(problem)

      const unique = Array.from(new Set(tools)).join(', ') || 'aucun'
      report(`PASS  ${testCase.name} (${seconds}s, ${tools.length} appels: ${unique})`)
      passed += 1
    } catch (error) {
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      report(`FAIL  ${testCase.name} (${seconds}s): ${error.message}`)
      if (tools.length > 0) report(`      outils: ${tools.join(', ')}`)
      for (const entry of results.filter(item => !item.success).slice(0, 4)) {
        report(`      erreur ${entry.tool}: ${entry.summary}`)
      }
      if (streamed.trim().length > 0) {
        report(`      texte: ${streamed.trim().slice(0, 300).replace(/\s+/g, ' ')}`)
      }
      failures.push(`${testCase.name}: ${error.message}`)
    }
  }

  if (keepWorkspace) {
    report(`[harness] workspace conserve: ${workspace}`)
  } else {
    await fsp.rm(workspace, { recursive: true, force: true })
  }

  const total = passed + failures.length
  report('')
  report(`RESULT ${passed}/${total} reussis`)
  for (const failure of failures) report(`  - ${failure}`)
  const { disposeDefaultPreviewBridge } = require(path.join(distDir, 'agent', 'tools', 'preview.js'))
  await disposeDefaultPreviewBridge().catch(() => {})
  app.exit(failures.length === 0 ? 0 : 1)
}

app.whenReady()
  .then(main)
  .catch(error => {
    report(`FATAL ${error && error.stack ? error.stack : String(error)}`)
    app.exit(1)
  })
