#!/usr/bin/env node
/**
 * E2E REEL — EXPIRATION D'UNE LICENCE PRO SANS REDÉMARRAGE.
 *
 * 1. Boote le vrai processus main, cree un compte, active
 *    Pro / Subscription / 60 secondes (vrai JWT RS256).
 * 2. Verifie que les permissions PRO sont actives immediatement.
 * 3. Attend l'expiration (poll toutes les 5 s sur permissions:get).
 * 4. Verifie que les permissions retombent sur FREE SANS rechargement.
 *
 * Usage : node scripts/test-expiration-live.cjs   (apres npm run build)
 */
const fs = require('node:fs')
const path = require('node:path')
const jwt = require('jsonwebtoken')
const { app, BrowserWindow } = require('electron')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')
// Meme contrainte keystore/safeStorage que test-free-flow : identite 'cursor-clone'.
app.setName('cursor-clone')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => { /* controle par le test */ })

async function main() {
  require(path.join(projectRoot, 'dist-electron', 'main.js'))

  let win = null
  for (let i = 0; i < 200 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] ?? null
    if (!win) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!win) { report('FAIL aucune fenetre'); process.exit(1) }
  await new Promise(resolve => setTimeout(resolve, 2500))

  const boot = await win.webContents.executeJavaScript(`
    window.electronAPI.auth.register('exp-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'ExpTest')
  `, true)
  if (!boot.sessionToken) { report('FAIL register'); process.exit(1) }
  const { sessionToken } = boot

  const proJwt = jwt.sign(
    {
      iss: 'cursor-clone',
      sub: 'exp-pro@mycreation.app',
      licenseId: `lic_${Date.now().toString(36)}`,
      type: 'subscription',
      plan: 'pro',
      product: 'cursor-clone',
      version: '1.0.0',
      exp: Math.floor(Date.now() / 1000) + 60,
    },
    require('./keys.cjs').readPrivateKey(),
    { algorithm: 'RS256' },
  )

  const activated = await win.webContents.executeJavaScript(
    `window.electronAPI.license.activate(${JSON.stringify(sessionToken)}, ${JSON.stringify(proJwt)})`,
    true,
  )
  report(`${activated.success ? 'PASS' : 'FAIL'}  activation Pro/Subscription 60s`)
  if (!activated.success) { report('detail: ' + activated.error); process.exit(1) }

  const before = await win.webContents.executeJavaScript(
    `window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`,
    true,
  )
  // Logique commerciale actuelle : PRO = Ox Alpha inclus, SANS modèles
  // premium (réservés au plan PRO ULTIMATE).
  report(`${before.planId === 'pro' && before.permissions.oxAlphaModels && !before.permissions.premiumModels ? 'PASS' : 'FAIL'}  permissions PRO actives avant expiration (${before.planId})`)

  // Poll sans jamais recharger la fenetre : la detection doit venir de
  // l'app elle-meme (timer d'expiration + verification periodique).
  let after = null
  const started = Date.now()
  while (Date.now() - started < 120000) {
    await new Promise(resolve => setTimeout(resolve, 5000))
    after = await win.webContents.executeJavaScript(
      `window.electronAPI.permissions.get(${JSON.stringify(sessionToken)})`,
      true,
    )
    if (after.planId === 'free') break
  }

  const elapsed = Math.round((Date.now() - started) / 1000)
  report(`${after && after.planId === 'free' ? 'PASS' : 'FAIL'}  expiration detectee sans redemarrage (${elapsed}s, plan=${after ? after.planId : '?'})`)
  report(`${after && after.permissions.premiumModels === false ? 'PASS' : 'FAIL'}  modeles premium retires immediatement`)

  const ok = before.planId === 'pro' && after && after.planId === 'free' && after.permissions.premiumModels === false
  report(ok ? 'PASS  Expiration PRO complete sans redemarrage' : 'FAIL  Expiration PRO')
  app.exit(ok ? 0 : 1)
}

main().catch(error => {
  report('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
