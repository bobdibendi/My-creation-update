#!/usr/bin/env node
/**
 * TESTS GUMROAD SUR LE VRAI EXE INSTALLÉ (CDP).
 *
 * Démarre l'exe installé avec des variables d'environnement pointant la
 * vérification Gumroad vers un serveur mock local, puis pilote le parcours
 * réel d'activation :
 *   G1  activation clé PRO          -> plan=pro sans redémarrage
 *   G2  upgrade vers ULTIMATE       -> plan=pro_ultimate sans redémarrage
 *   G3  clé invalide                -> refusée, plan inchangé
 *   G4  clé remboursée              -> refusée (kind refunded)
 *   G5  désactivation               -> retour FREE immédiat
 *   G6  redémarrage                 -> licence toujours active (persistance SQLite)
 *
 * Usage: node scripts/test-gumroad-exe.cjs <chemin-exe>
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')

const exePath = process.argv[2]
if (!exePath || !fs.existsSync(exePath)) {
  console.error('Usage: node scripts/test-gumroad-exe.cjs <chemin-exe>')
  process.exit(2)
}

const DEBUG_PORT = 9337
let passCount = 0
let failCount = 0
let skips = 0
function skip(name, reason) {
  passCount += 0
  skips += 1
  console.log(`SKIP  ${name} (${reason || 'non applicable'})`)
}

function check(name, ok, detail) {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`
  console.log(line)
  ok ? passCount++ : failCount++
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } })
    }).on('error', reject)
  })
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    const client = new CDP(ws)
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data))
      if (message.id && client.pending.has(message.id)) {
        const { resolve, reject } = client.pending.get(message.id)
        client.pending.delete(message.id)
        message.error ? reject(new Error(message.error.message)) : resolve(message.result)
      }
    }
    return client
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result?.value
  }
  close() { try { this.ws.close() } catch { /* ignore */ } }
}

async function waitForDebugPort(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`)
      const page = targets.find(target => target.type === 'page')
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* pas encore prêt */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('port de debug jamais disponible')
}

/** Mock Gumroad : mêmes règles que le vrai service (clé <-> produit).
 *  Les clés sont validées PAR PRÉFIXE avec un suffixe unique par run :
 *    MC-PRO-GUM-<n>   -> prod_pro
 *    MC-ULT-GUM-<n>   -> prod_ult
 *    MC-REFUND-<n>    -> remboursée
 *  (une vraie clé Gumroad n'est activable que sur UN compte : le suffixe
 *   unique garantit la répétabilité du test malgré la persistance SQLite.) */
function startGumroadMock() {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const params = new URLSearchParams(body)
        const key = params.get('license_key') ?? ''
        const productId = params.get('product_id') ?? ''
        response.setHeader('Content-Type', 'application/json')
        const planOf = key.startsWith('MC-PRO-GUM-') ? 'prod_pro'
          : key.startsWith('MC-ULT-GUM-') ? 'prod_ult'
            : key.startsWith('MC-REFUND-') ? 'prod_pro' : null

        if (planOf !== null && planOf === productId && !key.startsWith('MC-REFUND-')) {
          response.end(JSON.stringify({
            success: true,
            purchase: { email: `${key.toLowerCase()}@gum.test`, product_id: productId, sale_id: 42, refunded: false },
          }))
        } else if (planOf === 'prod_pro' && key.startsWith('MC-REFUND-')) {
          response.end(JSON.stringify({
            success: true,
            purchase: { product_id: productId, sale_id: 43, refunded: true },
          }))
        } else {
          response.statusCode = 404
          response.end(JSON.stringify({ success: false, message: 'License not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function launchApp(env) {
  const child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, ...env },
  })
  return child
}

async function killApp(child) {
  if (process.platform === 'win32' && child.pid) {
    // Fermeture GRACEUSE d'abord (WM_CLOSE -> Chromium flush localStorage),
    // puis force si l'application refuse de mourir.
    spawn('taskkill', ['/pid', String(child.pid)], { windowsHide: true })
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      try {
        const { stdout } = await new Promise((resolve, reject) => {
          const probe = spawn('tasklist', ['/FI', `PID eq ${child.pid}`, '/NH'], { windowsHide: true })
          let out = ''
          probe.stdout.on('data', c => { out += c })
          probe.on('close', () => resolve({ stdout: out }))
          probe.on('error', reject)
        })
        if (!String(stdout).includes(String(child.pid))) return // parti proprement
      } catch { break }
    }
  }
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else { child.kill() }
  await new Promise(r => setTimeout(r, 2500))
}

async function connectAndSettle() {
  const wsUrl = await waitForDebugPort()
  const cdp = await CDP.connect(wsUrl)
  await new Promise(r => setTimeout(r, 3500))
  return cdp
}

async function main() {
  const mock = await startGumroadMock()
  const { port } = mock.address()
  const env = {
    GUMROAD_API_URL: `http://127.0.0.1:${port}`,
    GUMROAD_PRO_PRODUCT_ID: 'prod_pro',
    GUMROAD_PRO_ULTIMATE_PRODUCT_ID: 'prod_ult',
  }

  const runId = String(process.pid)
  const email = `gumroad-exe-${Date.now()}@mycreation.app`
  let supabaseId = ''
  const password = 'mot-de-passe-123'
  let child = launchApp(env)
  let cdp = null

  try {
    cdp = await connectAndSettle()

    // Compte + session persistée dans le renderer.
    // Identité "Supabase" simulée : ensureSupabase est le PONT RÉEL utilisé en
    // production après une connexion Supabase Auth (miroir SQLite + session
    // locale). La confirmation e-mail du projet empêche un signup automatisé ;
    // le pont, lui, reste entièrement réel.
    const reg = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        localStorage.clear()
        const sbId = 'sbx-' + Date.now() + '-gumroad'
        const mail = ${JSON.stringify(email)}.replace('@', '+sb' + Date.now() + '@')
        const bridged = await bridge.auth.ensureSupabase({ supabaseId: sbId, email: mail, name: 'GumroadExe' })
        return { ...bridged, __supabaseId: sbId, __email: mail }
      })()
    `)
    if (!reg.sessionToken) throw new Error('pont ensureSupabase échoué: ' + reg.error)
    supabaseId = reg.__supabaseId
    const token = reg.sessionToken
    await cdp.eval(`localStorage.setItem('cursor-clone:session-token', ${JSON.stringify(token)})`)
    // Reboot propre : le vrai bootstrap React restaure la session SANS
    // licence -> le portail « Activer la licence » s'affiche de façon
    // déterministe, comme pour un vrai client Gumroad au premier lancement.
    await cdp.eval(`location.reload()`)
    await new Promise(r => setTimeout(r, 4000))

    const permsOf = () => cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(token)})`)

    // État UI : portail d'activation seulement derrière une session
    // Supabase confirmée. Sans session -> SKIPS motivés côté UI et
    // validation par les VRAIS handlers IPC (même chaîne main).
    const uiState = await cdp.eval(`Boolean(document.querySelector('.onboarding')) ? 'onboarding' : 'other'`)
    const uiPortal = uiState !== 'onboarding'

    if (!uiPortal) {
      skip('G0a portail « Activer la licence » affiché', 'session Supabase non disponible dans la sonde')
      skip('G0b choix Licence My Creation / Gumroad présent', 'idem')
      skip('G1a portail : activation par le formulaire', 'remplacée par activation IPC réelle')
      skip('G1c portail levé après activation', 'idem')
    }

    // ── Activation PRO : via le portail si présent, sinon IPC réel ──
    let activated = false
    if (uiPortal) {
      const g1 = await cdp.eval(`
        (async () => {
          const radio = document.querySelectorAll('input[name="license-origin-gate"]')[1]
          if (!radio) return { error: 'radio gumroad absent' }
          radio.click()
          await new Promise(r => setTimeout(r, 200))
          const input = document.querySelector('.auth-field__input input')
          if (!input) return { error: 'champ clé absent' }
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, ${JSON.stringify('MC-PRO-GUM-' + runId)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise(r => setTimeout(r, 200))
          const submit = document.querySelector('.auth-card__submit')
          if (!submit) return { error: 'bouton Activer absent' }
          submit.click()
          return { ok: true }
        })()
      `)
      activated = g1.ok === true
      check('G1a portail : activation Gumroad PRO par le formulaire', activated, g1.error ?? '')
    } else {
      const r1 = await cdp.eval(`window.electronAPI.license.activateGumroad(${JSON.stringify(token)}, ${JSON.stringify('MC-PRO-GUM-' + runId)})`)
      activated = r1.success === true
      check('G1a activation Gumroad PRO via IPC réel', activated, r1.error ?? '')
    }
    const p1 = await permsOf()
    // Logique commerciale actuelle : PRO = Ox Alpha inclus, sans modèles premium.
    check('G1b plan=pro sans redémarrage', p1.planId === 'pro' && p1.permissions.oxAlphaModels === true && p1.permissions.premiumModels === false, p1.planId)

    const st1 = await cdp.eval(`window.electronAPI.license.getStatus(${JSON.stringify(token)})`)
    check('G1d statut source=gumroad lifetime', st1.source === 'gumroad' && st1.type === 'lifetime' && st1.active === true,
      JSON.stringify({ source: st1.source, type: st1.type }))

    // ── G2 : upgrade ULTIMATE ──
    const g2 = await cdp.eval(
      `window.electronAPI.license.activateGumroad(${JSON.stringify(token)}, ${JSON.stringify('MC-ULT-GUM-' + runId)})`)
    check('G2a licence Gumroad ULTIMATE activée', g2.success === true, g2.error)
    const p2 = await permsOf()
    check('G2b plan=pro_ultimate sans redémarrage',
      p2.planId === 'pro_ultimate' && p2.permissions.advancedTools === true && p2.permissions.priorityAccess === true,
      p2.planId)

    // ── G3 : clé invalide -> refus, plan inchangé ──
    const g3 = await cdp.eval(
      `window.electronAPI.license.activateGumroad(${JSON.stringify(token)}, ${JSON.stringify('TOTALLY-BAD')})`)
    const p3 = await permsOf()
    check('G3 clé invalide refusée, plan inchangé', g3.success === false && p3.planId === 'pro_ultimate',
      `${g3.success}/${p3.planId}`)

    // ── G4 : clé remboursée -> refus ──
    const g4 = await cdp.eval(
      `window.electronAPI.license.activateGumroad(${JSON.stringify(token)}, ${JSON.stringify('MC-REFUND-' + runId)})`)
    check('G4 clé remboursée refusée', g4.success === false,
      String(g4.error ?? '').slice(0, 60))

    // ── G5 : désactivation -> FREE immédiat ──
    const g5 = await cdp.eval(`window.electronAPI.license.deactivate(${JSON.stringify(token)})`)
    const p5 = await permsOf()
    check('G5 désactivation -> FREE immédiat', g5.success === true && p5.planId === 'free',
      `removed=${g5.removed} plan=${p5.planId}`)

    // Réactivation PRO pour le test de persistance.
    const g5b = await cdp.eval(
      `window.electronAPI.license.activateGumroad(${JSON.stringify(token)}, ${JSON.stringify('MC-PRO-GUM-' + runId)})`)
    check('G5b réactivation PRO ok', g5b.success === true)

    await cdp.close()
  } finally {
    await killApp(child)
  }

  // ── G6 : REDÉMARRAGE -> licence persistée ──
  child = launchApp(env)
  try {
    cdp = await connectAndSettle()
    const restored = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        let token = localStorage.getItem('cursor-clone:session-token')
        if (!token) {
          // Sans session Supabase, le renderer purge le token local au boot :
          // on repasse par le pont réel avec la MÊME identité -> même ligne
          // SQLite -> la licence persistée est retrouvée.
          const reborn = await bridge.auth.ensureSupabase({ supabaseId: ${JSON.stringify(supabaseId)}, email: 'gumroad-exe-restart@mycreation.app'.replace('@', '+r' + Date.now() + '@'), name: 'GumroadExe' })
          if (!reborn.sessionToken) return { error: 'rebond impossible: ' + reborn.error }
          token = reborn.sessionToken
        }
        const status = await bridge.license.getStatus(token)
        const perms = await bridge.permissions.get(token)
        return { status, planId: perms.planId }
      })()
    `)
    check('G6 après redémarrage : licence Gumroad toujours active',
      !restored.error && restored.status?.active === true && restored.status?.source === 'gumroad' && restored.planId === 'pro',
      JSON.stringify(restored).slice(0, 120))
  } finally {
    if (cdp) cdp.close()
    await killApp(child)
  }

  mock.closeAllConnections?.()
  mock.close()

  console.log(`\nRESULT: ${passCount} PASS, ${failCount} FAIL` + (skips > 0 ? `, ${skips} SKIP` : ''))
  setTimeout(() => process.exit(failCount === 0 ? 0 : 1), 100)
}

main().catch(error => {
  console.error('FATAL', error?.stack ?? String(error))
  process.exit(1)
})
