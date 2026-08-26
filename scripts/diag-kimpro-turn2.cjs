/**
 * Diagnostic ponctuel — Kim Pro (Top Tools AI).
 *
 * Détermine si le backend se suspend sur la forme « tour 2 » d'une boucle
 * d'outils OpenAI (assistant.tool_calls + messages role:"tool"), en envoyant
 * chaque variante comme PREMIÈRE requête (aucun multi-turn réel nécessaire).
 *
 * Usage: node scripts/test.cjs n'existe pas pour ce diag — lancer directement:
 *   set TEST_OUTPUT=diag.log && electron dist-electron/.. ? -> utiliser:
 *   node scripts/run-electron-diag.cjs  (voir bas de fichier)
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')
const distDir = path.join(projectRoot, 'dist-electron')

const { ProviderRegistry } = require(path.join(distDir, 'providers', 'registry.js'))
const { createToolsProvider } = require(path.join(distDir, 'providers', 'tools.js'))
const { KeyStore } = require(path.join(distDir, 'keystore.js'))

app.setName('cursor-clone')

const LIST_SCHEMA = {
  type: 'function',
  name: 'listDirectory',
  description: 'Liste les fichiers du workspace.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Chemin relatif' } },
    required: ['path'],
  },
}

/** Une variante de payload + son libellé. */
const VARIANTS = [
  {
    name: 'P1 controle (sans outils)',
    tools: undefined,
    messages: [
      { role: 'system', content: 'Tu réponds en français.' },
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Bonjour ! Comment puis-je aider ?' },
      { role: 'user', content: 'Réponds en une phrase.' },
    ],
  },
  {
    name: 'P2 tool_calls natifs + role tool',
    tools: [LIST_SCHEMA],
    messages: [
      { role: 'system', content: 'Tu réponds en français.' },
      { role: 'user', content: 'Liste les fichiers' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_diag_1', name: 'listDirectory', arguments: '{"path":"."}' }],
      },
      { role: 'tool', toolCallId: 'call_diag_1', toolName: 'listDirectory', content: '[{"path":"package.json","type":"file"}]' },
      { role: 'user', content: 'Résume le résultat en une phrase.' },
    ],
  },
  {
    name: 'P3 compat (resultat replie dans user)',
    tools: [LIST_SCHEMA],
    messages: [
      { role: 'system', content: 'Tu réponds en français.' },
      { role: 'user', content: 'Liste les fichiers' },
      { role: 'assistant', content: "J'appelle listDirectory." },
      { role: 'user', content: 'Résultat de l\'outil listDirectory : [{"path":"package.json","type":"file"}]. Résume en une phrase.' },
    ],
  },
]

async function probe(label, provider, model, body) {
  const started = Date.now()
  return new Promise(resolve => {
    let text = ''
    let calls = 0
    let failure = null
    const timer = setTimeout(() => {
      resolve(`TIMEOUT ${Math.round((Date.now() - started) / 1000)}s sans reponse`)
    }, 60_000)
    provider.stream(body, event => {
      if (event.type === 'text') text += event.text
      else if (event.type === 'tool-call') calls += 1
      else if (event.type === 'error') failure = event.message
    }).then(() => {
      clearTimeout(timer)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      resolve(`OK ${seconds}s text=${JSON.stringify(text.slice(0, 80))} toolCalls=${calls}${failure ? ` ERREUR=${failure}` : ''}`)
    }).catch(error => {
      clearTimeout(timer)
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      resolve(`ERREUR ${seconds}s ${error && error.message ? error.message : String(error)}`)
    })
  })
}

async function main() {
  report(`[diag] safeStorage disponible: ${safeStorage.isEncryptionAvailable()}`)
  const store = new KeyStore()
  const key = store.get('tools')
  report(`[diag] cle tools presente: ${key ? 'oui' : 'non'}`)
  if (!key) {
    report('FATAL aucune cle Kim Pro dans le KeyStore')
    app.exit(1)
    return
  }

  const provider = createToolsProvider(() => key)
  const model = provider.models.find(candidate => candidate.supportsTools)

  for (const variant of VARIANTS) {
    const outcome = await probe(variant.name, provider, model, {
      messages: variant.messages,
      model: model.id,
      tools: variant.tools,
      signal: new AbortController().signal,
    })
    report(`${variant.name} -> ${outcome}`)
  }
  app.exit(0)
}

app.whenReady().then(main).catch(error => {
  report(`FATAL ${error && error.stack ? error.stack : String(error)}`)
  app.exit(1)
})
