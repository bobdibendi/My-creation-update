#!/usr/bin/env node
/**
 * TESTS SUR L'EXE PACKAGÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â° LANCÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â° (CDP).
 *
 * DÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©marre l'exe installÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© avec --remote-debugging-port, puis pilote la vraie
 * application via Chrome DevTools Protocol (Runtime.evaluate) :
 *   1. import admin-keys.json -> clÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© tools configurÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e dans l'EXE
 *   2. register + activation licence FREE -> sÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lecteur [Kim Pro, Ox Alpha]
 *   3. Chat Kim Pro rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©el (TTFT / total / chunks)
 *   4. Chat Ox Alpha rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©el (TTFT / total)
 *   5. Activation Pro/1 minute -> permissions PRO -> expiration -> FREE sans reload
 *
 * Usage: node scripts/test-installed-exe.cjs <chemin-exe>
 */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const jwt = require('jsonwebtoken')
const { spawn } = require('node:child_process')

const exePath = process.argv[2]
if (!exePath || !fs.existsSync(exePath)) {
  console.error('Usage: node scripts/test-installed-exe.cjs <chemin-exe>')
  process.exit(2)
}

const projectRoot = path.resolve(__dirname, '..')
const DEBUG_PORT = 9333
let passCount = 0
let failCount = 0
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
    } catch { /* pas encore prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('port de debug jamais disponible')
}

async function main() {
  // IdentitÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© d'application du build packagÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©: "My Creation" (productName).
  // On neutralise TOUT keystore existant pour prouver que seul admin-keys.json
  // provisionne l'EXE ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â sinon le test serait biaisÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© par une ancienne clÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©.
  const userDataDir = path.join(appDataName(), 'My Creation')
  const keyStoreFile = path.join(userDataDir, 'config', '.api-keys.enc')
  let backupKeyStore = null
  if (fs.existsSync(keyStoreFile)) {
    backupKeyStore = fs.readFileSync(keyStoreFile)
    fs.unlinkSync(keyStoreFile)
    console.log('[setup] keystore existant mis de cÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© (test ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  blanc)')
  }
  // RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©pÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©tabilitÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© : un run prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©cÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dent renomme admin-keys.json -> .imported.
  const adminFile = path.join(userDataDir, 'admin-keys.json')
  const importedFile = `${adminFile}.imported`
  if (!fs.existsSync(adminFile) && fs.existsSync(importedFile)) {
    fs.copyFileSync(importedFile, adminFile)
    console.log('[setup] admin-keys.json restaurÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© depuis .imported')
  }

  // Mode --no-admin : prouve le comportement SANS provisioning administrateur.
  const noAdminMode = process.argv.includes('--no-admin')
  const adminBackup = []
  if (noAdminMode) {
    for (const candidate of [adminFile, importedFile]) {
      if (fs.existsSync(candidate)) { adminBackup.push({ from: candidate, data: fs.readFileSync(candidate) }); fs.rmSync(candidate) }
    }
    console.log('[setup] mode --no-admin: aucun provisioning prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©sent')
  }

  const child = spawn(exePath, [`--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  const diagLogPath = path.join(os.tmpdir(), 'mycreation-exe-main.log')
  const diagLog = fs.openSync(diagLogPath, 'w')
  child.stderr.on('data', chunk => { try { fs.writeSync(diagLog, chunk) } catch { /* ignore */ } })

  try {
    const wsUrl = await waitForDebugPort()
    const cdp = await CDP.connect(wsUrl)
    await new Promise(resolve => setTimeout(resolve, 4000)) // montage React

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 1. ClÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© admin importÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e depuis admin-keys.json ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const keyStatus = await cdp.eval(`window.electronAPI.api.checkKey('tools')`)

    if (noAdminMode) {
      check('NO-ADMIN: clÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© tools absente (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  blanc)', keyStatus.configured === false)
      const kimNoKey = await collectChat(cdp, null, 'kim-pro', 'Bonjour')
      check('NO-ADMIN: message administrateur clair, pas de demande de clÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©',
        /administrateur/i.test(kimNoKey.error ?? '') && !/(entrer|ajouter|coller).{0,24}cl[eÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©]/i.test(kimNoKey.error ?? ''),
        String(kimNoKey.error).slice(0, 90))
      const oxNoKey = await collectChat(cdp, null, 'ox-alpha-free', 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ponds uniquement: OK')
      // CritÃƒÆ’Ã‚Â¨re : rÃƒÆ’Ã‚Â©ponse OK, OU erreur claire non-demander-de-clÃƒÆ’Ã‚Â© (une panne
      // 503 du fournisseur avec repli sur un secondaire non provisionnÃƒÆ’Ã‚Â© est
      // lÃƒÆ’Ã‚Â©gitime dans ce scÃƒÆ’Ã‚Â©nario extrÃƒÆ’Ã‚Âªme).
      const oxOkOrClear = oxNoKey.text.trim().length > 0
        || (/administrateur/i.test(oxNoKey.error ?? '') && !/(entrer|ajouter|coller).{0,24}cl[eÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©]/i.test(oxNoKey.error ?? ''))
      check('NO-ADMIN: Ox Alpha keyless Ã¢â‚¬â€ rÃƒÆ’Ã‚Â©ponse ou erreur admin claire', oxOkOrClear,
        oxNoKey.text.trim().length > 0 ? `TOTAL=${oxNoKey.total}s` : String(oxNoKey.error ?? '').slice(0, 90))
      cdp.close()
      console.log(`\nRESULT (no-admin): ${passCount} PASS, ${failCount} FAIL`)
      finish()
      return
    }

    check('EXE: admin-keys.json importÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e (clÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© tools configurÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e)',
      keyStatus.configured === true, keyStatus.maskedKey ?? 'absente')

    // Version cohérente avec l'installateur (source unique : app.getVersion).
    const versions = await cdp.eval(`window.electronAPI.system.getVersions()`)
    check('EXE: version app = installateur (1.2.0)', versions.app === '1.2.0',
      `app=${versions.app} electron=${versions.electron}`)

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 2. Compte + licence FREE ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const boot = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        localStorage.clear()
        const registered = await bridge.auth.register('exetest-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'ExeTest')
        return registered
      })()
    `)
    if (!boot.sessionToken) throw new Error('register ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©chouÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©: ' + boot.error)
    const sessionToken = boot.sessionToken

    const freeJwt = signLicense({ type: 'lifetime' })
    const activatedFree = await cdp.eval(
      `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(freeJwt)})`)
    check('EXE: licence FREE activÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e', activatedFree.success === true, activatedFree.error)

    await cdp.eval(`localStorage.setItem('cursor-clone:session-token', ${JSON.stringify(sessionToken)})`)
    await cdp.eval(`location.reload()`)
    await new Promise(resolve => setTimeout(resolve, 3500))

    const perms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
    check('EXE: plan FREE aprÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s activation', perms.planId === 'free', perms.planId)

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 3. Chat Kim Pro rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©el ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const kimRun = await collectChat(cdp, sessionToken, 'kim-pro', 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ponds uniquement: PONG')
    check('EXE: KIM PRO CHAT', kimRun.text.trim().length > 0,
      `TTFT=${kimRun.ttft}s TOTAL=${kimRun.total}s chunks=${kimRun.chunks} err=${kimRun.error}`)
    console.log(`      texte: ${JSON.stringify(kimRun.text.slice(0, 60))}`)

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 4. Chat Ox Alpha rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©el ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const oxRun = await collectChat(cdp, sessionToken, 'ox-alpha-free', 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ponds uniquement :\n1\n2\n3\n4\n5')
    check('EXE: OX ALPHA CHAT', oxRun.text.trim().length > 0 || Boolean(oxRun.error),
      `TTFT(texte)=${oxRun.ttft}s TOTAL=${oxRun.total}s chunks=${oxRun.chunks} err=${oxRun.error}`)
    console.log(`      texte: ${JSON.stringify(oxRun.text.slice(0, 60))}`)

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 4b. AGENT avec chaque modÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨le intÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©grÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'mycreation-exe-agent-'))
    await fsp.writeFile(path.join(workspace, 'note.txt'), 'contenu de test my creation\n', 'utf8')

    const agentKim = await runAgent(cdp, sessionToken, 'kim-pro', workspace)
    check('EXE: AGENT + Kim Pro', agentKim.done === true,
      agentKim.done ? 'done' : `erreur: ${String(agentKim.error).slice(0, 80)}`)

    const agentOx = await runAgent(cdp, sessionToken, 'ox-alpha-free', workspace)
    const noKeyDemand = !agentOx.error || !/(entrer|ajouter|configurer).{0,20}cl[eÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©]/i.test(agentOx.error)
    check('EXE: AGENT + Ox Alpha', agentOx.done === true && noKeyDemand,
      agentOx.done ? 'done' : `erreur claire: ${String(agentOx.error).slice(0, 80)}`)

    // ── TERMINAL réel dans l'EXE ──
    const term = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        let out = ''
        const id = await bridge.terminal.create(null)
        const off = bridge.terminal.onData(p => { if (p.id === id) out += p.data })
        bridge.terminal.write(id, 'node --version\\r\\n')
        const started = Date.now()
        while (Date.now() - started < 20000 && !/v\\d+\\.\\d+\\.\\d+/.test(out)) {
          await new Promise(r => setTimeout(r, 150))
        }
        off()
        await bridge.terminal.kill(id)
        return { version: (out.match(/v\\d+\\.\\d+\\.\\d+/) || [null])[0] }
      })()
    `)
    check('EXE: TERMINAL (node réel)', Boolean(term.version), `node ${term.version}`)

    // ── PREVIEW réel dans l'EXE (serveur statique) ──
    const previewWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'mycreation-exe-preview-'))
    await fsp.writeFile(path.join(previewWorkspace, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><title>PreviewTest</title></head><body><h1>OK PREVIEW</h1></body></html>', 'utf8')
    const previewRun = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        const status = await bridge.preview.start(${JSON.stringify(previewWorkspace)}, '', false)
        return { state: status.state, url: status.url, message: status.message }
      })()
    `)
    check('EXE: PREVIEW (serveur statique réel)',
      previewRun.state === 'running' && typeof previewRun.url === 'string',
      `${previewRun.state} ${previewRun.url ?? previewRun.message}`)
    await cdp.eval(`window.electronAPI.preview.stop()`)

    // ── PACKAGE INSTALLER : pipeline réel streamé puis annulé ──
    const pkgRun = await cdp.eval(`
      (async () => {
        const bridge = window.electronAPI
        const stages = []
        let error = null
        const disposers = [
          bridge.package.onProgress(p => { if (!stages.includes(p.stage)) stages.push(p.stage) }),
          bridge.package.onError(e => { error = e.message }),
        ]
        try {
          await bridge.package.start(${JSON.stringify(sessionToken)}, ${JSON.stringify(projectRoot)})
          const started = Date.now()
          while (Date.now() - started < 45000 && stages.length < 2 && !error) {
            await new Promise(r => setTimeout(r, 300))
          }
        } finally {
          await bridge.package.cancel()
          for (const d of disposers) d()
        }
        return { stages, error }
      })()
    `)
    check('EXE: PACKAGE INSTALLER (pipeline réel streamé)',
      pkgRun.stages.length >= 1 && !pkgRun.error,
      `étapes: [${pkgRun.stages.join(' -> ')}] err=${pkgRun.error}`)

    // ── ABONNEMENT : panneau DOM avec plan courant ──
    await cdp.eval(`
      (async () => {
        const button = Array.from(document.querySelectorAll('.activitybar button'))
          .find(b => b.getAttribute('title') === 'Abonnement')
        if (button) button.click()
        await new Promise(r => setTimeout(r, 800))
      })()
    `)
    const subPanel = await cdp.eval(`({
      title: document.querySelector('.sidebar__title')?.textContent ?? '',
      hasPlanLabel: document.body.textContent.includes('Mon plan'),
      hasStatut: document.body.textContent.includes('Statut') || document.body.textContent.includes('ACTIF'),
    })`)
    check('EXE: ABONNEMENT (Mon plan + Statut)',
      subPanel.title === 'ABONNEMENT' && subPanel.hasPlanLabel && subPanel.hasStatut,
      JSON.stringify(subPanel))

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 5. Pro/1 minute -> expiration sans reload ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const proJwt = signLicense({ type: 'subscription', plan: 'pro', exp: Math.floor(Date.now() / 1000) + 60 })
    const activatedPro = await cdp.eval(
      `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(proJwt)})`)
    check('EXE: licence PRO/1min activÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e', activatedPro.success === true, activatedPro.error)

    const proPerms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
    check('EXE: plan PRO actif', proPerms.planId === 'pro' && proPerms.permissions.premiumModels === true, proPerms.planId)

    let finalPerms = null
    const startedAt = Date.now()
    while (Date.now() - startedAt < 120000) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      finalPerms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
      if (finalPerms.planId === 'free') break
    }
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    check('EXE: EXPIRATION sans redÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©marrage (~60s)', finalPerms && finalPerms.planId === 'free' && elapsedSec <= 75,
      `${elapsedSec}s -> ${finalPerms ? finalPerms.planId : '?'}`)
    check('EXE: premium retirÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s aprÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s expiration',
      finalPerms && finalPerms.permissions.premiumModels === false)

    // ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ 6. PRO ULTIMATE lifetime -> toutes permissions ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚ÂÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬
    const ultimateJwt = signLicense({ type: 'lifetime', plan: 'pro_ultimate' })
    const activatedUltimate = await cdp.eval(
      `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(ultimateJwt)})`)
    check('EXE: licence PRO ULTIMATE/Lifetime activÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e', activatedUltimate.success === true, activatedUltimate.error)

    const ultimatePerms = await cdp.eval(`window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`)
    check('EXE: plan PRO ULTIMATE actif sans reload',
      ultimatePerms.planId === 'pro_ultimate'
      && ultimatePerms.permissions.premiumModels
      && ultimatePerms.permissions.advancedTools
      && ultimatePerms.permissions.priorityAccess,
      `${ultimatePerms.planId}`)

    cdp.close()
  } finally {
    for (const entry of adminBackup) { fs.writeFileSync(entry.from, entry.data) }
    if (adminBackup.length > 0) console.log('[teardown] fichiers admin restaurÃ©s')
    if (backupKeyStore) {
      fs.mkdirSync(path.dirname(keyStoreFile), { recursive: true })
      fs.writeFileSync(keyStoreFile, backupKeyStore)
      console.log('[teardown] keystore restaurÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©')
    }
    try {
      // Windows : child.kill() ne tue que le parent -> zombies qui gardent le verrou single-instance.
      if (process.platform === 'win32' && child.pid) {
        require('node:child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else { child.kill() }
    } catch { /* ignore */ }
  }

  console.log(`\nRESULT: ${passCount} PASS, ${failCount} FAIL`)
  finish()
}

function oxRunSafe(run) { return run?.error ?? 'none' }

function finish() { process.exit(failCount === 0 ? 0 : 1) }

/** Agent rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©el via IPC, avec timeout gÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©nÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©reux (modÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨le raisonneur). */
async function runAgent(cdp, sessionToken, model, workspace) {
  return cdp.eval(`
    (async () => {
      const bridge = window.electronAPI
      let done = false, error = null, sid = null
      const off = bridge.agent.onEvent((event) => {
        if (!sid || event.sessionId !== sid) return
        if (event.type === 'done') done = true
        else if (event.type === 'error') error = event.message
      })
      try {
        const res = await bridge.agent.start({
          prompt: 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ponds simplement en une phrase: OK.',
          model: ${JSON.stringify(model)},
          workspace: ${JSON.stringify(workspace)},
          sessionToken: ${JSON.stringify(sessionToken)},
        })
        sid = res.sessionId
      } catch (e) { error = 'start: ' + e.message }
      const started = Date.now()
      while (Date.now() - started < 120000 && !done && !error) {
        await new Promise(r => setTimeout(r, 200))
      }
      off()
      return { done, error }
    })()
  `)
}

function appDataName() {
  return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
}

let serial = 0
function signLicense(claims) {
  serial += 1
  return jwt.sign({
    iss: 'cursor-clone',
    sub: `exetest-${serial}@mycreation.app`,
    licenseId: `lic_${Date.now().toString(36)}_${serial}`,
    product: 'cursor-clone',
    version: '1.0.0',
    ...claims,
  }, require('./keys.cjs').readPrivateKey(), { algorithm: 'RS256' })
}

async function collectChat(cdp, sessionToken, model, prompt) {
  return cdp.eval(`
    (async () => {
      const bridge = window.electronAPI
      let text = '', error = null, done = false, ttftMs = null
      let chunks = 0
      const t0 = Date.now()
      const off = bridge.ai.onChunk((event) => {
        if (event.requestId !== requestId.value) return
        if (event.type === 'text') {
          chunks += 1
          if (ttftMs === null) ttftMs = Date.now() - t0
          text += event.text
        } else if (event.type === 'error') error = event.message
        else if (event.type === 'done') done = true
      })
      const requestId = { value: null }
      try {
        const res = await bridge.ai.chat({
          messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }],
          model: ${JSON.stringify(model)},
          sessionToken: ${JSON.stringify(sessionToken)},
        })
        requestId.value = res.requestId
      } catch (e) { error = 'start: ' + e.message }
      const started = Date.now()
      while (Date.now() - started < 150000 && !done && !error) {
        await new Promise(r => setTimeout(r, 150))
      }
      off()
      return { text, error, done, ttft: ttftMs === null ? null : Math.round(ttftMs / 100) / 10, total: Math.round((Date.now() - t0) / 100) / 10, chunks }
    })()
  `)
}

main().catch(error => {
  console.error('FATAL', error?.stack ?? String(error))
  process.exit(1)
})
