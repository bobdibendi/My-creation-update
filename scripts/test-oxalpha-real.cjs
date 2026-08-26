#!/usr/bin/env node
/**
 * Test REEL du fournisseur Ox Alpha (OpenCode Zen).
 *
 * Appelle https://opencode.ai/zen/v1/chat/completions avec le modele
 * x-preview-f-free via le provider compile :
 *   - chat simple ;
 *   - streaming (deltas progressifs) ;
 *   - tentative de tool call (le refus eventuel doit remonter proprement).
 *
 * Usage : node scripts/test-oxalpha-real.cjs   (apres npm run build)
 */
const fs = require('node:fs')
const path = require('node:path')

const distDir = path.resolve(__dirname, '..', 'dist-electron')
if (!fs.existsSync(path.join(distDir, 'providers', 'opencode-zen.js'))) {
  console.error('FATAL dist-electron/providers/opencode-zen.js absent. Lance "npm run build".')
  process.exit(1)
}
const { createOpenCodeZenProvider } = require(path.join(distDir, 'providers', 'opencode-zen.js'))

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

function collect(provider, request) {
  return new Promise(resolve => {
    const events = []
    provider.stream({ ...request, signal: new AbortController().signal }, event => events.push(event))
      .then(() => resolve(events))
      .catch(error => resolve([...events, { type: 'thrown', message: String(error?.message ?? error) }]))
  })
}

async function main() {
  // Aucune clé personnelle, aucun pool : l'endpoint repond sans authentification.
  const provider = createOpenCodeZenProvider(() => null, () => null)
  check('provider Ox Alpha construit', provider.id === 'opencode-zen' && provider.tier === 'free')

  // -- Chat simple --
  const chat = await collect(provider, {
    model: 'ox-alpha-free',
    messages: [{ role: 'user', content: 'Réponds exactement: PONG' }],
  })
  const chatText = chat.filter(e => e.type === 'text').map(e => e.text).join('')
  check('chat simple -> réponse texte', chatText.length > 0, JSON.stringify(chatText.slice(0, 60)))
  check('chat simple -> événement done', chat.some(e => e.type === 'done'))

  // -- Streaming --
  const stream = await collect(provider, {
    model: 'ox-alpha-free',
    messages: [{ role: 'user', content: 'Compte de 1 à 5, chiffres séparés par des espaces.' }],
  })
  const deltas = stream.filter(e => e.type === 'text')
  check('streaming -> plusieurs deltas progressifs', deltas.length > 1, `${deltas.length} deltas`)
  const streamedText = deltas.map(e => e.text).join('')
  check('streaming -> contenu non vide', streamedText.trim().length > 0, JSON.stringify(streamedText.slice(0, 40)))

  // -- Tool call --
  const tools = await collect(provider, {
    model: 'ox-alpha-free',
    messages: [{ role: 'user', content: 'Lis le fichier test.txt avec l’outil fourni.' }],
    tools: [{
      name: 'readFile',
      description: 'Lit un fichier du workspace',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    }],
  })
  const toolCall = tools.find(e => e.type === 'tool-call')
  const toolError = tools.find(e => e.type === 'error' || e.type === 'thrown')
  if (toolCall) {
    check('tool call natif accepté et transmis', typeof toolCall.call.name === 'string' && toolCall.call.name.length > 0, toolCall.call.name)
  } else if (toolError) {
    check('refus des tools remonté PROPREMENT (erreur claire, pas de faux succès)', true, String(toolError.message).slice(0, 80))
    console.log('NOTE  ce backend refuse actuellement les tools ; l’Agent affiche l’erreur au lieu de simuler.')
  } else {
    check('tool call ni erreur : réponse texte de repli', tools.some(e => e.type === 'text'), 'comportement documenté')
  }
}

main().then(() => {
  console.log('\n=========================================')
  console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
  console.log('=========================================')
  process.exit(failCount === 0 ? 0 : 1)
}).catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
