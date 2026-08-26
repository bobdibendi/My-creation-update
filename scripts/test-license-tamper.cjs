#!/usr/bin/env node
/**
 * Tests ANTI-FALSIFICATION du statut de licence (anti-bypass hors renderer).
 *
 * Menace modélisée : un utilisateur possède UNE licence valide basse (FREE ou
 * PRO) et édite directement le fichier SQLite (appData/auth.db) pour y
 * réécrire un plan supérieur dans `licenses.licenseData`. Le main process ne
 * doit JAMAIS lire ce champ comme source de vérité :
 *
 *   A. Licence interne FREE  -> licenseData falsifié "pro_ultimate" -> plan free
 *   B. Licence interne PRO   -> licenseData falsifié "pro_ultimate" -> plan pro
 *   C. Licence Gumroad       -> Product ID réel (fournisseur) prime sur le
 *      plan revendiqué localement falsifié
 *   D. Clé interne remplacée par une clé invalide -> licence inactive -> FREE
 *
 * La résolution testée est planFromVerifiedStatus() (electron/license-plan.ts),
 * utilisée par syncPlanFromLicense() côté main : statut VÉRIFIÉ uniquement.
 *
 * Usage : node scripts/test-license-tamper.cjs   (lance `npm run build:electron` avant)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jwt = require('jsonwebtoken')
const Database = require('better-sqlite3')

const root = path.resolve(__dirname, '..')
const privatePath = require('./keys.cjs').findPrivateKeyPath()
const publicPath = path.join(root, 'electron', 'keys', 'public.pem')
if (!privatePath || !fs.existsSync(publicPath)) {
  console.error('FATAL cles locales absentes.')
  process.exit(1)
}
const privateKey = fs.readFileSync(privatePath, 'utf8')
const publicKey = fs.readFileSync(publicPath, 'utf8')

const distDir = path.join(root, 'dist-electron')
if (!fs.existsSync(path.join(distDir, 'license.js'))) {
  console.error('FATAL dist-electron/license.js absent. Lance "npm run build".')
  process.exit(1)
}
// La clé publique est résolue au chargement du module : env AVANT require.
process.env.LICENSE_PUBLIC_KEY_PATH = publicPath
const { LicenseService } = require(path.join(distDir, 'license.js'))
const { resolveLicensedPlan, planFromVerifiedStatus } = require(path.join(distDir, 'license-plan.js'))

let passCount = 0
let failCount = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
    passCount++
  } else {
    console.error(`FAIL  ${name}${detail ? ` (${detail})` : ''}`)
    failCount++
  }
}

function sign(claims) {
  const payload = {
    iss: 'cursor-clone',
    sub: 'tamper-test@mycreation.app',
    licenseId: `lic_${Math.random().toString(36).slice(2)}`,
    product: 'cursor-clone',
    version: '1.3.0',
    ...claims,
  }
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' })
}

/** Base isolée : schéma minimal identique à electron/database.ts. */
function makeDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mycreation-tamper-')), 'test.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      name TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      licenseKey TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      product TEXT NOT NULL,
      version TEXT,
      activatedAt INTEGER NOT NULL,
      expiresAt INTEGER,
      licenseData TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
  db.prepare('INSERT INTO users (email, passwordHash, name, createdAt) VALUES (?, ?, ?, ?)')
    .run('tamper@test.local', 'x', 'Tamper Test', Date.now())
  return db
}

function activateInternal(db, token) {
  const svc = new LicenseService(db)
  const result = svc.activateLicense(1, token)
  if (!result.success) throw new Error(`activation: ${result.error}`)
  return svc
}

/** Réécrit licenseData (simulation d'édition directe du fichier auth.db). */
function tamperLicenseData(db, licenseKey, patch) {
  const row = db.prepare('SELECT licenseData FROM licenses WHERE licenseKey = ?').get(licenseKey)
  const data = JSON.parse(row.licenseData)
  db.prepare('UPDATE licenses SET licenseData = ? WHERE licenseKey = ?')
    .run(JSON.stringify({ ...data, ...patch }), licenseKey)
}

// ── A. Licence interne FREE, licenseData falsifié "pro_ultimate" ─────────
{
  const db = makeDb()
  const key = sign({ type: 'lifetime' }) // pas de claim plan -> free
  const svc = activateInternal(db, key)

  tamperLicenseData(db, key, { plan: 'pro_ultimate', type: 'lifetime' })

  const status = svc.getLicenseStatus(1)
  check('A. licence toujours active', status.active === true)
  // Sans claim, le statut expose plan=undefined (jamais une valeur falsifiée).
  check('A. statut verifie ignore le JSON falsifie', status.plan == null, `plan=${String(status.plan)}`)
  check('A. plan effectif = free', planFromVerifiedStatus(status) === 'free')

  // Contre-preuve : l'ANCIENNE logique (re-parsing de licenseData brut)
  // aurait accordé pro_ultimate — c'est précisément le trou comblé.
  const raw = JSON.parse(db.prepare('SELECT licenseData FROM licenses WHERE licenseKey = ?').get(key).licenseData)
  check('A. contre-preuve : ancien chemin donnait pro_ultimate',
    resolveLicensedPlan(raw) === 'pro_ultimate')
}

// ── B. Licence interne PRO, falsifiée en pro_ultimate ────────────────────
{
  const db = makeDb()
  const key = sign({ type: 'lifetime', plan: 'pro' })
  const svc = activateInternal(db, key)

  tamperLicenseData(db, key, { plan: 'pro_ultimate' })

  const status = svc.getLicenseStatus(1)
  check('B. elevation bloquee : plan reste pro', planFromVerifiedStatus(status) === 'pro')
}

// ── C. Licence Gumroad : Product ID reel prime sur la revendication locale ──
{
  const db = makeDb()
  const svc = new LicenseService(db)
  // Fournisseur factice : le Product ID reel mappe vers PRO chez Gumroad.
  svc.setSubscriptionProvider({
    configured: true,
    resolvePlan: productId => (productId === 'prod_pro_reel' ? 'pro' : null),
    cadenceFor: () => 'monthly',
    verifyLicenseKey: async () => ({ ok: false, error: 'hors test', kind: 'invalid' }),
  })

  const localClaim = {
    source: 'gumroad',
    plan: 'pro_ultimate', // revendication locale FALSIFIEE
    productId: 'prod_pro_reel', // identifiant produit reel : PRO
    saleId: null,
    email: null,
    validatedAt: Date.now(),
    refunded: false,
  }
  db.prepare(
    'INSERT INTO licenses (userId, licenseKey, type, product, version, activatedAt, expiresAt, licenseData) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'GUMROAD-TAMPER-KEY', 'lifetime', 'my-creation', null, Date.now(), null, JSON.stringify(localClaim))

  const status = svc.getLicenseStatus(1)
  check('C. licence gumroad active', status.active === true && status.source === 'gumroad')
  check('C. Product ID reel prime : plan = pro', planFromVerifiedStatus(status) === 'pro')
}

// ── D. Clé interne remplacée par une valeur invalide -> descente FREE ─────
{
  const db = makeDb()
  const key = sign({ type: 'lifetime', plan: 'pro' })
  const svc = activateInternal(db, key)

  db.prepare('UPDATE licenses SET licenseKey = ? WHERE licenseKey = ?').run('cle-falsifiee', key)

  const status = svc.getLicenseStatus(1)
  check('D. cle falsifiee -> licence inactive', status.active === false)
  check('D. plan effectif retombe sur free', planFromVerifiedStatus(status) === 'free')
}

console.log(`\n=== Bilan anti-falsification : ${passCount} PASS, ${failCount} FAIL ===`)
process.exit(failCount === 0 ? 0 : 1)
