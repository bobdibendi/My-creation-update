/**
 * Agent runtime tests.
 *
 * Drives the real agentic loop against a scripted provider so every control
 * path is verified deterministically: multi-turn tool calling, parallel calls,
 * tool errors fed back to the model, self-correction, abort, empty responses,
 * turn budget exhaustion and the absence of any wall-clock timeout.
 *
 * Usage: node scripts/test-runtime.cjs
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist-electron')

if (!fs.existsSync(path.join(distDir, 'agent', 'runtime.js'))) {
  console.error('FATAL dist-electron absent. Lance "npm run build".')
  process.exit(1)
}

const { AgentRuntime } = require(path.join(distDir, 'agent', 'runtime.js'))
const { ToolRegistry } = require(path.join(distDir, 'agent', 'registry.js'))
const { buildSystemPrompt, buildChatSystemPrompt, formatToolResult } = require(path.join(distDir, 'agent', 'prompt.js'))

const problems = []
function check(condition, message) {
  if (!condition) problems.push(message)
}

const MODEL = { id: 'mock-model', label: 'Mock', supportsTools: true }

/**
 * Provider driven by a list of scripted turns. Each turn is either
 * `{ text }`, `{ calls: [...] }`, `{ error }` or `{ hang: true }`.
 */
function scriptedProvider(turns, options = {}) {
  const seen = []
  let index = 0

  return {
    provider: {
      id: 'mock',
      name: 'Mock',
      models: [MODEL],
      async stream(request, onEvent) {
        seen.push({
          messages: request.messages.map(message => ({
            role: message.role,
            content: message.content,
            toolCalls: message.toolCalls,
            toolCallId: message.toolCallId,
          })),
          tools: request.tools ? request.tools.map(tool => tool.name) : null,
        })

        const turn = turns[Math.min(index, turns.length - 1)]
        index += 1

        if (turn.hang) {
          // Resolves only when the caller aborts: proves there is no timeout.
          await new Promise(resolve => {
            if (request.signal.aborted) { resolve(); return }
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return
        }

        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))

        if (turn.error) {
          onEvent({ type: 'error', message: turn.error })
          return
        }

        for (const chunk of turn.text ? [turn.text] : []) {
          onEvent({ type: 'text', text: chunk })
        }
        for (const call of turn.calls || []) {
          onEvent({ type: 'tool-call', call })
        }
        onEvent({ type: 'done', reason: (turn.calls || []).length > 0 ? 'tool-calls' : 'stop' })
      },
    },
    seen,
    get turnCount() { return index },
  }
}

function callOf(id, name, args) {
  return { id, name, arguments: JSON.stringify(args) }
}

async function withWorkspace(run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-runtime-'))
  try {
    await run(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

function runAgent(runtime, input, signal) {
  const events = []
  return runtime.run(input, signal, event => events.push(event)).then(
    result => ({ result, events }),
    error => ({ error, events }),
  )
}

// ─── Cases ─────────────────────────────────────────────
async function testSingleTurn() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ text: 'Bonjour, voici ma reponse.' }])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error, events } = await runAgent(runtime, { prompt: 'Bonjour', workspace }, new AbortController().signal)

    check(!error, `un tour simple ne doit pas echouer (${error && error.message})`)
    check(result && result.text === 'Bonjour, voici ma reponse.', 'le texte final est incorrect')
    check(result && result.turns === 1, `un seul tour attendu (recu ${result && result.turns})`)
    check(result && result.toolCalls === 0, 'aucun appel d\'outil attendu')
    check(result && result.filesChanged === false, 'aucune modification de fichier attendue')
    check(events.some(event => event.type === 'text'), 'le texte doit etre diffuse en streaming')
    check(events.some(event => event.type === 'status'), 'un statut doit etre emis')

    const first = mock.seen[0]
    check(first.messages[0].role === 'system', 'le prompt systeme doit etre le premier message')
    check(/fran[cç]ais/i.test(first.messages[0].content), 'le prompt systeme doit imposer le francais')
    check(first.messages[0].content.includes(workspace), 'le prompt systeme doit contenir la racine du workspace')
    check(Array.isArray(first.tools) && first.tools.includes('readFile'),
      'les schemas d\'outils doivent etre transmis au fournisseur')
  })
}

async function testToolLoop() {
  await withWorkspace(async workspace => {
    await fsp.writeFile(path.join(workspace, 'a.txt'), 'contenu a', 'utf8')

    const mock = scriptedProvider([
      { text: 'Je lis le fichier.', calls: [callOf('c1', 'readFile', { path: 'a.txt' })] },
      { calls: [callOf('c2', 'writeFile', { path: 'b.txt', content: 'copie' })] },
      { text: 'J\'ai lu a.txt et cree b.txt.' },
    ])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error, events } = await runAgent(runtime, { prompt: 'Copie a.txt', workspace }, new AbortController().signal)

    check(!error, `la boucle d'outils ne doit pas echouer (${error && error.message})`)
    check(result && result.turns === 3, `3 tours attendus (recu ${result && result.turns})`)
    check(result && result.toolCalls === 2, `2 appels attendus (recu ${result && result.toolCalls})`)
    check(result && result.filesChanged === true, 'writeFile doit marquer les fichiers comme modifies')
    check(await fsp.readFile(path.join(workspace, 'b.txt'), 'utf8') === 'copie', 'b.txt n\'a pas le bon contenu')

    check(events.filter(event => event.type === 'tool-call').length === 2, 'deux evenements tool-call attendus')
    check(events.filter(event => event.type === 'tool-result').length === 2, 'deux evenements tool-result attendus')
    check(events.some(event => event.type === 'files-changed'), 'un evenement files-changed est attendu')
    check(events.filter(event => event.type === 'tool-result').every(event => event.success),
      'les deux outils devaient reussir')

    // The transcript sent on turn 2 must carry the assistant tool call and its result.
    const second = mock.seen[1]
    const assistant = second.messages.find(message => message.role === 'assistant' && message.toolCalls)
    const toolResult = second.messages.find(message => message.role === 'tool')
    check(assistant && assistant.toolCalls[0].id === 'c1', 'l\'appel d\'outil doit etre reinjecte dans l\'historique')
    check(toolResult && toolResult.toolCallId === 'c1', 'le resultat doit referencer l\'identifiant d\'appel')
    check(toolResult && /contenu a/.test(toolResult.content), 'le resultat doit contenir le contenu lu')
  })
}

async function testParallelCalls() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([
      {
        calls: [
          callOf('p1', 'writeFile', { path: 'un.txt', content: '1' }),
          callOf('p2', 'writeFile', { path: 'deux.txt', content: '2' }),
          callOf('p3', 'createDirectory', { path: 'trois' }),
        ],
      },
      { text: 'Trois elements crees.' },
    ])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error } = await runAgent(runtime, { prompt: 'Cree trois choses', workspace }, new AbortController().signal)

    check(!error, `les appels multiples ne doivent pas echouer (${error && error.message})`)
    check(result && result.toolCalls === 3, `3 appels attendus (recu ${result && result.toolCalls})`)
    check(fs.existsSync(path.join(workspace, 'un.txt')), 'un.txt manquant')
    check(fs.existsSync(path.join(workspace, 'deux.txt')), 'deux.txt manquant')
    check(fs.statSync(path.join(workspace, 'trois')).isDirectory(), 'le dossier trois manque')

    const second = mock.seen[1]
    const toolMessages = second.messages.filter(message => message.role === 'tool')
    check(toolMessages.length === 3, 'les trois resultats doivent etre transmis au fournisseur')
  })
}

async function testToolErrorRecovery() {
  await withWorkspace(async workspace => {
    await fsp.writeFile(path.join(workspace, 'reel.txt'), 'ok', 'utf8')

    const mock = scriptedProvider([
      { calls: [callOf('e1', 'readFile', { path: 'absent.txt' })] },
      { calls: [callOf('e2', 'readFile', { path: 'reel.txt' })] },
      { text: 'Le premier chemin etait faux, j\'ai lu reel.txt.' },
    ])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error, events } = await runAgent(runtime, { prompt: 'Lis un fichier', workspace }, new AbortController().signal)

    check(!error, `une erreur d'outil ne doit pas interrompre la boucle (${error && error.message})`)
    check(result && result.turns === 3, 'la boucle doit continuer apres une erreur d\'outil')

    const failed = events.find(event => event.type === 'tool-result' && !event.success)
    check(failed !== undefined, 'l\'echec d\'outil doit etre signale')
    check(failed && /introuvable/i.test(failed.summary), `le message d'erreur doit etre explicite (${failed && failed.summary})`)

    const second = mock.seen[1]
    const toolMessage = second.messages.find(message => message.role === 'tool')
    check(toolMessage && /^ERREUR:/.test(toolMessage.content), 'l\'erreur doit etre renvoyee au modele prefixee par ERREUR')
  })
}

async function testUnknownTool() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([
      { calls: [callOf('u1', 'outilInexistant', {})] },
      { text: 'J\'ai utilise un outil inconnu, voici la suite.' },
    ])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error, events } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)

    check(!error, 'un outil inconnu ne doit pas faire echouer la session')
    check(result !== undefined, 'la session doit aboutir')
    const failed = events.find(event => event.type === 'tool-result' && !event.success)
    check(failed && /Outil inconnu/i.test(failed.summary), 'l\'outil inconnu doit etre signale au modele')
  })
}

async function testProviderError() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ error: 'Anthropic: HTTP 401' }])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { error } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)

    check(error !== undefined, 'une erreur du fournisseur doit remonter')
    check(error && /401/.test(error.message), `le message d'erreur doit etre conserve (${error && error.message})`)
  })
}

async function testAbort() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ hang: true }])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const controller = new AbortController()

    const started = Date.now()
    setTimeout(() => controller.abort(), 400)
    const { error } = await runAgent(runtime, { prompt: 'test', workspace }, controller.signal)
    const elapsed = Date.now() - started

    check(elapsed < 20000, `l'annulation doit etre immediate (${elapsed}ms)`)
    check(error !== undefined, 'une session annulee doit rejeter')
  })
}

/**
 * A slow provider turn must not be cut short: there is no artificial
 * `Provider.plan() timed out` deadline anywhere in the loop.
 */
async function testNoTimeout() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ text: 'Reponse tardive.' }], { delayMs: 6000 })
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)

    const started = Date.now()
    const { result, error } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)
    const elapsed = Date.now() - started

    check(!error, `un tour lent ne doit pas echouer (${error && error.message})`)
    check(result && result.text === 'Reponse tardive.', 'la reponse tardive doit etre conservee')
    check(elapsed >= 5500, `le tour devait durer au moins 5,5s (${elapsed}ms)`)
  })
}

async function testEmptyResponseRecovery() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([
      { text: '' },
      { text: 'Voici finalement ma reponse.' },
    ])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { result, error } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)

    check(!error, 'une reponse vide doit etre relancee, pas rejetee')
    check(result && result.text === 'Voici finalement ma reponse.', 'la relance doit produire la reponse finale')

    const second = mock.seen[1]
    const last = second.messages[second.messages.length - 1]
    check(last.role === 'user' && /r[eé]sum/i.test(last.content),
      'la relance doit demander explicitement une reponse ecrite')
  })
}

async function testPersistentEmptyResponses() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ text: '' }])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)
    const { error } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)

    check(error !== undefined, 'un modele toujours vide doit finir par echouer')
    check(error && /aucune r[eé]ponse/i.test(error.message), `message inattendu (${error && error.message})`)
    check(mock.turnCount <= 6, `le nombre de relances doit rester borne (${mock.turnCount})`)
  })
}

async function testTurnBudget() {
  await withWorkspace(async workspace => {
    // Always asks for a tool, never concludes: the loop must wrap up on its own.
    const mock = scriptedProvider([{ calls: [callOf('loop', 'pathExists', { path: '.' })] }])
    let wrapUpRequested = false

    const provider = {
      id: 'mock',
      name: 'Mock',
      models: [MODEL],
      async stream(request, onEvent) {
        const last = request.messages[request.messages.length - 1]
        if (last.role === 'user' && /budget/i.test(last.content)) {
          wrapUpRequested = true
          check(request.tools === undefined, 'la synthese finale ne doit pas exposer d\'outils')
          onEvent({ type: 'text', text: 'Resume: budget atteint.' })
          onEvent({ type: 'done', reason: 'stop' })
          return
        }
        return mock.provider.stream(request, onEvent)
      },
    }

    const runtime = new AgentRuntime(new ToolRegistry(), provider, MODEL)
    const { result, error } = await runAgent(runtime, { prompt: 'boucle', workspace }, new AbortController().signal)

    check(!error, `l'epuisement du budget ne doit pas echouer (${error && error.message})`)
    check(wrapUpRequested, 'une synthese finale doit etre demandee')
    check(result && /budget atteint/i.test(result.text), 'la synthese finale doit etre renvoyee')
    check(result && result.turns === 60, `le budget doit valoir 60 tours (recu ${result && result.turns})`)
  })
}

async function testHistoryAndActiveFile() {
  await withWorkspace(async workspace => {
    await fsp.writeFile(path.join(workspace, 'ouvert.ts'), 'export const x = 1\n', 'utf8')
    const mock = scriptedProvider([{ text: 'Compris.' }])
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, MODEL)

    await runAgent(runtime, {
      prompt: 'Et maintenant ?',
      workspace,
      activeFilePath: 'ouvert.ts',
      activeFileExcerpt: 'export const x = 1',
      history: [
        { role: 'user', content: 'Question precedente' },
        { role: 'assistant', content: 'Reponse precedente' },
        { role: 'user', content: '   ' },
      ],
    }, new AbortController().signal)

    const sent = mock.seen[0].messages
    check(sent[0].content.includes('ouvert.ts'), 'le fichier actif doit apparaitre dans le prompt systeme')
    check(sent[0].content.includes('export const x = 1'), 'l\'extrait du fichier actif doit etre transmis')
    check(sent.some(message => message.content === 'Question precedente'), 'l\'historique utilisateur doit etre transmis')
    check(sent.some(message => message.content === 'Reponse precedente'), 'l\'historique assistant doit etre transmis')
    check(!sent.some(message => message.content.trim() === '' && message.role !== 'assistant'),
      'les messages vides de l\'historique doivent etre ignores')
    check(sent[sent.length - 1].content === 'Et maintenant ?', 'la demande courante doit etre le dernier message')
  })
}

async function testHistoryTrimming() {
  await withWorkspace(async workspace => {
    // Forces many turns so the transcript exceeds the trimming threshold.
    let turn = 0
    const provider = {
      id: 'mock',
      name: 'Mock',
      models: [MODEL],
      async stream(request, onEvent) {
        turn += 1
        const messages = request.messages
        check(messages[0].role === 'system', `le message systeme doit rester en tete (tour ${turn})`)
        const firstNonSystem = messages.find(message => message.role !== 'system')
        check(firstNonSystem === undefined || firstNonSystem.role !== 'tool',
          `un resultat d'outil ne doit jamais ouvrir la conversation (tour ${turn})`)
        check(messages.length <= 62, `l'historique doit rester borne (${messages.length} messages au tour ${turn})`)

        if (turn >= 40) {
          onEvent({ type: 'text', text: 'Termine.' })
          onEvent({ type: 'done', reason: 'stop' })
          return
        }
        onEvent({ type: 'tool-call', call: callOf(`t${turn}`, 'pathExists', { path: '.' }) })
        onEvent({ type: 'done', reason: 'tool-calls' })
      },
    }

    const runtime = new AgentRuntime(new ToolRegistry(), provider, MODEL)
    const { result, error } = await runAgent(runtime, { prompt: 'boucle longue', workspace }, new AbortController().signal)

    check(!error, `une longue session ne doit pas echouer (${error && error.message})`)
    check(result && result.toolCalls === 39, `39 appels attendus (recu ${result && result.toolCalls})`)
  })
}

async function testModelWithoutTools() {
  await withWorkspace(async workspace => {
    const mock = scriptedProvider([{ text: 'x' }])
    const chatOnly = { id: 'chat-only', label: 'Chat seul', supportsTools: false }
    const runtime = new AgentRuntime(new ToolRegistry(), mock.provider, chatOnly)
    const { error } = await runAgent(runtime, { prompt: 'test', workspace }, new AbortController().signal)

    check(error !== undefined, 'un modele sans outils doit etre refuse en mode Agent')
    check(error && /ne supporte pas les outils/i.test(error.message), `message inattendu (${error && error.message})`)
  })
}

function testPrompts() {
  const agentPrompt = buildSystemPrompt({
    workspace: 'C:\\projet',
    toolNames: ['readFile', 'writeFile'],
    platform: 'win32 (x64)',
  })
  check(/TOUJOURS en fran[cç]ais/i.test(agentPrompt), 'le prompt agent doit imposer le francais')
  check(agentPrompt.includes('readFile, writeFile'), 'le prompt agent doit lister les outils')
  check(/checkProject/.test(agentPrompt), 'le prompt agent doit mentionner la boucle de correction')
  check(/pas de TODO/i.test(agentPrompt), 'le prompt agent doit interdire les placeholders')

  const chatPrompt = buildChatSystemPrompt({ workspace: 'C:\\projet', activeFilePath: 'a.ts', activeFileExcerpt: 'const a = 1' })
  check(/TOUJOURS en fran[cç]ais/i.test(chatPrompt), 'le prompt chat doit imposer le francais')
  check(/mode Agent/i.test(chatPrompt), 'le prompt chat doit rediriger vers le mode Agent pour les actions')
  check(chatPrompt.includes('const a = 1'), 'le prompt chat doit inclure l\'extrait fourni')

  const long = formatToolResult({ data: 'x'.repeat(50000) })
  check(long.length < 30000, 'formatToolResult doit tronquer les gros resultats')
  check(/tronqu/i.test(long), 'la troncature doit etre signalee')
  check(formatToolResult('texte simple') === 'texte simple', 'formatToolResult doit laisser passer une chaine courte')
}

void (async () => {
  const cases = [
    testSingleTurn,
    testToolLoop,
    testParallelCalls,
    testToolErrorRecovery,
    testUnknownTool,
    testProviderError,
    testAbort,
    testNoTimeout,
    testEmptyResponseRecovery,
    testPersistentEmptyResponses,
    testTurnBudget,
    testHistoryAndActiveFile,
    testHistoryTrimming,
    testModelWithoutTools,
  ]

  for (const testCase of cases) {
    try {
      await testCase()
    } catch (error) {
      problems.push(`${testCase.name}: ${error && error.stack ? error.stack : String(error)}`)
    }
  }

  try {
    testPrompts()
  } catch (error) {
    problems.push(`testPrompts: ${error && error.stack ? error.stack : String(error)}`)
  }

  console.log('=== Runtime ===')
  if (problems.length === 0) {
    console.log(`PASS  Boucle agentique (${cases.length + 1} scenarios)`)
    process.exit(0)
  }
  console.log(`FAIL  Runtime: ${problems.length} probleme(s)`)
  for (const problem of problems) console.log(`      ${problem}`)
  process.exit(1)
})()
