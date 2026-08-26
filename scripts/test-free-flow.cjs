#!/usr/bin/env node
/**
 * E2E REEL Ã¢â‚¬â€ parcours utilisateur FREE puis PRO ULTIMATE dans My Creation.
 *
 * Boote le VRAI processus main (dist-electron/main.js), cree un compte via
 * les vrais handlers IPC, active de vraies licences JWT signees, puis teste
 * dans le renderer :
 *   TEST 1 : aucune demande d'API key (Kim Pro / Ox Alpha prets)
 *   TEST 2 : Chat Kim Pro "Bonjour" -> reponse reelle
 *   TEST 3 : Chat Ox Alpha en FREE -> refuse par la barriere de plan (message exact)
 *   TEST 4 : Agent + Kim Pro -> fonctionnel
 *   TEST 5 : Agent + Ox Alpha en FREE -> refuse par la barriere de plan (message exact)
 *   TEST 6 : selecteur FREE = [Kim Pro]  (UI, requiert une session Supabase confirmee)
 *   TEST 7 : activation PRO ULTIMATE -> permissions immediates ; menu complet (UI si session)
 *
 * NB : la confirmation e-mail est ACTIVEE sur le projet Supabase -> un signup
 * automate ne renvoie PAS de session. Les tests UI (6/7 partie interface)
 * sont SKIPPES avec raison lorsqu'aucune session Supabase n'est disponible ;
 * tout le reste passe par les vrais handlers IPC.
 *
 * Usage : npx electron scripts/test-free-flow.cjs   (apres npm run build)
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const jwt = require('jsonwebtoken')
const { app, BrowserWindow } = require('electron')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')

// Identite d'application requise : le keystore administrateur a ete chiffre
// sous le nom 'cursor-clone' et safeStorage lie son dechiffrement au contexte
// de l'app. Isoler userData casserait le dechiffrement ; ce test utilise donc
// le vrai profil, comme les autres suites E2E.
app.setName('cursor-clone')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => { /* le test controle sa vie */ })

let serial = 0
function signLicense(claims) {
  serial += 1
  return jwt.sign(
    {
      iss: 'cursor-clone',
      sub: `flow-${serial}@mycreation.app`,
      licenseId: `lic_${Date.now().toString(36)}_${serial}`,
      product: 'cursor-clone',
      version: '1.0.0',
      ...claims,
    },
    require('./keys.cjs').readPrivateKey(),
    { algorithm: 'RS256' },
  )
}

async function main() {
  const problems = []

  process.on('uncaughtException', error => {
    report('FATAL uncaught: ' + (error && error.stack ? error.stack : String(error)))
    process.exit(1)
  })

  require(path.join(projectRoot, 'dist-electron', 'main.js'))

  // Fenetre rÃƒÂ©elle crÃƒÂ©ÃƒÂ©e par main.js.
  let win = null
  for (let i = 0; i < 200 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] ?? null
    if (!win) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!win) { report('FAIL aucune fenetre'); process.exit(1) }
  await new Promise(resolve => setTimeout(resolve, 2500))

  // Ã¢â€â‚¬Ã¢â€â‚¬ Compte + licence FREE (type lifetime, sans claim plan) Ã¢â€â‚¬Ã¢â€â‚¬
  const boot = await win.webContents.executeJavaScript(`
    (async () => {
      const bridge = window.electronAPI
      const registered = await bridge.auth.register('flow-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'FlowTest')
      return { sessionToken: registered.sessionToken ?? null, error: registered.error ?? null }
    })()
  `, true)
  if (!boot.sessionToken) { report('FAIL register: ' + boot.error); process.exit(1) }
  const { sessionToken } = boot

  const freeJwt = signLicense({ type: 'lifetime' })
  const activated = await win.webContents.executeJavaScript(
    `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(freeJwt)})`,
    true,
  )
  if (!activated.success) { report('FAIL activation FREE: ' + activated.error); process.exit(1) }

  await win.webContents.executeJavaScript(
    `localStorage.setItem('cursor-clone:session-token', ${JSON.stringify(sessionToken)})`,
    true,
  )
  await win.reload()
  await new Promise(resolve => setTimeout(resolve, 2500))

  // Session renderer : avec la confirmation e-mail Supabase activee, un
  // compte cree par IPC ne donne PAS acces a l'app (ecran Onboarding). Les
  // tests UI ne tournent que si une session est reellement etablie.
  const authed = await win.webContents.executeJavaScript(
    `Boolean(document.querySelector('.activitybar button'))`,
    true,
  )
  if (!authed) {
    report('SKIP  UI: session Supabase confirmee requise (confirmation e-mail activee sur le projet) — suite IPC uniquement')
  }

  // Ouvre l'assistant.
  if (authed) {
    await win.webContents.executeJavaScript(`
      (async () => {
        const button = Array.from(document.querySelectorAll('.activitybar button'))
          .find(b => (b.getAttribute('title') || '') === 'Assistant IA')
        if (button) button.click()
        await new Promise(r => setTimeout(r, 700))
      })()
    `, true)
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 1 : aucune demande d'API key Ã¢â€â‚¬Ã¢â€â‚¬
  const dbgKey = await win.webContents.executeJavaScript(
    `window.electronAPI.api.checkKey('tools')`,
    true,
  )
  report(`[dbg] checkKey('tools') -> ${JSON.stringify(dbgKey)}`)
  const test1 = await win.webContents.executeJavaScript(`
    (async () => {
      const providers = await window.electronAPI.api.listProviders()
      const kim = providers.find(p => p.models.some(m => m.id === 'kim-pro'))
      const ox = providers.find(p => p.models.some(m => m.id === 'ox-alpha-free'))
      const perms = await window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})
      return {
        kimConfigured: Boolean(kim && kim.configured),
        oxConfigured: Boolean(ox && ox.configured),
        planId: perms.planId,
        premiumAllowed: perms.permissions.premiumModels,
      }
    })()
  `, true)
  report(`${test1.kimConfigured ? 'PASS' : 'FAIL'}  TEST1 Kim Pro pret sans cle utilisateur`)
  report(`${test1.oxConfigured ? 'PASS' : 'FAIL'}  TEST1 Ox Alpha pret sans cle utilisateur`)
  if (!test1.kimConfigured) problems.push('TEST1 kim-pro non configure')
  if (!test1.oxConfigured) problems.push('TEST1 ox-alpha-free non configure')

  /** Collecte un chat reel jusqu'a done/error. */
  function collectChat(model, prompt) {
    return win.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.electronAPI
        let text = ''
        let error = null
        let done = false
        const off = bridge.ai.onChunk((event) => {
          if (event.type === 'text') text += event.text
          else if (event.type === 'error') error = event.message
          else if (event.type === 'done') done = true
        })
        await bridge.ai.chat({
          messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }],
          model: ${JSON.stringify(model)},
          sessionToken: ${JSON.stringify(sessionToken)},
        })
        const started = Date.now()
        while (Date.now() - started < 90000 && !done && !error) {
          await new Promise(r => setTimeout(r, 150))
        }
        off()
        return { text, error, done }
      })()
    `, true)
  }

  /** Une tentative peut tomber sur un reseau lent ; on rejoue si vide. */
  async function collectChatStable(model, prompt) {
    let outcome = await collectChat(model, prompt)
    if (outcome.text.trim().length === 0) {
      outcome = await collectChat(model, prompt)
    }
    return outcome
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 2 : Chat Kim Pro Ã¢â€â‚¬Ã¢â€â‚¬
  const kimChat = await collectChatStable('kim-pro', 'Bonjour')
  report(`${kimChat.text.trim().length > 0 ? 'PASS' : 'FAIL'}  TEST2 Chat Kim Pro reponse reelle (${JSON.stringify(kimChat.text.slice(0, 50))})`)
  if (kimChat.text.trim().length === 0) problems.push('TEST2 pas de texte Kim Pro: ' + kimChat.error)

  // ── TEST 3 : Chat Ox Alpha en FREE -> barrière de plan ──
  // Logique commerciale actuelle : Ox Alpha est inclus À PARTIR DU PLAN PRO.
  // On attend le refus EXPLICITE (le message doit traverser intact).
  const oxCchat = await collectChatStable('ox-alpha-free', 'Bonjour')
  const oxGateOk = oxCchat.text.trim().length === 0
    && /inclus à partir du plan PRO/i.test(oxCchat.error ?? '')
  report(`${oxGateOk ? 'PASS' : 'FAIL'}  TEST3 Chat Ox Alpha refuse en FREE, barriere de plan (${JSON.stringify((oxCchat.error ?? '').slice(0, 90))})`)
  if (!oxGateOk) problems.push('TEST3 barriere plan Ox Alpha incorrecte: ' + (oxCchat.error ?? 'pas d\'erreur'))

  // ── TEST 6 : selecteur FREE ──
  let freeMenu = null
  if (authed) {
    await win.webContents.executeJavaScript(`
      (async () => {
        const select = document.querySelector('.agent-select--model')
        if (!select) return
        select.click()
        await new Promise(r => setTimeout(r, 500))
      })()
    `, true)
    freeMenu = await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.agent-topbar__model .ui-menu__item .ui-menu__text'))
        .map(el => el.textContent.trim())
    `, true)
    await win.webContents.executeJavaScript(`document.body.click()`, true)
  }
  const freeOk = freeMenu !== null && Array.isArray(freeMenu) && freeMenu.length === 1
    && freeMenu.includes('Kim Pro')
  if (freeMenu === null) {
    report('SKIP  TEST6 selecteur FREE (UI indisponible sans session Supabase confirmee)')
  } else {
    report(`${freeOk ? 'PASS' : 'FAIL'}  TEST6 selecteur FREE = [Kim Pro] (${JSON.stringify(freeMenu)})`)
    if (!freeOk) problems.push('TEST6 menu FREE incorrect')
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 4 & 5 : Agent avec chaque modele Ã¢â€â‚¬Ã¢â€â‚¬
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'mycreation-agent-'))
  await fsp.writeFile(path.join(workspace, 'note.txt'), 'hello my creation\n', 'utf8')

  async function runAgent(model) {
    return win.webContents.executeJavaScript(`
      (async () => {
        const bridge = window.electronAPI
        let done = false
        let error = null
        let sid = null
        const off = bridge.agent.onEvent((event) => {
          if (!sid || event.sessionId !== sid) return
          if (event.type === 'done') done = true
          else if (event.type === 'error') error = event.message
        })
        try {
          const res = await bridge.agent.start({
            prompt: 'RÃƒÂ©ponds simplement en une phrase: OK.',
            model: ${JSON.stringify(model)},
            workspace: ${JSON.stringify(workspace)},
            sessionToken: ${JSON.stringify(sessionToken)},
          })
          sid = res.sessionId
        } catch (e) { error = 'start: ' + e.message }
        const started = Date.now()
        while (Date.now() - started < 90000 && !done && !error) {
          await new Promise(r => setTimeout(r, 200))
        }
        off()
        return { done, error }
      })()
    `, true)
  }

  report('[marker] avant agent kim-pro')
  // Ferme le menu dÃƒÂ©roulant avant l'agent.
  const agentKim = await runAgent('kim-pro')
  report(`[marker] apres agent kim-pro (done=${agentKim.done})`)
  report(`${agentKim.done ? 'PASS' : 'FAIL'}  TEST4 Agent + Kim Pro (${agentKim.done ? 'done' : 'erreur: ' + agentKim.error})`)
  if (!agentKim.done) problems.push('TEST4 agent kim-pro')

  report('[marker] avant agent ox-alpha-free')
  const agentOx = await runAgent('ox-alpha-free')
  report(`[marker] apres agent ox-alpha-free (done=${agentOx.done})`)
  const agentOxGateOk = !agentOx.done
    && /inclus à partir du plan PRO/i.test(agentOx.error ?? '')
  report(`${agentOxGateOk ? 'PASS' : 'FAIL'}  TEST5 Agent + Ox Alpha refuse en FREE, message plan exact (${String(agentOx.error ?? '').slice(0, 90)})`)
  const noKeyDemand = !agentOx.error || !/(entrer|ajouter|configurer).{0,20}cl[eÉé]|API key required/i.test(agentOx.error)
  report(`${noKeyDemand ? 'PASS' : 'FAIL'}  TEST5 aucune demande de cle dans l'erreur eventuelle`)
  if (!agentOxGateOk) problems.push('TEST5 barriere plan agent Ox Alpha incorrecte: ' + (agentOx.error ?? 'aucune'))

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 7 : PRO ULTIMATE -> modeles supplementaires Ã¢â€â‚¬Ã¢â€â‚¬
  const ultimateJwt = signLicense({ type: 'lifetime', plan: 'pro_ultimate' })
  const upgraded = await win.webContents.executeJavaScript(
    `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(ultimateJwt)})`,
    true,
  )
  report(`${upgraded.success ? 'PASS' : 'FAIL'}  TEST7 activation licence PRO ULTIMATE`)
  if (!upgraded.success) problems.push('TEST7 activation pro_ultimate: ' + upgraded.error)

  const permsUltimate = await win.webContents.executeJavaScript(
    `window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`,
    true,
  )
  report(`${permsUltimate.planId === 'pro_ultimate' && permsUltimate.permissions.premiumModels ? 'PASS' : 'FAIL'}  TEST7 permissions PRO ULTIMATE actives sans redemarrage (${permsUltimate.planId})`)

  // Persistance du plan apres rechargement (niveau service, hors UI).
  await win.reload()
  await new Promise(resolve => setTimeout(resolve, 2500))
  const permsAfterReload = await win.webContents.executeJavaScript(
    `window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`,
    true,
  )
  report(`${permsAfterReload.planId === 'pro_ultimate' ? 'PASS' : 'FAIL'}  TEST7 plan PRO ULTIMATE conserve apres reload (${permsAfterReload.planId})`)
  if (permsAfterReload.planId !== 'pro_ultimate') problems.push('TEST7 persistance plan apres reload')

  let ultimateMenu = null
  if (authed) {
    await win.webContents.executeJavaScript(`
      (async () => {
        const button = Array.from(document.querySelectorAll('.activitybar button'))
          .find(b => (b.getAttribute('title') || '') === 'Assistant IA')
        if (button) button.click()
        await new Promise(r => setTimeout(r, 700))
        const select = document.querySelector('.agent-select--model')
        if (select) select.click()
        await new Promise(r => setTimeout(r, 500))
      })()
    `, true)
    ultimateMenu = await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.agent-topbar__model .ui-menu__item .ui-menu__text'))
        .map(el => el.textContent.trim())
    `, true)
  }
  const ultimateOk = ultimateMenu !== null && Array.isArray(ultimateMenu) && ultimateMenu.length > 2
    && ultimateMenu.includes('Kim Pro') && ultimateMenu.includes('Ox Alpha')
  if (ultimateMenu === null) {
    report('SKIP  TEST7 menu PRO ULTIMATE (UI indisponible sans session Supabase confirmee)')
  } else {
    report(`${ultimateOk ? 'PASS' : 'FAIL'}  TEST7 modeles supplementaires visibles (${ultimateMenu.length} modeles)`)
    if (!ultimateOk) problems.push('TEST7 menu PRO ULTIMATE incomplet')
  }
  console.log('')
  const ok = problems.length === 0
  report(ok ? 'PASS  Parcours FREE + PRO ULTIMATE complet' : 'FAIL  ' + problems.length + ' probleme(s): ' + problems.join(' | '))
  app.exit(ok ? 0 : 1)
}

main().catch(error => {
  report('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
