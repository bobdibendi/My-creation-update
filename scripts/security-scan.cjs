#!/usr/bin/env node
/**
 * SCAN SÉCURITÉ des artefacts distribuables My Creation.
 *
 * Cherche dans dist/, dist-electron/, release/ (app.asar inclus, lu en
 * binaire), et l'installateur NSIS :
 *   - clé privée PEM (« PRIVATE KEY »)
 *   - empreintes SHA-256 des clés privées RETIRÉES (rotation 2026-08)
 *   - Supabase service_role / secret key (préfixes sb_secret_, sb_publishable
 *     est ATTENDU côté client et ignoré)
 *   - mots de passe base de données, tokens Gumroad, clés d'API serveur
 *
 * Sortie : rapport PASS/FAIL par artefact. Toute détection = échec.
 *
 * Usage : node scripts/security-scan.cjs [chemin supplémentaire...]
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.resolve(__dirname, '..')

/** Empreintes des clés privées retirées lors de la rotation du 2026-08-26. */
const RETIRED_PUBLIC_FINGERPRINTS = [
  '103d8e114bd742c0064dc3218294e8c5bec33cac3aa55aca55d1facad515a030', // dernière paire sur disque avant rotation
  'af0560577f2675c909c178272e7bee70b5bbfabb09862ed3e694e872af493e01', // paire présente dans l'historique Git (fe6191f)
]

const SECRET_PATTERNS = [
  { name: 'clé privée PEM', re: /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  // Valeurs réelles uniquement : le MOT « service_role » / le test de
  // préfixe « sb_secret_ » existent dans la librairie supabase-js elle-même.
  { name: 'secret Supabase (valeur)', re: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'clé service_role configurée', re: /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*['"][^'"]{10,}/ },
  { name: 'JWT service_role embarqué', re: /"role"\s*:\s*"service_role"/ },
  { name: 'token Gumroad', re: /GUMROAD_API_TOKEN\s*[=:]\s*['"][^'"]{10,}|gumroad[_-]access[_-]token|access_token=[A-Za-z0-9]{16,}/i },
  { name: 'mot de passe BDD', re: /(DATABASE_PASSWORD|DB_PASSWORD|POSTGRES_PASSWORD)\s*[=:]\s*['"][^'"]{6,}/ },
  { name: 'clé OpenAI/Anthropic en dur', re: /sk-(ant-)?[A-Za-z0-9_-]{40,}/ },
]

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** Fichiers candidats, limités aux artefacts de distribution. */
function collectFiles(dir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // node_modules natifs : volumineux et sans secret projet ; le gros du
      // risque est dans l'app.asar / les JS compilés / l'installateur.
      if (/^(locales|node_modules)$/.test(entry.name)) continue
      collectFiles(full, out)
    } else if (/\.(js|json|html|css|map|txt|yml|yaml|asar|exe|blockmap|pem)$/i.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

let detections = 0
let scannedFiles = 0

for (const target of ['dist', 'dist-electron', 'release', ...process.argv.slice(2)]) {
  const dir = path.isAbsolute(target) ? target : path.join(root, target)
  if (!fs.existsSync(dir)) {
    console.log(`-- ${target}/ absent (ignoré)`)
    continue
  }
  for (const file of collectFiles(dir)) {
    scannedFiles++
    const rel = path.relative(root, file)
    const buf = fs.readFileSync(file)
    // Binaires (.exe) : Chromium contient des milliers de chaînes arbitraires
    // qui déclenchent des faux positifs ; on n'y cherche que les blocs PEM.
    const isBinary = /\.exe$/i.test(file)
    const text = buf.toString('utf8')
    if (!isBinary) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(text)) {
          const line = text.split(/\r?\n/).findIndex(l => re.test(l)) + 1
          console.log(`FAIL  ${rel}${line ? `:${line}` : ''} : ${name}`)
          detections++
        }
      }
    } else {
      const pemRe = /-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/
      if (pemRe.test(text)) {
        console.log(`FAIL  ${rel} : clé privée PEM`)
        detections++
      }
    }

    // Empreintes des clés publiques RETIRÉES (texte et asar).
    const pemBlocks = text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []
    for (const block of pemBlocks) {
      try {
        const fp = crypto.createHash('sha256')
          .update(crypto.createPublicKey(block).export({ format: 'der', type: 'spki' }))
          .digest('hex')
        if (RETIRED_PUBLIC_FINGERPRINTS.includes(fp)) {
          console.log(`FAIL  ${rel} : CLÉ PUBLIQUE RETIRÉE PRÉSENTE (${fp.slice(0, 16)}…)`)
          detections++
        }
      } catch { /* bloc non analysable */ }
    }
  }
}

// La clé publique ACTIVE doit être embarquée (sinon la vérification échoue).
const activePub = path.join(root, 'dist-electron', 'keys', 'public.pem')
if (fs.existsSync(activePub)) {
  const fp = crypto.createHash('sha256')
    .update(crypto.createPublicKey(fs.readFileSync(activePub, 'utf8')).export({ format: 'der', type: 'spki' }))
    .digest('hex')
  const status = RETIRED_PUBLIC_FINGERPRINTS.includes(fp) ? 'FAIL' : 'PASS'
  if (status === 'FAIL') detections++
  console.log(`${status}  clé publique active dist-electron (fp=${fp.slice(0, 16)}…)`)
}

console.log(`\n${scannedFiles} fichiers scannés, ${detections} détection(s)`)
process.exit(detections === 0 ? 0 : 1)
