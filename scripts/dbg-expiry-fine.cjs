#!/usr/bin/env node
/** Reproduction ciblée : expiration licence PRO courte, polling fin.
 *  Usage: node scripts/dbg-expiry-fine.cjs <exe>
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const jwt = require('jsonwebtoken')
const { spawn } = require('node:child_process')

const exePath = process.argv[2]
if (!exePath || !fs.existsSync(exePath)) { console.error('usage: node dbg-expiry-fine.cjs <exe>'); process.exit(2) }
const projectRoot = path.resolve(__dirname, '..')
const DEBUG_PORT = 9334

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

async function main() {
  const child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], { stdio: ['ignore', 'ignore', 'ignore'] })
  try {
    const wsUrl = await waitPort()
    const cdp = await CDP.connect(wsUrl)
    await new Promise(r => setTimeout(r, 3500))
    const reg = await cdp.eval(`(async()=>{localStorage.clear();return window.electronAPI.auth.register('expdbg-${Date.now()}@t.app','mot-de-passe-123','ExpDbg')})()`)
    const token = reg.sessionToken
    const expSec = Math.floor(Date.now() / 1000) + 15
    const lic = jwt.sign({ iss: 'cursor-clone', sub: 'expdbg@t.app', licenseId: `lic_${Date.now().toString(36)}`, product: 'cursor-clone', version: '1.0.0', type: 'subscription', plan: 'pro', exp: expSec }, require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
    const act = await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(token)}, ${JSON.stringify(lic)})`)
    console.log(`[T] activate success=${act.success} err=${act.error ?? '-'}`)
    const t0 = Date.now()
    let flipped = null
    for (let i = 0; i < 45; i++) {
      const s = await cdp.eval(`(async()=>{const b=window.electronAPI;const st=await b.license.getStatus(${JSON.stringify(token)}).catch(e=>({err:String(e)}));const pm=await b.permissions.get(${JSON.stringify(token)}).catch(e=>({err:String(e)}));return{st,pm}})()`)
      const t = ((Date.now() - t0) / 1000).toFixed(1)
      const stActive = s.st ? s.st.active : '?'
      const stErr = s.st && s.st.error ? s.st.error : ''
      const planId = s.pm ? s.pm.planId : '?'
      console.log(`t=${t}s status.active=${stActive} ${stErr ? `(${stErr})` : ''} | plan=${planId}`)
      if (planId === 'free' && flipped === null) { flipped = Number(t); break }
      await new Promise(r => setTimeout(r, 1000))
    }
    console.log(`RESULT: flip at t=${flipped ?? 'NEVER'}s (licence exp=15s)`)
    cdp.close()
  } finally {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
}
main().catch(e => { console.error('FATAL', e?.stack ?? String(e)); process.exit(1) })
