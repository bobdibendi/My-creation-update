// Debug: __mcTestStream est-il attaché dans l'EXE ?
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const exePath = path.join(process.env.LOCALAPPDATA, 'Programs', 'My Creation', 'My Creation.exe')
function fetchJson(url) {
  return new Promise((resolve, reject) => http.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d))) }).on('error', reject))
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
    const c = new CDP(ws)
    ws.onmessage = ev => { const m = JSON.parse(String(ev.data)); if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id); c.pending.delete(m.id); p.resolve(m.result) } }
    return c
  }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res) => this.pending.set(id, { resolve: res })) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.value }
}
async function main() {
  const child = spawn(exePath, ['--remote-debugging-port=9333'], { stdio: 'ignore' })
  let wsUrl = null
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 500))
    try { const t = await fetchJson('http://127.0.0.1:9333/json'); const page = t.find(x => x.type === 'page'); if (page) wsUrl = page.webSocketDebuggerUrl } catch {}
  }
  const cdp = await CDP.connect(wsUrl)
  await new Promise(r => setTimeout(r, 3500))
  await cdp.eval(`(async()=>{localStorage.clear();const b=window.electronAPI;const reg=await b.auth.register('dbg@x.app','mot-de-passe-123','D');localStorage.setItem('cursor-clone:session-token',reg.sessionToken)})()`)
  const jwt2 = require('jsonwebtoken')
  const tok = jwt2.sign({ iss: 'cursor-clone', sub: 'dbg@x.app', licenseId: 'l1', type: 'lifetime', product: 'cursor-clone' }, require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
  const sessionToken = await cdp.eval(`localStorage.getItem('cursor-clone:session-token')`)
  await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(tok)})`)
  await cdp.eval('location.reload()')
  await new Promise(r => setTimeout(r, 3000))
  await cdp.eval(`(async()=>{const b=[...document.querySelectorAll('.activitybar button')].find(x=>x.getAttribute('title')==='Assistant IA');b&&b.click();await new Promise(r=>setTimeout(r,700))})()`)
  const probe = await cdp.eval(`({
    hasFn: typeof window.__mcTestStream,
    assistantOpen: Boolean(document.querySelector('.agent-panel')),
    composer: Boolean(document.querySelector('.agent-composer textarea')),
    hookFile: Array.from(document.scripts).length,
  })`)
  console.log(JSON.stringify(probe))
  child.kill()
  require('node:child_process').spawn('taskkill', ['/IM', 'My Creation.exe', '/F'], { windowsHide: true })
  process.exit(0)
}
main()
