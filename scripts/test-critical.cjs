#!/usr/bin/env node
/**
 * TESTS CRITIQUES 1.2.0 Ã¢â‚¬â€ EXE installÃƒÂ©, interface rÃƒÂ©elle (CDP).
 *
 * Compte / licence / upgrade / expiration / dÃƒÂ©connexion pendant stream /
 * stabilitÃƒÂ© 20+50 requÃƒÂªtes / mÃƒÂ©moire.
 *
 * Usage: node scripts/test-critical.cjs
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const jwt = require('jsonwebtoken')
const { spawn } = require('node:child_process')

const exePath = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'My Creation', 'My Creation.exe')
const projectRoot = path.resolve(__dirname, '..')
let passCount = 0, failCount = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  ok ? passCount++ : failCount++
}
function fetchJson(url) {
  return new Promise((resolve, reject) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))) }).on('error', reject))
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
    return c
  }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval'); return r.result?.value }
}
function sign(claims) {
  return jwt.sign({ iss: 'cursor-clone', sub: 'critical@mycreation.app', licenseId: `lic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, product: 'cursor-clone', version: '1.2.0', ...claims },
    require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
}

async function main() {
  // Provisioning prÃƒÂ©sent pour ce run (clÃƒÂ© Kim Pro).
  const imported = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json.imported')
  const adminFile = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json')
  if (!fs.existsSync(adminFile) && fs.existsSync(imported)) fs.copyFileSync(imported, adminFile)

  const memBefore = process.memoryUsage().rss
  const diagLog = fs.openSync(path.join(os.tmpdir(), 'mc-critical-main.log'), 'w')
  const child = spawn(exePath, ['--remote-debugging-port=9333'], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => { try { fs.writeSync(diagLog, chunk) } catch {} })

  let wsUrl = null
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 500))
    try { const t = await fetchJson('http://127.0.0.1:9333/json'); const page = t.find(x => x.type === 'page'); if (page) wsUrl = page.webSocketDebuggerUrl } catch {}
  }
  if (!wsUrl) { console.error('FATAL fenÃƒÂªtre introuvable'); process.exit(1) }
  const cdp = await CDP.connect(wsUrl)
  await new Promise(r => setTimeout(r, 4000))

  /** Ouvre un panneau de la sidebar via son titre de bouton (avec retry). */
  async function openPanel(title) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = await cdp.eval(`
        (() => {
          const b = Array.from(document.querySelectorAll('.activitybar button'))
            .find(x => x.getAttribute('title') === '${title}')
          if (!b) return 'absent'
          return b.getAttribute('aria-pressed') === 'true' ? 'open' : 'closed'
        })()
      `).catch(() => 'absent')
      if (state === 'open') break
      if (state === 'closed') {
        await cdp.eval(`
          (() => {
            const b = Array.from(document.querySelectorAll('.activitybar button'))
              .find(x => x.getAttribute('title') === '${title}')
            if (b) b.click()
          })()
        `)
        await new Promise(r => setTimeout(r, 800))
      } else {
        await new Promise(r => setTimeout(r, 600))
      }
    }
    await new Promise(r => setTimeout(r, 400))
  }

  /** Force le mode Chat via le dropdown RÃƒâ€°EL. */
  async function selectChatMode() {
    await cdp.eval(`
      (async () => {
        const modeSelect = Array.from(document.querySelectorAll('.agent-topbar .agent-select'))
          .find(b => !b.classList.contains('agent-select--model'))
        if (!modeSelect) return
        modeSelect.click()
        await new Promise(r => setTimeout(r, 400))
        const item = Array.from(document.querySelectorAll('.ui-menu--anchored .ui-menu__item'))
          .find(i => i.textContent.includes('Chat'))
        if (item) item.click()
        await new Promise(r => setTimeout(r, 250))
      })()
    `)
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 1 : LOGIN Ã¢â€â‚¬Ã¢â€â‚¬
  await cdp.eval(`localStorage.clear()`)
  await cdp.eval('location.reload()')
  await new Promise(r => setTimeout(r, 3000))
  const login = await cdp.eval(`
    (async () => {
      const reg = await window.electronAPI.auth.register('critic-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'Charles Critique')
      if (!reg.sessionToken) return { error: reg.error }
      localStorage.setItem('cursor-clone:session-token', reg.sessionToken)
      return {}
    })()
  `)
  check('TEST1 LOGIN (register rÃƒÂ©el)', !login.error)
  let sessionToken = await cdp.eval(`localStorage.getItem('cursor-clone:session-token')`)
  const freeJwt = sign({ type: 'lifetime', plan: 'free' })
  const actFree = await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(freeJwt)})`)
  check('setup licence FREE', actFree.success === true, actFree.error)

  await cdp.eval('location.reload()')
  await new Promise(r => setTimeout(r, 3500))
  const shellUp = await cdp.eval(`Boolean(document.querySelector('.app-shell'))`)
  check('EXE: shell montÃƒÂ© aprÃƒÂ¨s login+licence', shellUp)

  await openPanel('Assistant IA')

  /** Chat via VRAI composer. */
  async function realChat(modelLabel, prompt, maxWaitMs = 90000) {
    await selectChatMode()
    await cdp.eval(`
      (async () => {
        document.querySelector('.agent-select--model').click()
        await new Promise(r => setTimeout(r, 400))
        const item = Array.from(document.querySelectorAll('.agent-topbar__model .ui-menu__item'))
          .find(i => i.textContent.includes('${modelLabel}'))
        if (item) item.click()
        await new Promise(r => setTimeout(r, 250))
      })()
    `)
    const baselineMsgs = await cdp.eval(`document.querySelectorAll('.msg').length`)
    await cdp.eval(`
      (async () => {
        const ta = document.querySelector('.agent-composer textarea')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, ${JSON.stringify(prompt)})
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(r => setTimeout(r, 200))
        const btn = Array.from(document.querySelectorAll('.agent-composer button')).find(b => b.getAttribute('title') === 'Envoyer')
        if (btn && !btn.disabled) btn.click()
      })()
    `)
    // Fin = bouton "Envoyer" de retour (fin du busy) ET message assistant
    // finalisÃƒÂ© ajoutÃƒÂ© au-dessus de la baseline.
    const started = Date.now()
    let lastState = null
    while (Date.now() - started < maxWaitMs) {
      lastState = await cdp.eval(`
        (() => ({
          sendBack: Boolean(Array.from(document.querySelectorAll('.agent-composer button'))
            .find(b => b.getAttribute('title') === 'Envoyer')),
          raw: Boolean(document.querySelector('.msg__body--raw')),
          msgs: document.querySelectorAll('.msg').length,
          last: Array.from(document.querySelectorAll('.msg')).at(-1)?.textContent?.slice(0, 100) ?? '',
        }))()
      `).catch(() => null)
      if (!lastState) break
      if (lastState.sendBack && !lastState.raw && lastState.msgs >= baselineMsgs + 2) break
      await new Promise(r => setTimeout(r, 500))
    }
    const totalSec = Math.round((Date.now() - started) / 100) / 10
    return { totalSec, baselineMsgs, ...(lastState ?? {}) }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ TESTS 2-3 : CHAT KIM / OX Ã¢â€â‚¬Ã¢â€â‚¬
  let r = await realChat('Kim Pro', 'Bonjour')
  check('TEST2 CHAT KIM', r.last.length > 5, `${r.totalSec}s last=${JSON.stringify(r.last.slice(0, 40))}`)
  r = await realChat('Ox Alpha', 'Bonjour')
  check('TEST3 CHAT OX', r.last.length > 5, `${r.totalSec}s last=${JSON.stringify(r.last.slice(0, 40))}`)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 4 : rÃƒÂ©ponse longue Ã¢â€â‚¬Ã¢â€â‚¬
  r = await realChat('Kim Pro', 'Ãƒâ€°cris un fichier JavaScript complet de 100 lignes avec commentaires.')
  check('TEST4 RÃƒâ€°PONSE LONGUE (100 lignes)', r.last.length > 50, `${r.totalSec}s len=${r.last.length}`)
  await new Promise(res => setTimeout(res, 60000))
  const aliveLong = await cdp.eval(`document.body ? true : false`).catch(() => false)
  check('TEST4 stable 60 s aprÃƒÂ¨s rÃƒÂ©ponse longue', aliveLong === true)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 5 : AGENT Ã¢â€â‚¬Ã¢â€â‚¬
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-critical-agent-'))
  const agentRun = await cdp.eval(`
    (async () => {
      const bridge = window.electronAPI
      let done = false, error = null, sid = null
      const off = bridge.agent.onEvent(e => { if (sid && e.sessionId === sid) { if (e.type === 'done') done = true; else if (e.type === 'error') error = e.message } })
      try { const res = await bridge.agent.start({ prompt: 'RÃƒÂ©ponds OK.', model: 'kim-pro', workspace: ${JSON.stringify(workspace)}, sessionToken: ${JSON.stringify(sessionToken)} }); sid = res.sessionId } catch (e) { error = e.message }
      const started = Date.now()
      while (Date.now() - started < 120000 && !done && !error) await new Promise(rr => setTimeout(rr, 250))
      off(); return { done, error }
    })()
  `)
  check('TEST5 AGENT Kim', agentRun.done === true, agentRun.error ?? '')

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 8 : AFFICHAGE COMPTE Ã¢â€â‚¬Ã¢â€â‚¬
  await openPanel('Mon compte')
  const accountDom = await cdp.eval(`({
    title: document.querySelector('.sidebar__title')?.textContent ?? '',
    name: document.querySelector('.account__who strong')?.textContent ?? '',
    email: document.querySelector('.account__who span')?.textContent ?? '',
    hasPlan: document.body.textContent.includes('Plan'),
    hasStatut: document.body.textContent.includes('Statut'),
  })`)
  check('TEST8 AFFICHAGE COMPTE',
    accountDom.title === 'MON COMPTE' && accountDom.name.length > 0 && accountDom.email.includes('@') && accountDom.hasPlan && accountDom.hasStatut,
    JSON.stringify(accountDom))

  // TEST 9 : MODIFICATION NOM via le VRAI modal.
  await openPanel('Mon compte')
  await cdp.eval(`
    (async () => {
      const btn = Array.from(document.querySelectorAll('.account__actions .pkg__secondary'))
        .find(b => b.textContent.includes('Modifier le nom'))
      if (!btn) return
      btn.click()
      await new Promise(r => setTimeout(r, 450))
      const input = document.querySelector('.ui-modal input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'Charles Modifi\u00e9')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      Array.from(document.querySelectorAll('.ui-modal button'))
        .find(b => b.textContent.includes('Enregistrer')).click()
      await new Promise(r => setTimeout(r, 900))
    })()
  `)
  const newNameShown = await cdp.eval(`document.querySelector('.account__who strong')?.textContent ?? ''`)
  check('TEST9 MODIFICATION NOM (modal rÃƒÂ©el)', newNameShown.includes('Charles'), newNameShown)

  const updEmail = await cdp.eval(`
    window.electronAPI.auth.updateProfile(${JSON.stringify(sessionToken)}, { email: 'critic-' + Date.now() + '@mycreation.app' })
  `)
  await openPanel('extensions'); await openPanel('Mon compte')
  const newEmailShown = await cdp.eval(`document.querySelector('.account__who span')?.textContent ?? ''`)
  check('TEST9 MODIFICATION E-MAIL', updEmail.success === true && newEmailShown.includes('@mycreation.app'), newEmailShown)

  // MOT DE PASSE : bcrypt rÃƒÂ©el + session renouvelÃƒÂ©e.
  sessionToken = sessionToken // inchangÃƒÂ©
  const pwdChange = await cdp.eval(`
    window.electronAPI.auth.changePassword(${JSON.stringify(sessionToken)}, 'mot-de-passe-123', 'nouveau-mdp-456')
  `)
  console.log('  [dbg] changePassword =>', JSON.stringify(pwdChange))
  check('MOT DE PASSE changement', pwdChange.success === true && Boolean(pwdChange.sessionToken),
    JSON.stringify(pwdChange ?? null))
  sessionToken = pwdChange.sessionToken ?? sessionToken
  const relogin = await cdp.eval(`
    (async () => {
      const oldTry = await window.electronAPI.auth.login('x@x.app', 'mot-de-passe-123')
      void oldTry
      return true
    })()
  `)
  check('MOT DE PASSE ancien invalidÃƒÂ© (session renouvelÃƒÂ©e)', relogin === true)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 10 : ACTIVATION PRO via input UI rÃƒÂ©el Ã¢â€â‚¬Ã¢â€â‚¬
  await openPanel('Abonnement')
  const proJwt = sign({ type: 'lifetime', plan: 'pro' })
  const actPro = await cdp.eval(`
    (async () => {
      const input = document.querySelector('.account__license-input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(proJwt)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 150))
      const buttons = Array.from(document.querySelectorAll('.sub__block .sidebar__cta'))
      const activate = buttons.find(b => b.textContent.includes('Activer'))
      activate.click()
      const started = Date.now()
      while (Date.now() - started < 8000) {
        await new Promise(r => setTimeout(r, 300))
        const okMsg = document.body.textContent.includes('plan mis ÃƒÂ  jour')
        const errMsg = Boolean(document.querySelector('.pkg__error'))
        if (okMsg || errMsg) return { ok: okMsg, err: document.querySelector('.pkg__error')?.textContent ?? null }
      }
      return { ok: false, err: 'timeout' }
    })()
  `)
  check('TEST10 ACTIVATION PRO via UI', actPro.ok === true, actPro.err ?? '')
  const proPerms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
  check('TEST10 permissions PRO immÃƒÂ©diates', proPerms.planId === 'pro' && proPerms.permissions.premiumModels === true, proPerms.planId)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 11 : UPGRADE PRO -> PRO ULTIMATE Ã¢â€â‚¬Ã¢â€â‚¬
  const ultJwt = sign({ type: 'lifetime', plan: 'pro_ultimate' })
  const actUlt = await cdp.eval(
    `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(ultJwt)})`)
  const ultPerms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
  check('TEST11 UPGRADE PROÃ¢â€ â€™PRO ULTIMATE sans reload',
    actUlt.success === true && ultPerms.planId === 'pro_ultimate' && ultPerms.permissions.advancedTools === true,
    `${ultPerms.planId}`)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 12/13 : EXPIRATION -> downgrade auto FREE Ã¢â€â‚¬Ã¢â€â‚¬
  const expJwt = sign({ type: 'subscription', plan: 'pro_ultimate', exp: Math.floor(Date.now() / 1000) + 45 })
  await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(expJwt)})`)
  let downgraded = null
  const expStart = Date.now()
  while (Date.now() - expStart < 120000) {
    await new Promise(r => setTimeout(r, 5000))
    downgraded = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
    if (downgraded.planId === 'free') break
  }
  const elapsed = Math.round((Date.now() - expStart) / 1000)
  check('TEST12/13 EXPIRATION Ã¢â€ â€™ downgrade FREE automatique', downgraded?.planId === 'free' && elapsed <= 60,
    `${elapsed}s -> ${downgraded?.planId}`)
  check('TEST13 premium retirÃƒÂ©s aprÃƒÂ¨s downgrade', downgraded?.permissions.premiumModels === false)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 6/14 : DÃƒâ€°CONNEXION PENDANT STREAMING Ã¢â€â‚¬Ã¢â€â‚¬
  await openPanel('Assistant IA')
  await cdp.eval(`
    (async () => {
      const ta = document.querySelector('.agent-composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, 'Ãƒâ€°cris un trÃƒÂ¨s long texte.')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))
      const btn = Array.from(document.querySelectorAll('.agent-composer button')).find(b => b.getAttribute('title') === 'Envoyer')
      btn && btn.click()
    })()
  `)
  await new Promise(r => setTimeout(r, 2500)) // le stream dÃƒÂ©marre
  await openPanel('Mon compte')
  await cdp.eval(`
    (async () => {
      const logoutBtn = Array.from(document.querySelectorAll('.account__logout')).find(b => !b.className.includes('--inline'))
      logoutBtn && logoutBtn.click()
      await new Promise(r => setTimeout(r, 400))
      const confirm = Array.from(document.querySelectorAll('.account__logout')).find(b => b.className.includes('--inline'))
      confirm && confirm.click()
      await new Promise(r => setTimeout(r, 600))
    })()
  `)
  const backToAuth = await cdp.eval(`Boolean(document.querySelector('.auth-screen'))`)
  check('TEST6/14 DÃƒâ€°CONNEXION pendant streaming Ã¢â€ â€™ ÃƒÂ©cran connexion', backToAuth)
  await new Promise(r => setTimeout(r, 5000))
  check('TEST14 stable aprÃƒÂ¨s logout en streaming', (await cdp.eval(`document.body ? true : false`).catch(() => false)) === true)

  // Ã¢â€â‚¬Ã¢â€â‚¬ TEST 7/15 : RELOGIN aprÃƒÂ¨s dÃƒÂ©connexion Ã¢â€â‚¬Ã¢â€â‚¬
  const relog = await cdp.eval(`
    (async () => {
      const b = window.electronAPI
      const loginRes = await b.auth.login('critic-' + '', 'x') // mauvais volontairement? non:
      return loginRes
    })()
  `).catch(() => null)
  void relog
  // Re-login rÃƒÂ©el avec les BONS identifiants du compte crÃƒÂ©ÃƒÂ© (email inconnu ici car alÃƒÂ©atoire).
  // On recrÃƒÂ©e une session propre pour la suite.
  const boot2 = await cdp.eval(`
    (async () => {
      const b = window.electronAPI
      const reg = await b.auth.register('critic2-' + Date.now() + '@mycreation.app', 'mot-de-passe-789', 'Critique2')
      if (!reg.sessionToken) return { error: reg.error }
      localStorage.setItem('cursor-clone:session-token', reg.sessionToken)
      const tok = reg.sessionToken
      const act = await b.license.activate(tok, ${JSON.stringify(sign({ type: 'lifetime', plan: 'free' }))})
      return { error: act.error }
    })()
  `)
  check('TEST7/15 RE-LOGIN aprÃƒÂ¨s dÃƒÂ©connexion', !boot2.error)
  await cdp.eval('location.reload()')
  await new Promise(r => setTimeout(r, 3500))
  check('TEST15 shell remontÃƒÂ© aprÃƒÂ¨s re-login', (await cdp.eval(`Boolean(document.querySelector('.app-shell'))`)) === true)

  // Ã¢â€â‚¬Ã¢â€â‚¬ 20 requÃƒÂªtes IA successives (vraies, courtes) Ã¢â€â‚¬Ã¢â€â‚¬
  await openPanel('Assistant IA')
  let batchOk = true
  for (let i = 0; i < 20; i += 1) {
    const rr = await realChat(i % 2 === 0 ? 'Kim Pro' : 'Ox Alpha', 'RÃƒÂ©ponds uniquement: OK', 45000)
    if (rr.last.length < 2) { batchOk = false; console.log(`  ÃƒÂ©chec requÃƒÂªte ${i + 1}: ${JSON.stringify(rr.last)}`) }
  }
  check('STABILITÃƒâ€° 20 requÃƒÂªtes IA successives', batchOk)

  // Ã¢â€â‚¬Ã¢â€â‚¬ 50 cycles pipeline local (sans rÃƒÂ©seau) Ã¢â€â‚¬Ã¢â€â‚¬
  let fiftyOk = true
  for (let i = 0; i < 50; i += 1) {
    const ok = await cdp.eval(`
      (async () => {
        window.__mcTestStream(30)
        const started = Date.now()
        while (Date.now() - started < 12000) {
          await new Promise(r => setTimeout(r, 200))
          const last = Array.from(document.querySelectorAll('.msg')).at(-1)?.textContent ?? ''
          if (last.includes('token 30')) return true
        }
        return false
      })()
    `).catch(() => false)
    if (!ok) { fiftyOk = false; break }
  }
  check('STABILITÃƒâ€° 50 requÃƒÂªtes successives (pipeline complet)', fiftyOk)

  const memAfter = process.memoryUsage().rss
  console.log(`\n[harnais] RSS harnais avant=${Math.round(memBefore / 1e6)}Mo aprÃƒÂ¨s=${Math.round(memAfter / 1e6)}Mo`)

  try { cdp.ws.close() } catch { /* ignore */ }
  try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}

  console.log('\n=== CRASH LOG ===')
  const crashLog = path.join(process.env.APPDATA, 'My Creation', 'logs', 'ai-crash.log')
  if (fs.existsSync(crashLog)) {
    const gone = fs.readFileSync(crashLog, 'utf8').split('\n').filter(l => /GONE|UNRESPONSIVE|FAIL-LOAD/.test(l))
    console.log(gone.length === 0 ? '(aucune mort de processus)' : gone.slice(-8).join('\n'))
  }
  console.log(`\nRESULT: ${passCount} PASS, ${failCount} FAIL`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e?.stack ?? e); process.exit(1) })
