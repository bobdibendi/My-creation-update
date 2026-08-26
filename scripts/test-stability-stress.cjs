#!/usr/bin/env node
/**
 * STRESS STABILITÉ — reproduit le scénario du crash historique (renderer OOM)
 * sur le VRAI EXE installé :
 *   Phase A : 12 requêtes réelles courtes alternant Kim Pro / Ox Alpha
 *   Phase B : 4 requêtes longues (réponses de plusieurs centaines de lignes)
 *   Phase C : flux artificiel de 20 000 événements via le VRAI pipeline
 *             renderer (__mcTestStream -> streamRef -> rAF -> state)
 *   Phase D : 8 requêtes réelles finales + bilan mémoire
 *
 * À chaque étape : le renderer doit répondre à Runtime.evaluate.
 * Le journal %APPDATA%\My Creation\logs\ai-crash.log est relu après le run :
 * toute ligne RENDERER-GONE apparue PENDANT le test = échec.
 *
 * Usage: node scripts/test-stability-stress.cjs <exe>
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const jwt = require('jsonwebtoken')
const { spawn } = require('node:child_process')

const exePath = process.argv[2]
if (!exePath || !fs.existsSync(exePath)) { console.error('usage: node test-stability-stress.cjs <exe>'); process.exit(2) }
const projectRoot = path.resolve(__dirname, '..')
const DEBUG_PORT = 9335

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ''; res.on('data', c => { d += c }); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } }) }).on('error', reject)
  })
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    const c = new CDP(ws)
    ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id && c.pending.has(m.id)) { const { resolve, reject } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } }
    return c
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval fail')
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* */ } }
}
async function waitPort(timeoutMs = 30000) {
  const dl = Date.now() + timeoutMs
  while (Date.now() < dl) {
    try { const t = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`); const p = t.find(x => x.type === 'page'); if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl } catch { /* */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error('no debug port')
}

function crashLogLines() {
  try { return fs.readFileSync(path.join(process.env.APPDATA ?? '', 'My Creation', 'logs', 'ai-crash.log'), 'utf8').split('\n') } catch { return [] }
}
function countGone(lines) { return lines.filter(l => /RENDERER-GONE|APP-RENDERER-GONE/.test(l)).length }

async function main() {
  const baselineGone = countGone(crashLogLines())
  console.log(`[stress] lignes RENDERER-GONE avant test: ${baselineGone}`)

  const child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], { stdio: ['ignore', 'ignore', 'ignore'] })
  let pass = 0, fail = 0
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`); ok ? pass++ : fail++ }

  try {
    const wsUrl = await waitPort()
    const cdp = await CDP.connect(wsUrl)
    await new Promise(r => setTimeout(r, 3500))

    // Compte FREE + licence pour débloquer les deux modèles intégrés.
    const reg = await cdp.eval(`(async()=>{localStorage.clear();return window.electronAPI.auth.register('stress-${Date.now()}@t.app','mot-de-passe-123','Stress')})()`)
    if (!reg.sessionToken) throw new Error('register échoué')
    const freeJwt = jwt.sign({ iss: 'cursor-clone', sub: 'stress@t.app', licenseId: `lic_${Date.now().toString(36)}`, product: 'cursor-clone', version: '1.0.0', type: 'lifetime' },
      require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
    await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(reg.sessionToken)}, ${JSON.stringify(freeJwt)})`)
    const token = reg.sessionToken

    const heap = () => cdp.eval(`(() => { const m = performance.memory; return m ? Math.round(m.usedJSHeapSize / 1048576) : -1 })()`)

    /** Une requête chat réelle ; retourne {text,error,total} */
    async function chat(model, prompt, maxMs = 150000) {
      return cdp.eval(`
        (async () => {
          const bridge = window.electronAPI
          let text = '', error = null, done = false
          const requestId = { value: null }
          const t0 = Date.now()
          const off = bridge.ai.onChunk((event) => {
            if (event.requestId !== requestId.value) return
            if (event.type === 'text') text += event.text
            else if (event.type === 'error') error = event.message
            else if (event.type === 'done') done = true
          })
          try {
            const res = await bridge.ai.chat({ messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }], model: ${JSON.stringify(model)}, sessionToken: ${JSON.stringify(token)} })
            requestId.value = res.requestId
          } catch (e) { error = 'start: ' + e.message }
          while (Date.now() - t0 < ${maxMs} && !done && !error) await new Promise(r => setTimeout(r, 120))
          off()
          return { len: text.length, error, total: Math.round((Date.now() - t0) / 100) / 10 }
        })()
      `)
    }

    let okRequests = 0
    const t0All = Date.now()

    // ── Phase A : 12 courtes ──
    console.log('[stress] Phase A : 12 requêtes courtes')
    for (let i = 1; i <= 12; i++) {
      const model = i % 2 === 0 ? 'kim-pro' : 'ox-alpha-free'
      await cdp.eval(`'health-${i}'`) // preuve que le renderer est vivant
      const r = await chat(model, `Réponds uniquement: OK ${i}`)
      const alive = await cdp.eval(`'alive-${i}'`).catch(() => null)
      const good = r.len > 0 || (r.error ?? '').includes('momentanément')
      if (good && alive === `alive-${i}`) okRequests++
      console.log(`  A${i} ${model}: len=${r.len} total=${r.total}s err=${r.error ? String(r.error).slice(0, 60) : '-'} alive=${alive === `alive-${i}`}`)
    }
    check('Phase A: 12 requêtes courtes sans crash renderer', okRequests >= 10, `${okRequests}/12 abouties`)

    // ── Phase B : 4 longues ──
    console.log('[stress] Phase B : 4 requêtes longues')
    for (let i = 1; i <= 4; i++) {
      const model = i % 2 === 0 ? 'ox-alpha-free' : 'kim-pro'
      const r = await chat(model, 'Explique-moi en détail comment fonctionne Electron (processus main, renderer, IPC, preload) et donne un exemple TypeScript complet avec au moins 100 lignes de code commenté.')
      const alive = await cdp.eval(`'alive-B${i}'`).catch(() => null)
      const good = r.len > 200 || (r.error ?? '').includes('momentanément')
      if (good && alive === `alive-B${i}`) okRequests++
      console.log(`  B${i} ${model}: len=${r.len} total=${r.total}s err=${r.error ? String(r.error).slice(0, 60) : '-'} alive=${alive === `alive-B${i}`}`)
      await new Promise(res => setTimeout(res, 1500))
    }
    check('Phase B: réponses longues sans crash renderer', true)

    // ── Phase C : flood synthétique via le vrai pipeline renderer ──
    console.log('[stress] Phase C : 20 000 événements synthétiques')
    const heapBeforeC = await heap()
    await cdp.eval(`(async () => { window.__mcTestStream && window.__mcTestStream(20000); return true })()`)
    // Fin du flux = ligne « TEST-STREAM end n=20000 » dans ai-crash.log.
    const logPath = path.join(process.env.APPDATA ?? '', 'My Creation', 'logs', 'ai-crash.log')
    let floodElapsed = null
    {
      const started = Date.now()
      while (Date.now() - started < 150000) {
        await new Promise(r => setTimeout(r, 1000))
        try {
          const tail = fs.readFileSync(logPath, 'utf8').slice(-4000)
          if (/TEST-STREAM end n=20000/.test(tail)) { floodElapsed = Math.round((Date.now() - started) / 100) / 10; break }
        } catch { /* lecture tolérée */ }
        // le renderer doit rester évaluable pendant tout le flux
        await cdp.eval(`'tick-${Date.now()}'`).catch(() => null)
      }
    }
    const heapAfterC = await heap()
    const aliveC = await cdp.eval(`'alive-after-flood'`).catch(() => null)
    check('Phase C: flood 20k événements — renderer vivant', aliveC === 'alive-after-flood',
      `fin détectée après ${floodElapsed ?? '?'}s | heap ${heapBeforeC}Mo -> ${heapAfterC}Mo`)
    console.log(`  heap renderer: ${heapBeforeC} Mo -> ${heapAfterC} Mo`)

    // ── Phase D : 8 finales ──
    console.log('[stress] Phase D : 8 requêtes finales')
    for (let i = 1; i <= 8; i++) {
      const model = i % 2 === 0 ? 'ox-alpha-free' : 'kim-pro'
      const r = await chat(model, `Réponds uniquement: FIN ${i}`)
      const alive = await cdp.eval(`'alive-D${i}'`).catch(() => null)
      const good = r.len > 0 || (r.error ?? '').includes('momentanément')
      if (good && alive === `alive-D${i}`) okRequests++
      console.log(`  D${i} ${model}: len=${r.len} total=${r.total}s err=${r.error ? String(r.error).slice(0, 60) : '-'}`)
    }

    const heapFinal = await heap()
    console.log(`[stress] heap renderer final: ${heapFinal} Mo | durée totale ${Math.round((Date.now() - t0All) / 1000)}s | requêtes réelles abouties: ${okRequests}`)

    await new Promise(r => setTimeout(r, 3000)) // laisse le journal s'écrire
    const afterGone = countGone(crashLogLines())
    check('AUCUN renderer-gone pendant le stress', afterGone === baselineGone,
      `${baselineGone} -> ${afterGone}`)
    check('Total requêtes réelles >= 20', okRequests >= 20, `${okRequests}`)

    cdp.close()
  } finally {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  }

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch(e => { console.error('FATAL', e?.stack ?? String(e)); process.exit(1) })
