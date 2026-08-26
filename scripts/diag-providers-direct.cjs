#!/usr/bin/env node
/**
 * DIAG DIRECT des deux modèles intégrés (hors UI), avec métriques :
 *   TIME_TO_FIRST_TOKEN / TOTAL / CHUNKS / erreurs.
 *
 * Kim Pro  : clé lue dans le keystore legacy (identite 'cursor-clone')
 *            -> ce script DOIT tourner avec app.setName('cursor-clone').
 * Ox Alpha : endpoint anonyme, aucune cle.
 *
 * Usage: electron.exe scripts/diag-providers-direct.cjs
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const out = process.env.DIAG_OUT
const write = line => fs.appendFileSync(out, line + '\n', 'utf8')

app.setName('cursor-clone')
app.disableHardwareAcceleration()

let pass = 0, fail = 0
function check(name, ok, detail) {
  write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  ok ? pass++ : fail++
}

async function measure(provider, model, prompt) {
  const events = []
  let ttft = null
  const t0 = Date.now()
  return new Promise(resolve => {
    provider.stream(
      { messages: [{ role: 'user', content: prompt }], model, signal: new AbortController().signal },
      event => {
        if (event.type === 'text' && ttft === null) ttft = (Date.now() - t0) / 1000
        events.push(event)
        if (event.type === 'done' || event.type === 'error') {
          resolve({ events, ttft, total: (Date.now() - t0) / 1000 })
        }
      },
    ).then(() => resolve({ events, ttft, total: (Date.now() - t0) / 1000 }))
      .catch(error => resolve({ events, ttft, total: (Date.now() - t0) / 1000, thrown: String(error?.message ?? error) }))
    setTimeout(() => resolve({ events, ttft, total: (Date.now() - t0) / 1000, timeout: true }), 120000)
  })
}

app.whenReady().then(async () => {
  const dist = path.join(__dirname, '..', 'dist-electron')

  // ── Kim Pro ──
  const { KeyStore, maskKey } = require(path.join(dist, 'keystore.js'))
  const store = new KeyStore()
  const toolsKey = store.get('tools')
  check('Kim Pro: cle admin presente dans ce contexte', toolsKey !== null, toolsKey ? maskKey(toolsKey) : 'absente')

  if (toolsKey) {
    const { createToolsProvider } = require(path.join(dist, 'providers', 'tools.js'))
    const kim = createToolsProvider(() => store.get('tools'), () => null)

    // Chat simple (non streamé côté mesure: on collecte).
    const r1 = await measure(kim, 'kim-pro', 'Réponds uniquement: PONG')
    const text1 = r1.events.filter(e => e.type === 'text').map(e => e.text).join('')
    check('KIM PRO DIRECT API', text1.length > 0 && !r1.thrown && !r1.timeout,
      `TTFT=${r1.ttft}s TOTAL=${r1.total}s chunks=${r1.events.filter(e => e.type === 'text').length} err=${r1.events.find(e => e.type === 'error')?.message?.slice(0, 80) ?? r1.thrown ?? 'none'}`)
    write(`      texte: ${JSON.stringify(text1.slice(0, 60))}`)

    const r2 = await measure(kim, 'kim-pro', 'Réponds uniquement :\n1\n2\n3\n4\n5')
    const deltas2 = r2.events.filter(e => e.type === 'text')
    check('KIM PRO STREAMING', deltas2.length > 0 && r2.ttft !== null,
      `TTFT=${r2.ttft}s TOTAL=${r2.total}s chunks=${deltas2.length}`)
  }

  // ── Ox Alpha ──
  const { createOpenCodeZenProvider } = require(path.join(dist, 'providers', 'opencode-zen.js'))
  const ox = createOpenCodeZenProvider(() => null, () => null)

  const r3 = await measure(ox, 'ox-alpha-free', 'Réponds uniquement :\n1\n2\n3\n4\n5')
  const textEvents3 = r3.events.filter(e => e.type === 'text')
  const text3 = textEvents3.map(e => e.text).join('')
  const reasoningEvents = r3.events.filter(e => e.type === 'reasoning')
  check('OX ALPHA DIRECT API', text3.trim().length > 0,
    `TTFT(texte)=${r3.ttft}s TOTAL=${r3.total}s chunksTexte=${textEvents3.length} chunksRaisonnement=${reasoningEvents.length} err=${r3.events.find(e => e.type === 'error')?.message?.slice(0, 80) ?? 'none'}`)
  write(`      texte: ${JSON.stringify(text3.slice(0, 60))}`)
  if (reasoningEvents.length > 0) {
    write(`      NOTE: ${reasoningEvents.length} events de raisonnement recus AVANT/AUTOUR du texte (modele raisonneur)`)
  }

  write(`RESULT: ${pass} PASS, ${fail} FAIL`)
  app.exit(fail === 0 ? 0 : 1)
})
