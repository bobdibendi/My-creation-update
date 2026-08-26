#!/usr/bin/env node
/**
 * Vérifie une clé de licence (JWT RS256) avec la clé publique embarquée.
 *
 * Usage :
 *   node scripts/verify-license.cjs <token>
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

const token = process.argv[2]
if (!token) {
  console.error('Usage: node scripts/verify-license.cjs <token>')
  process.exit(1)
}

const pubPath = path.resolve(__dirname, '..', 'electron', 'keys', 'public.pem')
if (!fs.existsSync(pubPath)) {
  console.error(`Cle publique introuvable: ${pubPath}`)
  process.exit(1)
}

try {
  const payload = jwt.verify(token, fs.readFileSync(pubPath, 'utf8'), { algorithms: ['RS256'] })
  if (!payload.exp) {
    console.log('VALID - licence lifetime (pas d\'expiration)')
  } else {
    const daysLeft = Math.ceil((payload.exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000))
    console.log(`VALID - expire dans ${daysLeft} jour(s)`)
  }
  console.log(JSON.stringify(payload, null, 2))
} catch (err) {
  console.error(`INVALID: ${err.message}`)
  process.exit(1)
}
