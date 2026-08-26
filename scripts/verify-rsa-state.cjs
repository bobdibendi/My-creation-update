#!/usr/bin/env node
/**
 * VÉRIFICATION D'ÉTAT de la paire RSA de licences My Creation (lecture seule).
 *
 * N'effectue AUCUNE rotation ni régénération : constate simplement que
 * l'état post-rotation est intact et cohérent :
 *   1. private.pem uniquement dans license-generator/secrets/
 *   2. aucun matériel de clé privée dans les sorties de build
 *      (dist/, dist-electron/, release/, y compris app.asar)
 *   3. electron/keys/public.pem = paire ACTIVE documentée
 *      (cohérence cryptographique publique dérivée de la privée + roundtrip)
 *
 * Usage : node scripts/verify-rsa-state.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')

/** Empreinte SHA-256 SPKI DER d'une clé publique (même méthode que rotate-rsa.cjs). */
function fingerprint(pem) {
  const der = crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' })
  return crypto.createHash('sha256').update(der).digest('hex')
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Paire ACTIVE attendue (documentée dans TODO.md §2)
const EXPECTED_ACTIVE_FP = process.env.MC_EXPECTED_PUBLIC_FP
  ?? 'c5fad623f1d2401363984b974fda8359609b7004e4145763ecbeae151b9c2112'

const privPath = path.join(root, 'license-generator', 'secrets', 'private.pem')
const pubPath = path.join(root, 'electron', 'keys', 'public.pem')
const legacyPrivPath = path.join(root, 'electron', 'keys', 'private.pem')

console.log('== Vérification état RSA (aucune régénération) ==\n')

// 1) Emplacements
check('private.pem présente dans license-generator/secrets/', fs.existsSync(privPath))
check('electron/keys/private.pem absente des fichiers distribués', !fs.existsSync(legacyPrivPath))
check('public.pem présente dans electron/keys/', fs.existsSync(pubPath))

if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
  console.error('\nÉtat incomplet : vérification interrompue.')
  process.exit(1)
}

// 2) Cohérence de la paire active
const pubPem = fs.readFileSync(pubPath, 'utf8')
const privPem = fs.readFileSync(privPath, 'utf8')
const pubFp = fingerprint(pubPem)
const derivedFp = fingerprint(privPem) // createPublicKey(pkcs8) dérive la partie publique

check(
  'empreinte public.pem = paire ACTIVE documentée',
  pubFp === EXPECTED_ACTIVE_FP,
  `actuelle=${pubFp}`,
)
check(
  'paire cohérente : publique dérivée de la privée = public.pem',
  derivedFp === pubFp,
  `dérivée=${derivedFp}`,
)

const probe = Buffer.from(`mycreation-rsa-state-probe-${Date.now()}`)
const sig = crypto.sign('sha256', probe, privPem)
check(
  'roundtrip : signature privée vérifiée par public.pem',
  crypto.verify('sha256', probe, pubPem, sig),
)
check(
  'négatif : signature altérée rejetée par public.pem',
  !crypto.verify('sha256', probe, pubPem, Buffer.concat([sig, Buffer.from('x')])),
)

// 3) Clé publique embarquée au build
const builtPubPath = path.join(root, 'dist-electron', 'keys', 'public.pem')
if (fs.existsSync(builtPubPath)) {
  check(
    'public.pem embarquée (dist-electron/keys/) = paire ACTIVE',
    fingerprint(fs.readFileSync(builtPubPath, 'utf8')) === pubFp,
  )
} else {
  check('public.pem embarquée (dist-electron/keys/) = paire ACTIVE', false, 'absente — relancer un build')
}

// 4) Aucun matériel de clé privée dans les sorties de build
const MARKERS = ['-----BEGIN PRIVATE KEY', '-----BEGIN RSA PRIVATE KEY', '-----BEGIN EC PRIVATE KEY']
const SCAN_DIRS = ['dist', 'dist-electron', 'release'].map(d => path.join(root, d))
const MAX_BYTES = 256 * 1024 * 1024
let filesSeen = 0
let pemNamed = []
let leaks = []

function walk(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(full)
      continue
    }
    if (!e.isFile()) continue
    filesSeen++
    if (/private.*\.(pem|key)$/i.test(e.name)) pemNamed.push(full)
    let size = 0
    try {
      size = fs.statSync(full).size
    } catch {
      continue
    }
    const forceScan = full.endsWith('app.asar')
    if (size > MAX_BYTES && !forceScan) continue // exécutables volumineux : nom seul suffit ici
    let buf
    try {
      buf = fs.readFileSync(full)
    } catch {
      continue
    }
    const text = buf.toString('latin1')
    for (const m of MARKERS) {
      if (text.includes(m)) {
        leaks.push(`${path.relative(root, full)} (${m})`)
        break
      }
    }
  }
}
for (const d of SCAN_DIRS) {
  if (fs.existsSync(d)) walk(d)
}

check(
  'aucun fichier nommé private*.pem/.key dans dist|dist-electron|release',
  pemNamed.length === 0,
  pemNamed.map(p => path.relative(root, p)).join(', ') || `${filesSeen} fichiers analysés`,
)
check(
  'aucun marqueur de clé privée dans les sorties de build (dont app.asar)',
  leaks.length === 0,
  leaks.join('; ') || `${filesSeen} fichiers scannés`,
)

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) {
  console.error('ÉTAT RSA NON INTACT — investiguer AVANT toute nouvelle génération.')
  process.exit(1)
}
console.log('État RSA post-rotation INTACT — ne pas régénérer.')
