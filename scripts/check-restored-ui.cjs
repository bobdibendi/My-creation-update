#!/usr/bin/env node
/**
 * Vérification de régression : panneaux « Abonnement » et « Mon compte »
 * restaurés dans l'ActivityBar, avec le VRAI processus main (auth Supabase
 * pontée, QuotaService réel). Usage : npx electron scripts/check-restored-ui.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const mainEntry = path.join(projectRoot, 'dist-electron', 'main.js')

if (!fs.existsSync(mainEntry) || !fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
  console.error('FATAL build absent. Lance "npm run build".')
  process.exit(1)
}

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' -> ' + JSON.stringify(detail ?? '')}`)
  if (!ok) failures += 1
}

function waitForWindow(timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) return resolve(windows[0])
      if (Date.now() > deadline) return reject(new Error('aucune fenetre'))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function main() {
  // Charge le vrai main : tous les handlers IPC réels sont enregistrés.
  require(mainEntry)
  const win = await waitForWindow(20000)

  const env = fs.readFileSync(path.join(projectRoot, '.env.local'), 'utf8')
  const ref = env.match(/VITE_SUPABASE_URL\s*=\s*https:\/\/([^.]+)\./)[1]
  const nowSec = Math.floor(Date.now() / 1000)
  const session = {
    access_token: 'regress-access', refresh_token: 'regress-refresh', token_type: 'bearer',
    expires_in: 3600, expires_at: nowSec + 3600,
    user: {
      id: 'regress-' + Date.now() + '-0001', aud: 'authenticated', role: 'authenticated',
      email: `regress-${Date.now()}@example.com`, email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: 'Regress' },
      identities: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
  }
  await win.webContents.executeJavaScript(
    `localStorage.setItem('sb-${ref}-auth-token', ${JSON.stringify(JSON.stringify(session))})`, true)
  await win.webContents.reload()
  await new Promise(resolve => setTimeout(resolve, 4000))

  const clickPanel = title => win.webContents.executeJavaScript(`
    (async () => {
      const b = [...document.querySelectorAll('.activitybar button')]
        .find(x => x.getAttribute('title') === ${JSON.stringify(title)})
      if (!b) return false
      b.click()
      await new Promise(r => setTimeout(r, 900))
      return true
    })()`, true)

  // ── Abonnement ──
  check('bouton ActivityBar « Abonnement » présent', await clickPanel('Abonnement'))
  const sub = await win.webContents.executeJavaScript(`({
    title: document.querySelector('.sidebar__title')?.textContent ?? '',
    hasPlanLabel: document.body.textContent.includes('Mon plan'),
    hasStatut: document.body.textContent.includes('Statut'),
  })`, true)
  check('panneau ABONNEMENT monté (Mon plan + Statut)',
    sub.title === 'ABONNEMENT' && sub.hasPlanLabel && sub.hasStatut, sub)

  // ── Mon compte ──
  check('bouton ActivityBar « Mon compte » présent', await clickPanel('Mon compte'))
  const acc = await win.webContents.executeJavaScript(`({
    title: document.querySelector('.sidebar__title')?.textContent ?? '',
    who: document.querySelector('.account__who strong')?.textContent ?? '',
    email: document.querySelector('.account__who span')?.textContent ?? '',
  })`, true)
  check('panneau MON COMPTE monté avec identité pontée',
    acc.title === 'MON COMPTE' && acc.who.length > 0 && acc.email.includes('@'), acc)

  // ── Consommation (QuotaService réel via subscription:usage) ──
  const usage = await win.webContents.executeJavaScript(
    `(async () => {
      const t = localStorage.getItem('cursor-clone:session-token')
      if (!t) return { error: 'no token' }
      return await window.electronAPI.subscription.usage(t)
    })()`, true)
  check('QuotaService répond (plan FREE + compteurs)',
    !usage.error && usage.plan?.id === 'free' && typeof usage.totalTokens === 'number'
    && typeof usage.percentUsed === 'number', { planId: usage.plan?.id, error: usage.error })

  // ── Permissions FREE ──
  const perms = await win.webContents.executeJavaScript(
    `(async () => window.electronAPI.permissions.get(localStorage.getItem('cursor-clone:session-token')))()`,
    true).catch(error => ({ error: String(error) }))
  check('permissions FREE (Kim Pro seul, pas de premium)',
    perms.planId === 'free' && perms.permissions?.builtinFreeModels === true
    && perms.permissions?.premiumModels === false, perms)

  console.log(failures === 0 ? '\nRESULT: ALL PASS' : `\nRESULT: ${failures} FAIL`)
  app.exit(failures === 0 ? 0 : 1)
}

app.whenReady().then(main).catch(error => {
  console.error('FATAL', error)
  app.exit(1)
})
