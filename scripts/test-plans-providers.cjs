#!/usr/bin/env node
/**
 * Tests du système de fournisseurs MY CREATION :
 *   - configuration centrale (Kim Pro / Ox Alpha) : labels exposés,
 *     identité réelle masquée, mapping apiModel ;
 *   - ProviderFallbackManager : bascule uniquement sur erreur temporaire et
 *     avant tout octet diffusé ;
 *   - taxonomie d'erreurs (describeError) ;
 *   - matrice de permissions FREE / PRO / PRO ULTIMATE ;
 *   - licence type pro_ultimate vérifiée avec la vraie clé publique RS256.
 *
 * Usage : node scripts/test-plans-providers.cjs   (après npm run build)
 */
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

let passCount = 0
let failCount = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
    passCount++
  } else {
    console.error(`FAIL  ${name}${detail ? ` (${detail})` : ''}`)
    failCount++
  }
}

// ── Chargement des modules compilés ───────────────────────────────────────
const distDir = path.resolve(__dirname, '..', 'dist-electron')
for (const file of ['config/ai-providers.js', 'fallback.js', 'errors.js', 'plans.js', 'providers/tools.js', 'providers/opencode-zen.js']) {
  if (!fs.existsSync(path.join(distDir, file))) {
    console.error(`FATAL dist-electron/${file} absent. Lance "npm run build".`)
    process.exit(1)
  }
}
const { KIM_PRO, OX_ALPHA_FREE, readEnvKeys } = require(path.join(distDir, 'config', 'ai-providers.js'))
const { ProviderFallbackManager } = require(path.join(distDir, 'fallback.js'))
const { describeError } = require(path.join(distDir, 'errors.js'))
const { PLANS, getPlan } = require(path.join(distDir, 'plans.js'))
const { createToolsProvider } = require(path.join(distDir, 'providers', 'tools.js'))
const { createOpenCodeZenProvider } = require(path.join(distDir, 'providers', 'opencode-zen.js'))

// ── 1. Configuration centrale ─────────────────────────────────────────────
check('Kim Pro : nom affiché', KIM_PRO.displayName === 'Kim Pro')
check('Kim Pro : backend réel masqué (Top Tools AI)', KIM_PRO.provider === 'top-tools')
check('Kim Pro : endpoint Top Tools AI', KIM_PRO.baseUrl === 'https://top-tools-ai.com/api/v1/chat/completions')
check('Kim Pro : modèle API configuré', typeof KIM_PRO.apiModel === 'string' && KIM_PRO.apiModel.length > 0, KIM_PRO.apiModel)
check('Ox Alpha : nom affiché', OX_ALPHA_FREE.displayName === 'Ox Alpha')
check('Ox Alpha : endpoint OpenCode Zen', OX_ALPHA_FREE.baseUrl === 'https://opencode.ai/zen/v1/chat/completions')
check('Ox Alpha : modèle x-preview-f-free', OX_ALPHA_FREE.apiModel === 'x-preview-f-free')

{
  const kim = createToolsProvider(() => null, () => null)
  check('provider Kim Pro enregistré avec label « Kim Pro »', kim.models[0].label === 'Kim Pro', kim.models[0].label)
  check('aucun « Top Tools » dans les labels utilisateur',
    !JSON.stringify(kim.models).toLowerCase().includes('top tools'))
  check('apiModel conservé côté main', kim.models[0].apiModel === KIM_PRO.apiModel)
  check('tier free déclaré', kim.tier === 'free')

  const ox = createOpenCodeZenProvider(() => null, () => null)
  check('provider Ox Alpha : label + tier', ox.models[0].label === 'Ox Alpha' && ox.tier === 'free')
}

// ── 2. Mapping apiModel -> body.model (vrai serveur HTTP local) ───────────
function withServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

;(async () => {
  let receivedModel = null
  const { server, port } = await withServer((req, res) => {
    let body = ''
    req.on('data', piece => { body += piece })
    req.on('end', () => {
      receivedModel = JSON.parse(body).model
      void sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
    })
  })

  const ox = createOpenCodeZenProvider(() => 'sk-test-key-local', () => null)
  // On pointe le provider vers le serveur local via une instance dédiée.
  const { createOpenAICompatibleProvider } = require(path.join(distDir, 'providers', 'openai-compatible.js'))
  const local = createOpenAICompatibleProvider({
    id: 'test', name: 'Test', apiUrl: `http://127.0.0.1:${port}/chat/completions`,
    models: [{ id: OX_ALPHA_FREE.modelId, label: OX_ALPHA_FREE.displayName, apiModel: OX_ALPHA_FREE.apiModel, supportsTools: true }],
    getKey: () => 'sk-test-key-local',
  })
  const events = []
  await local.stream(
    { messages: [{ role: 'user', content: 'ping' }], model: OX_ALPHA_FREE.modelId, signal: new AbortController().signal },
    event => events.push(event),
  )
  check('body.model = x-preview-f-free (pas l’id UI)', receivedModel === 'x-preview-f-free', String(receivedModel))
  check('streaming texte reçu', events.some(event => event.type === 'text' && event.text === 'ok'))
  server.close()

  // ── 3. Fallback ─────────────────────────────────────────────────────────
  function fakeProvider(id, script) {
    return {
      id, name: id, tier: 'free', models: [],
      async stream(request, onEvent) {
        for (const action of script.shift()) onEvent(action)
      },
    }
  }
  // guardStream-like : les erreurs arrivent comme événements.
  function scripted(id, turns) {
    return {
      id, name: id, tier: 'free', models: [],
      stream(request, onEvent) {
        const turn = turns.shift()
        if (!turn) throw new Error('plus de scénario')
        for (const event of turn) onEvent(event)
        return Promise.resolve()
      },
    }
  }

  {
    const primary = scripted('kim-pro', [[{ type: 'error', message: 'HTTP 429: rate limited' }]])
    const secondary = scripted('opencode-zen', [
      [{ type: 'text', text: 'réponse' }, { type: 'done', reason: 'stop' }],
    ])
    const manager = new ProviderFallbackManager([primary, secondary])
    const seen = []
    await manager.stream({ messages: [], model: 'm', signal: new AbortController().signal }, e => seen.push(e))
    check('429 -> bascule vers le fournisseur secondaire', seen.some(e => e.type === 'done'))
  }

  {
    const primary = scripted('kim-pro', [[{ type: 'error', message: 'Clé invalide' }]])
    const secondary = scripted('opencode-zen', [[{ type: 'done', reason: 'stop' }]])
    const manager = new ProviderFallbackManager([primary, secondary])
    let threw = false
    try {
      await manager.stream({ messages: [], model: 'm', signal: new AbortController().signal }, () => {})
    } catch { threw = true }
    check('erreur définitive (auth) -> remontée sans bascule silencieuse', threw)
  }

  {
    const primary = scripted('kim-pro', [[
      { type: 'text', text: 'début...' },
      { type: 'error', message: 'HTTP 500: boom' },
    ]])
    const secondary = scripted('opencode-zen', [[{ type: 'done', reason: 'stop' }]])
    const manager = new ProviderFallbackManager([primary, secondary])
    const seen = []
    let threw = false
    try {
      await manager.stream({ messages: [], model: 'm', signal: new AbortController().signal }, e => seen.push(e))
    } catch { threw = true }
    check('erreur après diffusion -> aucune bascule (pas de doublon)', threw && seen.some(e => e.type === 'text'))
  }

  // ── 4. Taxonomie d'erreurs ──────────────────────────────────────────────
  const { ProviderError } = require(path.join(distDir, 'providers', 'registry.js')) ?? {}
  const registryModule = require(path.join(distDir, 'providers', 'http.js'))
  const RealProviderError = registryModule.ProviderError
  check('401 -> AUTH_ERROR', describeError(new RealProviderError('bad key', 401)).code === 'AUTH_ERROR')
  check('403 -> AUTH_ERROR', describeError(new RealProviderError('forbidden', 403)).code === 'AUTH_ERROR')
  check('429 -> RATE_LIMIT', describeError(new RealProviderError('slow down', 429)).code === 'RATE_LIMIT')
  check('500 -> PROVIDER_ERROR', describeError(new RealProviderError('oops', 500)).code === 'PROVIDER_ERROR')
  check('message réseau -> NETWORK_ERROR', describeError(new Error('fetch failed')).code === 'NETWORK_ERROR')
  check('quota -> QUOTA_ERROR', describeError(new Error('Quota quotidien atteint')).code === 'QUOTA_ERROR')
  check('licences -> LICENSE_ERROR', describeError(new Error('licence expirée')).code === 'LICENSE_ERROR')

  // ── 5. Permissions ──────────────────────────────────────────────────────
  const free = getPlan('free').permissions
  const pro = getPlan('pro').permissions
  const ultimate = getPlan('pro_ultimate').permissions
  check('FREE : chat + agent + modèles gratuits', free.chat && free.agent && free.builtinFreeModels)
  check('FREE : pas de modèles premium ni priorité', !free.premiumModels && !free.priorityAccess)
  // Contrat produit (plans.ts + main.ts) : PRO ajoute Ox Alpha ; les modèles
  // premium restent réservés à PRO ULTIMATE.
  check('PRO : Ox Alpha inclus, sans premium', pro.oxAlphaModels === true && !pro.premiumModels)
  check('PRO ULTIMATE : advancedTools + priorityAccess', ultimate.advancedTools && ultimate.priorityAccess)
  check('PLANS expose exactement free/pro/pro_ultimate', PLANS.map(p => p.id).join(',') === 'free,pro,pro_ultimate')

  // ── 6. Licence pro_ultimate (vraie paire RSA locale) ────────────────────
  const root = path.resolve(__dirname, '..')
  const privatePath = require('./keys.cjs').findPrivateKeyPath()
  const publicPath = path.join(root, 'electron', 'keys', 'public.pem')
  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    const jwt = require('jsonwebtoken')
    const token = jwt.sign(
      {
        iss: 'cursor-clone', sub: 'admin@mycreation.app', licenseId: `lic_${Date.now().toString(36)}`,
        type: 'pro_ultimate', product: 'cursor-clone', version: '1.0.0',
        exp: Math.floor(Date.now() / 1000) + 365 * 86400,
      },
      fs.readFileSync(privatePath, 'utf8'),
      { algorithm: 'RS256' },
    )
    const decoded = jwt.verify(token, fs.readFileSync(publicPath, 'utf8'), { algorithms: ['RS256'], issuer: 'cursor-clone' })
    check('licence pro_ultimate signée RS256 vérifiée', decoded.type === 'pro_ultimate')
  } else {
    console.log('SKIP  licence pro_ultimate (clés locales absentes)')
  }
})().then(() => {
  console.log('\n=========================================')
  console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
  console.log('=========================================')
  process.exit(failCount === 0 ? 0 : 1)
}).catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
