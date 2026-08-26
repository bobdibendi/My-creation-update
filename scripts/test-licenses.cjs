#!/usr/bin/env node
/**
 * Test automatisé de la chaîne de licences My Creation.
 *
 * Réplique exactement la logique de vérification de electron/license.ts
 * (LicenseService.verifyLicenseKey) : JWT RS256, issuer 'cursor-clone',
 * product 'cursor-clone', expiration exp.
 *
 * Couverture :
 *   - lifetime            -> VALID
 *   - subscription 1 min  -> VALID
 *   - subscription 365 j  -> VALID
 *   - expirée             -> INVALID (Licence expirée)
 *   - falsifiée (payload modifié)          -> INVALID
 *   - signée avec une autre clé privée     -> INVALID
 *   - subscription sans durée              -> rejetée à la GÉNÉRATION
 *   - subscription durée <= 0              -> rejetée à la GÉNÉRATION
 *
 * Usage : node scripts/test-licenses.cjs
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

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

// ---------------------------------------------------------------------------
// Même logique que LicenseService.verifyLicenseKey (electron/license.ts)
// ---------------------------------------------------------------------------
function verifyLicenseKey(licenseKey, publicKey) {
  let payload
  try {
    payload = jwt.verify(licenseKey, publicKey, {
      algorithms: ['RS256'],
      issuer: 'cursor-clone',
    })
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return { valid: false, error: 'Licence expirée' }
    return { valid: false, error: 'Clé de licence invalide' }
  }
  if (!payload.licenseId || !payload.type || !payload.product) {
    return { valid: false, error: 'Données de licence invalides' }
  }
  if (payload.product !== 'cursor-clone') {
    return { valid: false, error: 'Cette licence est destinée à un autre produit' }
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    return { valid: false, error: 'Licence expirée' }
  }
  return { valid: true, payload }
}

// Même construction de payload que scripts/generate-license.cjs
function buildToken(privateKey, { email, type, days }) {
  const payload = {
    iss: 'cursor-clone',
    sub: email,
    licenseId: `lic_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${failCount}`,
    type,
    product: 'cursor-clone',
    version: null,
  }
  if (days > 0) payload.exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' })
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const root = path.resolve(__dirname, '..')
const privatePath = require('./keys.cjs').findPrivateKeyPath()
const publicPath = path.join(root, 'electron', 'keys', 'public.pem')

if (!privatePath || !fs.existsSync(publicPath)) {
  console.error('Clés absentes : license-generator/secrets/private.pem et/ou electron/keys/public.pem')
  process.exit(1)
}
const privateKey = fs.readFileSync(privatePath, 'utf8')
const publicKey = fs.readFileSync(publicPath, 'utf8')

// Vérifier que la paire correspond bien (comme le fera l'app installée)
{
  const probe = jwt.sign({ iss: 'probe' }, privateKey, { algorithm: 'RS256' })
  const ok = (() => {
    try {
      jwt.verify(probe, publicKey, { algorithms: ['RS256'] })
      return true
    } catch {
      return false
    }
  })()
  check('Paire de clés private/public cohérente', ok)
}

// ---------------------------------------------------------------------------
// 1. Licences valides
// ---------------------------------------------------------------------------
const lifetime = buildToken(privateKey, { email: 'lifetime@test.com', type: 'lifetime', days: 0 })
check('lifetime -> VALID', verifyLicenseKey(lifetime, publicKey).valid)
check(
  'lifetime -> pas de champ exp',
  verifyLicenseKey(lifetime, publicKey).payload && verifyLicenseKey(lifetime, publicKey).payload.exp === undefined,
)

const sub1min = buildToken(privateKey, { email: 'onemin@test.com', type: 'subscription', days: 1 / 1440 })
const sub1minRes = verifyLicenseKey(sub1min, publicKey)
check('subscription 1 min -> VALID', sub1minRes.valid)
if (sub1minRes.valid) {
  const delta = sub1minRes.payload.exp - Math.floor(Date.now() / 1000)
  check('subscription 1 min -> exp ~60 s', delta > 30 && delta <= 61, `delta=${delta}s`)
}

const sub365 = buildToken(privateKey, { email: 'year@test.com', type: 'subscription', days: 365 })
const sub365Res = verifyLicenseKey(sub365, publicKey)
check('subscription 365 jours -> VALID', sub365Res.valid)
if (sub365Res.valid) {
  const daysLeft = (sub365Res.payload.exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000)
  check('subscription 365 jours -> ~365 j restants', daysLeft > 364 && daysLeft <= 365.01, `${daysLeft.toFixed(2)} j`)
}

// ---------------------------------------------------------------------------
// 2. Licences rejetées
// ---------------------------------------------------------------------------
const expiredPayload = {
  iss: 'cursor-clone',
  sub: 'expired@test.com',
  licenseId: 'lic_expired0001',
  type: 'subscription',
  product: 'cursor-clone',
  version: null,
  exp: Math.floor(Date.now() / 1000) - 3600,
}
const expired = jwt.sign(expiredPayload, privateKey, { algorithm: 'RS256' })
const expiredRes = verifyLicenseKey(expired, publicKey)
check('expirée -> INVALID', !expiredRes.valid)
check('expirée -> message "Licence expirée"', expiredRes.error === 'Licence expirée')

// Falsifiée : token valide dont on modifie le payload (sub changé) sans resigner
const [h, p, s] = lifetime.split('.')
const decoded = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))
decoded.sub = 'attacker@evil.com'
const tampered = `${h}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${s}`
const tamperedRes = verifyLicenseKey(tampered, publicKey)
check('falsifiée (payload modifié) -> INVALID', !tamperedRes.valid)

// Signée avec une AUTRE VRAIE paire RSA (générée pour le test).
// La signature est techniquement valide mais ne correspond pas à public.pem
// de My Creation -> doit être rejetée à la vérification.
const { generateKeyPairSync } = require('crypto')
const roguePair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const roguePrivatePem = roguePair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
const roguePublicPem = roguePair.publicKey.export({ type: 'spki', format: 'pem' }).toString()

// Sanity : le token rogue est bien signé par la paire rogue
const rogueToken = jwt.sign(
  { iss: 'cursor-clone', sub: 'rogue@test.com', licenseId: 'lic_rogue001', type: 'lifetime', product: 'cursor-clone', version: null },
  roguePrivatePem,
  { algorithm: 'RS256' },
)
check(
  'token rogue -> signature interne cohérente (paire rogue)',
  (() => {
    try {
      jwt.verify(rogueToken, roguePublicPem, { algorithms: ['RS256'] })
      return true
    } catch {
      return false
    }
  })(),
)

const rogueRes = verifyLicenseKey(rogueToken, publicKey)
check('mauvaise signature (autre vraie paire RSA) -> INVALID', !rogueRes.valid)

// Autre produit
const otherProduct = jwt.sign(
  { iss: 'cursor-clone', sub: 'x@test.com', licenseId: 'lic_other001', type: 'lifetime', product: 'other-product', version: null },
  privateKey,
  { algorithm: 'RS256' },
)
const otherRes = verifyLicenseKey(otherProduct, publicKey)
check('autre produit -> INVALID', !otherRes.valid)
check('autre produit -> message produit', otherRes.error === 'Cette licence est destinée à un autre produit')

// Issuer incorrect
const badIssuer = jwt.sign(
  { iss: 'someone-else', sub: 'y@test.com', licenseId: 'lic_badiss01', type: 'lifetime', product: 'cursor-clone', version: null },
  privateKey,
  { algorithm: 'RS256' },
)
check("issuer incorrect -> INVALID", !verifyLicenseKey(badIssuer, publicKey).valid)

// Chaîne vide / déchets
check('chaîne vide -> INVALID', !verifyLicenseKey('', publicKey).valid)
check('texte aléatoire -> INVALID', !verifyLicenseKey('not-a-jwt-at-all', publicKey).valid)

// ---------------------------------------------------------------------------
// 3. Validation à la génération (scripts/generate-license.cjs)
// ---------------------------------------------------------------------------
const { execFileSync } = require('child_process')
function gen(args) {
  try {
    execFileSync('node', [path.join(root, 'scripts', 'generate-license.cjs'), ...args], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}
check('génération subscription sans --days -> rejetée', !gen(['--email', 'a@b.co', '--type', 'subscription']))
check('génération subscription --days 0 -> rejetée', !gen(['--email', 'a@b.co', '--type', 'subscription', '--days', '0']))
check('génération subscription --days -5 -> rejetée', !gen(['--email', 'a@b.co', '--type', 'subscription', '--days', '-5']))
check('génération type inconnu -> rejetée', !gen(['--email', 'a@b.co', '--type', 'enterprise']))
check('génération sans email -> rejetée', !gen(['--type', 'lifetime']))

// ---------------------------------------------------------------------------
console.log('\n=========================================')
console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
console.log('=========================================')
process.exit(failCount === 0 ? 0 : 1)
