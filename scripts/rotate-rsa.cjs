#!/usr/bin/env node
/**
 * ROTATION RSA des clés de licence My Creation.
 *
 * Pourquoi : la private.pem historique a transité dans l'historique Git
 * (commit fe6191f, retiré dans bff5c96). Toute clé ayant fui est compromise
 * par définition -> rotation obligatoire avant commercialisation.
 *
 * Ce que fait ce script :
 *   1. Génère une nouvelle paire RSA 2048 (RS256).
 *   2. Écrit la clé PRIVÉE dans license-generator/secrets/private.pem
 *      (hors chemin d'empaquetage, ignoré par Git) — elle ne doit jamais
 *      quitter l'environnement sécurisé du License Generator.
 *   3. Remplace electron/keys/public.pem (clé publique embarquée par l'app,
 *      copiée vers dist-electron/keys/ au build par scripts/postbuild.cjs).
 *   4. Supprime l'ancienne electron/keys/private.pem si présente.
 *   5. Affiche les empreintes SHA-256 avant/après pour documentation.
 *
 * Conséquence assumée : les licences signées avec l'ANCIENNE clé deviennent
 * invalides. Ré-émettre les licences à vendre avec le License Generator mis
 * à jour. Les installations existantes doivent recevoir un build contenant
 * la nouvelle clé publique (migration documentée dans TODO.md / README).
 *
 * Usage:
 *   node scripts/rotate-rsa.cjs            # refuse si une paire existe déjà
 *   node scripts/rotate-rsa.cjs --force    # rotation explicite
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')
const privateKeyPath = path.join(root, 'license-generator', 'secrets', 'private.pem')
const publicKeyPath = path.join(root, 'electron', 'keys', 'public.pem')
const legacyPrivateKeyPath = path.join(root, 'electron', 'keys', 'private.pem')
const force = process.argv.includes('--force')

function fingerprint(pem) {
  if (!pem) return null
  const der = crypto.createPublicKey(pem).export({ format: 'der', type: 'spki' })
  return crypto.createHash('sha256').update(der).digest('hex')
}

function fingerprintFile(file) {
  try {
    return fingerprint(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

if (!force && (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath))) {
  console.error('REFUSÉ : une paire existe déjà (license-generator/secrets/private.pem ou electron/keys/public.pem).')
  console.error('Relancez avec --force pour effectuer une rotation explicite.')
  process.exit(1)
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true })
fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 })
fs.writeFileSync(publicKeyPath, publicKey)

if (fs.existsSync(legacyPrivateKeyPath)) {
  fs.rmSync(legacyPrivateKeyPath)
  console.log('✓ ancienne electron/keys/private.pem SUPPRIMÉE')
}

console.log('✓ nouvelle clé privée :', path.relative(root, privateKeyPath))
console.log('✓ nouvelle clé publique :', path.relative(root, publicKeyPath))
console.log('Empreinte SHA-256 ANCIENNE clé publique :', fingerprintFile(path.join(root, 'dist-electron', 'keys', 'public.pem')) ?? fingerprintFile(publicKeyPath.replace('public.pem', 'public.pem')) ?? 'inconnue (aucune trace)')
console.log('Empreinte SHA-256 NOUVELLE clé publique :', fingerprint(publicKey))
