/**
 * Provider protocol tests.
 *
 * Each provider is exercised against a local HTTP server that speaks the real
 * wire format (Anthropic messages SSE, OpenAI chat completions SSE, Gemini
 * streamGenerateContent SSE). Verifies request shaping, streamed text, native
 * tool-call assembly, error surfacing and abort handling without touching the
 * network or spending tokens.
 *
 * Usage: node scripts/test-providers.cjs
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist-electron')

if (!fs.existsSync(path.join(distDir, 'providers', 'registry.js'))) {
  console.error('FATAL dist-electron absent. Lance "npm run build".')
  process.exit(1)
}

const { ProviderRegistry } = require(path.join(distDir, 'providers', 'registry.js'))
const { createAnthropicProvider } = require(path.join(distDir, 'providers', 'anthropic.js'))
const { createOpenAIProvider } = require(path.join(distDir, 'providers', 'openai.js'))
const { createGoogleProvider } = require(path.join(distDir, 'providers', 'google.js'))
const { createToolsProvider } = require(path.join(distDir, 'providers', 'tools.js'))
const { createOpenAICompatibleProvider } = require(path.join(distDir, 'providers', 'openai-compatible.js'))

const problems = []
function check(condition, message) {
  if (!condition) problems.push(message)
}

const TOOL_SCHEMA = {
  name: 'readFile',
  description: 'Lit un fichier.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'chemin' } },
    required: ['path'],
    additionalProperties: false,
  },
}

// ─── Mock server ───────────────────────────────────────
const scenarios = new Map()
let lastRequest = null

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  const scenario = scenarios.get(url.pathname)
  let body = ''
  request.setEncoding('utf8')
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    lastRequest = {
      pathname: url.pathname,
      search: url.search,
      headers: request.headers,
      body: body.length > 0 ? JSON.parse(body) : null,
    }
    if (!scenario) {
      response.writeHead(404).end('unknown scenario')
      return
    }
    scenario(response)
  })
})

function sse(lines, status = 200) {
  return response => {
    response.writeHead(status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let index = 0
    const push = () => {
      if (index >= lines.length) {
        response.end()
        return
      }
      response.write(`data: ${JSON.stringify(lines[index])}\n\n`)
      index += 1
      setTimeout(push, 5)
    }
    push()
  }
}

function httpError(status, payload) {
  return response => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  }
}

/** Streams forever so the abort path can be exercised. */
function neverEnding() {
  return response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const timer = setInterval(() => {
      response.write(`data: ${JSON.stringify({ keepalive: true })}\n\n`)
    }, 40)
    response.on('close', () => clearInterval(timer))
  }
}

function collect(provider, request) {
  return new Promise((resolve, reject) => {
    const events = []
    provider.stream(request, event => events.push(event))
      .then(() => resolve(events))
      .catch(reject)
  })
}

function textOf(events) {
  return events.filter(event => event.type === 'text').map(event => event.text).join('')
}

function callsOf(events) {
  return events.filter(event => event.type === 'tool-call').map(event => event.call)
}

function errorOf(events) {
  const error = events.find(event => event.type === 'error')
  return error ? error.message : null
}

function doneOf(events) {
  const done = events.find(event => event.type === 'done')
  return done ? done.reason : null
}

// ─── Provider factories bound to the mock server ───────
/**
 * The OpenAI-compatible adapter takes its URL as an option. The Anthropic and
 * Google adapters hardcode their endpoints, so those two are redirected by
 * rewriting global fetch (see installFetchRewrite).
 */
function providersFor(port) {
  const base = `http://127.0.0.1:${port}`
  return {
    openai: createOpenAICompatibleProvider({
      id: 'openai-mock',
      name: 'OpenAI',
      apiUrl: `${base}/openai`,
      models: [{ id: 'gpt-4o', label: 'GPT-4o', supportsTools: true }],
      getKey: () => 'sk-mock-openai',
      missingKeyMessage: 'cle absente',
    }),
    openaiNoKey: createOpenAICompatibleProvider({
      id: 'openai-nokey',
      name: 'OpenAI',
      apiUrl: `${base}/openai`,
      models: [{ id: 'gpt-4o', label: 'GPT-4o', supportsTools: true }],
      getKey: () => null,
      missingKeyMessage: 'Cle API OpenAI absente.',
    }),
    anthropic: createAnthropicProvider(() => 'sk-mock-anthropic'),
    google: createGoogleProvider(() => 'mock-google-key'),
  }
}

function installFetchRewrite(port) {
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.startsWith('https://api.anthropic.com/v1/messages')) {
      return original(`http://127.0.0.1:${port}/anthropic`, init)
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const query = url.slice(url.indexOf('?'))
      return original(`http://127.0.0.1:${port}/google${query}`, init)
    }
    if (url.startsWith('https://api.openai.com/v1/chat/completions')) {
      return original(`http://127.0.0.1:${port}/openai`, init)
    }
    if (url.startsWith('https://top-tools-ai.com/api/v1/chat/completions')) {
      return original(`http://127.0.0.1:${port}/openai`, init)
    }
    return original(input, init)
  }
  return () => { globalThis.fetch = original }
}

// ─── Tests ─────────────────────────────────────────────
async function testRegistry() {
  const registry = new ProviderRegistry()
  registry.register(createAnthropicProvider(() => null))
  registry.register(createOpenAIProvider(() => null))
  registry.register(createGoogleProvider(() => null))
  registry.register(createToolsProvider(() => null))

  check(registry.list().length === 4, 'la registry devrait contenir 4 fournisseurs')
  check(registry.get('anthropic') !== undefined, 'anthropic introuvable dans la registry')
  check(registry.resolveModel('inconnu') === null, 'resolveModel devrait renvoyer null pour un modele inconnu')

  for (const provider of registry.list()) {
    check(provider.models.length > 0, `${provider.id} n'expose aucun modele`)
    check(provider.models.every(model => model.supportsTools),
      `${provider.id} expose un modele sans support des outils`)
    const first = provider.models[0]
    const resolved = registry.resolveModel(first.id)
    check(resolved !== null && resolved.provider.id === provider.id,
      `resolveModel ne retrouve pas ${first.id} pour ${provider.id}`)
  }

  let duplicated = false
  try {
    registry.register(createOpenAIProvider(() => null))
  } catch {
    duplicated = true
  }
  check(duplicated, 'la registry accepte un fournisseur en double')

  // Every provider must refuse to run without a key, with a clear French
  // message : soit une demande de cle, soit le message administrateur
  // (provisioning via admin-keys.json) — les deux etant valides.
  for (const provider of registry.list()) {
    const events = await collect(provider, {
      messages: [{ role: 'user', content: 'test' }],
      model: provider.models[0].id,
      signal: new AbortController().signal,
    })
    const error = errorOf(events)
    const keyMessage = typeof error === 'string' && /cl[eé]/i.test(error)
    const adminMessage = typeof error === 'string' && /administrateur/i.test(error)
    check(keyMessage || adminMessage,
      `${provider.id} ne signale pas clairement l'absence de cle (${error})`)
  }
}

async function testOpenAIFamily(providers) {
  // Streamed text.
  scenarios.set('/openai', sse([
    { choices: [{ delta: { role: 'assistant', content: 'Bonjour' } }] },
    { choices: [{ delta: { content: ' le' } }] },
    { choices: [{ delta: { content: ' monde' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]))

  let events = await collect(providers.openai, {
    messages: [
      { role: 'system', content: 'systeme' },
      { role: 'user', content: 'salut' },
    ],
    model: 'gpt-4o',
    tools: [TOOL_SCHEMA],
    signal: new AbortController().signal,
  })
  check(textOf(events) === 'Bonjour le monde', `OpenAI texte incorrect: ${textOf(events)}`)
  check(doneOf(events) === 'stop', `OpenAI raison d'arret incorrecte: ${doneOf(events)}`)
  check(lastRequest.headers.authorization === 'Bearer sk-mock-openai', 'OpenAI n\'envoie pas l\'en-tete Authorization')
  check(lastRequest.body.stream === true, 'OpenAI ne demande pas le streaming')
  check(Array.isArray(lastRequest.body.tools) && lastRequest.body.tools[0].function.name === 'readFile',
    'OpenAI ne transmet pas les outils au bon format')
  check(lastRequest.body.tool_choice === 'auto', 'OpenAI ne definit pas tool_choice')
  check(lastRequest.body.messages[0].role === 'system', 'OpenAI ne conserve pas le message systeme')

  // Fragmented tool call across deltas.
  scenarios.set('/openai', sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'readFile', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"src/a.ts"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'readFile', arguments: '{"path":"src/b.ts"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]))

  events = await collect(providers.openai, {
    messages: [{ role: 'user', content: 'lis' }],
    model: 'gpt-4o',
    tools: [TOOL_SCHEMA],
    signal: new AbortController().signal,
  })
  const calls = callsOf(events)
  check(calls.length === 2, `OpenAI devrait produire 2 appels d'outil (recu ${calls.length})`)
  check(calls[0] && calls[0].id === 'call_a' && calls[0].name === 'readFile', 'OpenAI: premier appel mal assemble')
  check(calls[0] && JSON.parse(calls[0].arguments).path === 'src/a.ts',
    `OpenAI: arguments fragmentes mal reassembles (${calls[0] && calls[0].arguments})`)
  check(calls[1] && JSON.parse(calls[1].arguments).path === 'src/b.ts', 'OpenAI: second appel mal assemble')
  check(doneOf(events) === 'tool-calls', 'OpenAI ne signale pas un tour d\'outils')

  // Assistant turn carrying tool calls plus a tool result round-trip.
  scenarios.set('/openai', sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
  await collect(providers.openai, {
    messages: [
      { role: 'user', content: 'lis' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'readFile', arguments: '{"path":"x"}' }] },
      { role: 'tool', toolCallId: 'call_a', toolName: 'readFile', content: 'contenu' },
    ],
    model: 'gpt-4o',
    tools: [TOOL_SCHEMA],
    signal: new AbortController().signal,
  })
  const assistantTurn = lastRequest.body.messages[1]
  const toolTurn = lastRequest.body.messages[2]
  check(assistantTurn.tool_calls && assistantTurn.tool_calls[0].id === 'call_a',
    'OpenAI ne renvoie pas les tool_calls de l\'assistant')
  check(assistantTurn.content === null, 'OpenAI devrait envoyer content=null pour un tour d\'outils vide')
  check(toolTurn.role === 'tool' && toolTurn.tool_call_id === 'call_a',
    'OpenAI ne mappe pas le resultat d\'outil sur tool_call_id')

  // HTTP error surfaces as a single French-prefixed error event.
  scenarios.set('/openai', httpError(429, { error: { message: 'rate limited' } }))
  events = await collect(providers.openai, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gpt-4o',
    signal: new AbortController().signal,
  })
  check(events.filter(event => event.type === 'error').length === 1, 'OpenAI emet plusieurs erreurs')
  check(/429/.test(errorOf(events)), `OpenAI ne remonte pas le code HTTP (${errorOf(events)})`)
  check(doneOf(events) === null, 'OpenAI emet done apres une erreur')

  // In-band error object.
  scenarios.set('/openai', sse([{ error: { message: 'quota depasse' } }]))
  events = await collect(providers.openai, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gpt-4o',
    signal: new AbortController().signal,
  })
  check(/quota depasse/.test(errorOf(events) || ''), 'OpenAI ignore une erreur dans le flux')

  // Missing key.
  events = await collect(providers.openaiNoKey, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gpt-4o',
    signal: new AbortController().signal,
  })
  check(/Cle API OpenAI absente/.test(errorOf(events) || ''), 'le message de cle manquante n\'est pas transmis')

  // Abort must resolve silently, with no error and no done.
  scenarios.set('/openai', neverEnding())
  const controller = new AbortController()
  const pending = collect(providers.openai, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gpt-4o',
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 200)
  const aborted = await pending
  check(errorOf(aborted) === null, `une annulation ne doit pas produire d'erreur (${errorOf(aborted)})`)
  check(doneOf(aborted) === null, 'une annulation ne doit pas produire done')
}

async function testAnthropic(providers) {
  scenarios.set('/anthropic', sse([
    { type: 'message_start' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Salut ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'toi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'readFile' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"src/x.ts"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]))

  const events = await collect(providers.anthropic, {
    messages: [
      { role: 'system', content: 'consignes' },
      { role: 'user', content: 'lis le fichier' },
      { role: 'assistant', content: 'je regarde', toolCalls: [{ id: 'toolu_0', name: 'readFile', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'toolu_0', toolName: 'readFile', content: 'contenu de a' },
    ],
    model: 'claude-sonnet-4-5-20250929',
    tools: [TOOL_SCHEMA],
    signal: new AbortController().signal,
  })

  check(textOf(events) === 'Salut toi', `Anthropic texte incorrect: ${textOf(events)}`)
  const calls = callsOf(events)
  check(calls.length === 1 && calls[0].name === 'readFile', 'Anthropic n\'a pas produit l\'appel d\'outil')
  check(calls[0] && JSON.parse(calls[0].arguments).path === 'src/x.ts',
    `Anthropic: input_json_delta mal reassemble (${calls[0] && calls[0].arguments})`)
  check(doneOf(events) === 'tool-calls', 'Anthropic ne signale pas un tour d\'outils')

  check(lastRequest.headers['x-api-key'] === 'sk-mock-anthropic', 'Anthropic n\'envoie pas x-api-key')
  check(lastRequest.headers['anthropic-version'] === '2023-06-01', 'Anthropic n\'envoie pas anthropic-version')
  check(lastRequest.body.system === 'consignes', 'Anthropic ne place pas le systeme dans le champ system')
  check(!lastRequest.body.messages.some(message => message.role === 'system'),
    'Anthropic laisse un message system dans la conversation')
  check(lastRequest.body.messages[0].role === 'user', 'Anthropic: la conversation doit commencer par user')
  check(lastRequest.body.tools[0].input_schema.type === 'object', 'Anthropic ne convertit pas le schema en input_schema')

  const assistant = lastRequest.body.messages.find(message => message.role === 'assistant')
  check(assistant && assistant.content.some(block => block.type === 'tool_use' && block.id === 'toolu_0'),
    'Anthropic ne renvoie pas le bloc tool_use')
  const resultBlock = lastRequest.body.messages
    .flatMap(message => message.content)
    .find(block => block.type === 'tool_result')
  check(resultBlock && resultBlock.tool_use_id === 'toolu_0', 'Anthropic ne mappe pas tool_result sur tool_use_id')

  // In-band error event.
  scenarios.set('/anthropic', sse([{ type: 'error', error: { message: 'overloaded' } }]))
  const failed = await collect(providers.anthropic, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'claude-sonnet-4-5-20250929',
    signal: new AbortController().signal,
  })
  check(/overloaded/.test(errorOf(failed) || ''), 'Anthropic ignore une erreur dans le flux')
}

async function testGoogle(providers) {
  scenarios.set('/google', sse([
    { candidates: [{ content: { parts: [{ text: 'Voici ' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'la reponse' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'readFile', args: { path: 'src/y.ts' } } }] }, finishReason: 'STOP' }] },
  ]))

  const events = await collect(providers.google, {
    messages: [
      { role: 'system', content: 'consignes' },
      { role: 'user', content: 'lis' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'readFile', arguments: '{"path":"a"}' }] },
      { role: 'tool', toolCallId: 'call_1', toolName: 'readFile', content: 'contenu' },
    ],
    model: 'gemini-2.5-flash',
    tools: [TOOL_SCHEMA],
    signal: new AbortController().signal,
  })

  check(textOf(events) === 'Voici la reponse', `Gemini texte incorrect: ${textOf(events)}`)
  const calls = callsOf(events)
  check(calls.length === 1 && calls[0].name === 'readFile', 'Gemini n\'a pas produit l\'appel d\'outil')
  check(calls[0] && JSON.parse(calls[0].arguments).path === 'src/y.ts', 'Gemini: arguments mal convertis')
  check(doneOf(events) === 'tool-calls', 'Gemini ne signale pas un tour d\'outils')

  check(/alt=sse/.test(lastRequest.search), 'Gemini ne demande pas le mode SSE')
  check(/key=mock-google-key/.test(lastRequest.search), 'Gemini ne transmet pas la cle en query')
  check(lastRequest.body.systemInstruction.parts[0].text === 'consignes',
    'Gemini ne place pas le systeme dans systemInstruction')
  const declaration = lastRequest.body.tools[0].functionDeclarations[0]
  check(declaration.name === 'readFile', 'Gemini ne declare pas la fonction')
  check(declaration.parameters.type === 'OBJECT', 'Gemini ne met pas le type de schema en majuscules')
  check(declaration.parameters.additionalProperties === undefined,
    'Gemini ne doit pas recevoir additionalProperties')
  const modelTurn = lastRequest.body.contents.find(content => content.role === 'model')
  check(modelTurn && modelTurn.parts.some(part => part.functionCall), 'Gemini ne renvoie pas functionCall')
  const responsePart = lastRequest.body.contents
    .flatMap(content => content.parts)
    .find(part => part.functionResponse)
  check(responsePart && responsePart.functionResponse.name === 'readFile',
    'Gemini ne mappe pas functionResponse sur le nom de l\'outil')

  scenarios.set('/google', httpError(400, { error: { message: 'requete invalide' } }))
  const failed = await collect(providers.google, {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gemini-2.5-flash',
    signal: new AbortController().signal,
  })
  check(/400/.test(errorOf(failed) || ''), 'Gemini ne remonte pas le code HTTP')
}

void (async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const restoreFetch = installFetchRewrite(port)
  const providers = providersFor(port)

  try {
    await testRegistry()
    await testOpenAIFamily(providers)
    await testAnthropic(providers)
    await testGoogle(providers)
  } catch (error) {
    problems.push(error && error.stack ? error.stack : String(error))
  } finally {
    restoreFetch()
    server.close()
  }

  console.log('=== Providers ===')
  if (problems.length === 0) {
    console.log('PASS  Providers (Anthropic, OpenAI, Google, Top Tools AI)')
    process.exit(0)
  }
  console.log(`FAIL  Providers: ${problems.length} probleme(s)`)
  for (const problem of problems) console.log(`      ${problem}`)
  process.exit(1)
})()
