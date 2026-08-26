// Vérifie que le MAIN process écrit bien dans ai-crash.log pendant un chat réel.
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const jwt = require('jsonwebtoken')
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
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise(res => this.pending.set(id, { resolve: res })) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.value }
}
async function main() {
  // Restaure provisioning.
  const imported = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json.imported')
  const adminFile = path.join(process.env.APPDATA, 'My Creation', 'admin-keys.json')
  if (!fs.existsSync(adminFile) && fs.existsSync(imported)) fs.copyFileSync(imported, adminFile)

  const child = spawn(exePath, ['--remote-debugging-port=9333'], { stdio: 'ignore' })
  let wsUrl = null
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 500))
    try { const t = await fetchJson('http://127.0.0.1:9333/json'); const page = t.find(x => x.type === 'page'); if (page) wsUrl = page.webSocketDebuggerUrl } catch {}
  }
  const cdp = await CDP.connect(wsUrl)
  await new Promise(r => setTimeout(r, 3500))
  await cdp.eval(`(async()=>{localStorage.clear();const b=window.electronAPI;const reg=await b.auth.register('logchk@x.app','mot-de-passe-123','L');localStorage.setItem('cursor-clone:session-token',reg.sessionToken)})()`)
  const tok = require('jsonwebtoken').sign({ iss: 'cursor-clone', sub: 'logchk@x.app', licenseId: 'lx', type: 'lifetime', product: 'cursor-clone' }, require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
  const sessionToken = await cdp.eval(`localStorage.getItem('cursor-clone:session-token')`)
  await cdp.eval(`window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(tok)})`)
  // Chat DIRECT IPC (comme le font useAssistant/Composer en couche transport).
  const out = await cdp.eval(`
    (async () => {
      const b = window.electronAPI
      let text = '', done = false, error = null
      const off = b.ai.onChunk(ev => {
        if (ev.requestId !== id.value) return
        if (ev.type === 'text') text += ev.text
        else if (ev.type === 'error') error = ev.message
        else if (ev.type === 'done') done = true
      })
      const id = { value: null }
      try { const res = await b.ai.chat({ messages: [{ role: 'user', content: 'Bonjour' }], model: 'kim-pro', sessionToken: ${JSON.stringify(sessionToken)} }) ; id.value = res.requestId } catch (e) { error = e.message }
      const started = Date.now()
      while (Date.now() - started < 60000 && !done && !error) await new Promise(r => setTimeout(r, 200))
      off()
      return { len: text.length, done, error }
    })()
  `)
  console.log('chat:', JSON.stringify(out))
  await new Promise(r => setTimeout(r, 1500))
  child.kill()
  spawn('taskkill', ['/IM', 'My Creation.exe', '/F'], { windowsHide: true })
  const logPath = path.join(process.env.APPDATA, 'My Creation', 'logs', 'ai-crash.log')
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l && !l.includes('[renderer]'))
  console.log('=== dernières lignes MAIN ===')
  for (const line of lines.slice(-12)) console.log(line.slice(0, 140))
  process.exit(0)
}
main()
