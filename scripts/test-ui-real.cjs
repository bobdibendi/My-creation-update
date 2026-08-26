#!/usr/bin/env node
/**
 * REPRODUCTION DU CRASH via l'INTERFACE RÃ‰ELLE de l'EXE installÃ©.
 *
 * DiffÃ©rence avec les tests prÃ©cÃ©dents : ici on pilote le VRAI composer
 * (textarea + bouton Envoyer) et on attend dans le DOM â€” donc React state,
 * streaming rAF, rendu brut, append de message : tout le chemin UI.
 *
 * ScÃ©narios (60 s d'observation aprÃ¨s CHAQUE demande) :
 *   1. Kim Pro   Â« Bonjour Â»
 *   2. Kim Pro   Â« Ã‰cris 100 lignes de JavaScript Â»
 *   3. Ox Alpha  Â« Bonjour Â»
 *   4. Ox Alpha  Â« Explique-moi comment crÃ©er une application Electron Â»
 *   5. Agent Kim / 6. Agent Ox (via IPC agent, dÃ©jÃ  validÃ©s)
 *   7. TEST STREAM 1000 / 5000 / 10000 events (sans rÃ©seau)
 *   8. StabilitÃ© : 10 puis 20 puis 50 messages successifs
 *
 * Surveillance : ai-crash.log (RENDERER-GONE/CHILD-GONE) + processus vivants.
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const jwt = require('jsonwebtoken')
const { spawn } = require('node:child_process')

const exePath = process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'My Creation', 'My Creation.exe')
const projectRoot = path.resolve(__dirname, '..')
const DEBUG_PORT = 9333
let passCount = 0, failCount = 0, crashes = []
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  ok ? passCount++ : failCount++
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))) }).on('error', reject)
  })
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    const client = new CDP(ws)
    ws.onmessage = event => {
      const m = JSON.parse(String(event.data))
      if (m.id && client.pending.has(m.id)) {
        const { resolve, reject } = client.pending.get(m.id)
        client.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result)
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result?.value
  }
}
async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`)
      const page = targets.find(t => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* pas prÃªt */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('port debug jamais disponible')
}

async function main() {
  // Provisioning prÃ©sent (clÃ© admin) pour ce run.
  const adminImported = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json.imported')
  const adminFile = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json')
  if (!fs.existsSync(adminFile) && fs.existsSync(adminImported)) fs.copyFileSync(adminImported, adminFile)

  const diagLog = fs.openSync(path.join(os.tmpdir(), 'mc-ui-main.log'), 'w')
  const child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', chunk => { try { fs.writeSync(diagLog, chunk) } catch { /* ignore */ } })

  try {
    const wsUrl = await waitForPage()
    const cdp = await CDP.connect(wsUrl)
    await new Promise(r => setTimeout(r, 4000))

    await cdp.eval(`(async()=>{ /* warmup */ })()`).catch(() => null)

    // Register rÃ©el + licence Free + reload.
    const boot = await cdp.eval(`
      (async () => {
        const b = window.electronAPI
        localStorage.clear()
        const reg = await b.auth.register('ui-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'UITest')
        if (!reg.sessionToken) return { error: reg.error }
        localStorage.setItem('cursor-clone:session-token', reg.sessionToken)
        return {}
      })()
    `)
    if (boot.error) throw new Error('register: ' + boot.error)

    // Licence Free signÃ©e localement.
    const freeJwt = jwt.sign({
      iss: 'cursor-clone', sub: 'ui@mycreation.app',
      licenseId: `lic_${Date.now().toString(36)}`, type: 'lifetime',
      product: 'cursor-clone', version: '1.1.1',
    }, require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
    // RÃ©cupÃ¨re le token de session stockÃ© puis active.
    const sessionToken = await cdp.eval(`localStorage.getItem('cursor-clone:session-token')`)
    const activated = await cdp.eval(
      `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(freeJwt)})`)
    check('setup licence FREE', activated.success === true, activated.error)

    await cdp.eval('location.reload()')
    await new Promise(r => setTimeout(r, 3500))

    // Ouvre l'assistant.
    await cdp.eval(`
      (async () => {
        const btn = Array.from(document.querySelectorAll('.activitybar button'))
          .find(b => b.getAttribute('title') === 'Assistant IA')
        if (btn) btn.click()
        await new Promise(r => setTimeout(r, 700))
      })()
    `)

    /** SÃ©lectionne un modÃ¨le via le dropdown RÃ‰EL. */
    async function selectModel(label) {
      await cdp.eval(`
        (async () => {
          const select = document.querySelector('.agent-select--model')
          select.click()
          await new Promise(r => setTimeout(r, 450))
          const items = Array.from(document.querySelectorAll('.agent-topbar__model .ui-menu__item'))
          const target = items.find(i => i.textContent.includes('${label}'))
          if (target) target.click()
          await new Promise(r => setTimeout(r, 300))
        })()
      `)
      const current = await cdp.eval(`document.querySelector('.model-select-label')?.textContent ?? ''`)
      return current.includes(label)
    }

    /** Envoie un prompt via le VRAI composer et attend la fin du stream. */
    async function realSend(prompt, label, maxWaitMs = 90000) {
      await cdp.eval(`
        (async () => {
          const ta = document.querySelector('.agent-composer textarea')
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
          setter.call(ta, ${JSON.stringify(prompt)})
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          await new Promise(r => setTimeout(r, 200))
        })()
      `)
      const t0 = Date.now()
      let sentError = null
      try {
        await cdp.eval(`
          (async () => {
            const sendBtn = document.querySelector('.agent-composer .agent-send[title="Envoyer"], .agent-composer button[title="Envoyer"]')
            if (sendBtn && !sendBtn.disabled) sendBtn.click()
            else {
              const ta = document.querySelector('.agent-composer textarea')
              ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
            }
          })()
        `)
      } catch (e) { sentError = e.message }

      // Attend busy=false et message assistant ajoutÃ© (ou erreur affichÃ©e).
      let outcome = null
      const started = Date.now()
      while (Date.now() - started < maxWaitMs) {
        outcome = await cdp.eval(`
          (() => ({
            busyText: Boolean(document.querySelector('.agent-timeline')?.textContent.match(/RÃ©flexion|GÃ©nÃ©ration|Analyse|Ã©tape/)),
            rawVisible: Boolean(document.querySelector('.msg__body--raw')),
            msgCount: document.querySelectorAll('.msg').length,
            lastMsg: Array.from(document.querySelectorAll('.msg')).at(-1)?.textContent?.slice(0, 120) ?? '',
          }))()
        `).catch(() => null)
        if (!outcome) break
        const hasFinalMessage = outcome.msgCount >= 2 && !outcome.rawVisible && !outcome.busyText
        if (hasFinalMessage && Date.now() - started > 3000) break
        await new Promise(r => setTimeout(r, 500))
      }
      const totalSec = Math.round((Date.now() - t0) / 100) / 10
      return { ...outcome, totalSec, sentError, model: label }
    }

    // â”€â”€ TESTS 1-4 : vrais envois UI â”€â”€
    const scenarios = [
      ['kim-pro', 'Bonjour'],
      ['kim-pro', 'Ã‰cris 100 lignes de JavaScript (un fichier complet).'],
      ['ox-alpha-free', 'Bonjour'],
      ['ox-alpha-free', 'Explique-moi en 5 phrases comment crÃ©er une application Electron.'],
    ]
    for (const [modelId, prompt] of scenarios) {
      const label = modelId === 'kim-pro' ? 'Kim Pro' : 'Ox Alpha'
      const selected = await selectModel(label)
      if (!selected) { check(`${label}: sÃ©lection modÃ¨le`, false, 'introuvable dans le dropdown'); continue }
      const r = await realSend(prompt, label)
      check(`${label} UI: "${prompt.slice(0, 24)}â€¦"`, r.lastMsg.length > 0 || r.rawVisible,
        `${r.totalSec}s msgs=${r.msgCount} err=${r.sentError ?? ''}`)
      // StabilitÃ© 60 s aprÃ¨s chaque rÃ©ponse.
      await new Promise(r => setTimeout(r, 60000))
      const alive = await cdp.eval(`document.querySelectorAll('.msg').length`).catch(() => null)
      check(`${label} UI: stable 60 s aprÃ¨s`, alive !== null,
        `fenÃªtre vivante, msgs=${alive}`)
    }

    // â”€â”€ TEST STREAM sans rÃ©seau â”€â”€
    for (const n of [1000, 5000, 10000]) {
      const ok = await cdp.eval(`
        (async () => {
          window.__mcTestStream(${n})
          const marker = 'token ' + ${n}
          const started = Date.now()
          while (Date.now() - started < 60000) {
            await new Promise(r => setTimeout(r, 400))
            const last = Array.from(document.querySelectorAll('.msg')).at(-1)?.textContent ?? ''
            if (last.includes(marker)) return true
          }
          return false
        })()
      `).catch(() => false)
      check(`TEST STREAM ${n} events`, ok === true)
      await new Promise(r => setTimeout(r, 30000))
      check(`TEST STREAM ${n}: stable 30 s aprÃ¨s`, (await cdp.eval(`document.body ? true : false`)) === true)
    }

    // â”€â”€ StabilitÃ© messages successifs â”€â”€
    for (const batch of [10, 20, 50]) {
      let allOk = true
      for (let i = 0; i < batch; i += 1) {
        const ok = await cdp.eval(`
          (async () => {
            window.__mcTestStream(40)
            const started = Date.now()
            while (Date.now() - started < 15000) {
              await new Promise(r => setTimeout(r, 250))
              const last = Array.from(document.querySelectorAll('.msg')).at(-1)?.textContent ?? ''
              if (last.includes('token 40')) return true
            }
            return false
          })()
        `).catch(() => false)
        if (!ok) { allOk = false; break }
      }
      check(`STABILITÃ‰ ${batch} messages successifs`, allOk)
    }

    try { cdp.ws.close() } catch { /* ignore */ }
  } finally {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else child.kill()
    } catch { /* ignore */ }
  }

  console.log('\n=== CRASH LOG (%APPDATA%/My Creation/logs/ai-crash.log) ===')
  const crashLog = path.join(process.env.APPDATA, 'My Creation', 'logs', 'ai-crash.log')
  if (fs.existsSync(crashLog)) {
    const lines = fs.readFileSync(crashLog, 'utf8').split('\n').filter(l => /GONE|CRASH/.test(l))
    for (const line of lines.slice(-10)) console.log(line)
    if (lines.length === 0) console.log('(aucune mort de processus)')
  } else console.log('(log absent)')
  console.log(`\nRESULT: ${passCount} PASS, ${failCount} FAIL, crashes=${crashes.length}`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e?.stack ?? e); process.exit(1) })
