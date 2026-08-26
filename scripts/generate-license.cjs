#!/usr/bin/env node
/**
 * Génère une clé de licence (JWT RS256) pour My Creation.
 *
 * Usage local uniquement : requiert electron/keys/private.pem, qui n'est
 * jamais committé ni distribué. La clé publique embarquée dans l'app
 * vérifie la signature, rien de plus.
 *
 * Exemples :
 *   node scripts/generate-license.cjs --email client@example.com --type lifetime
 *   node scripts/generate-license.cjs --email client@example.com --type subscription --days 365
 */
const fs = require('fs')
const path = require('path')
const jwt = require('jsonwebtoken')

const args = process.argv.slice(2)
function readArg(name) {
  const index = args.indexOf(`--${name}`)
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined
}

const email = readArg('email')
const type = readArg('type') || 'lifetime'
const days = Number(readArg('days') || 0)
const version = readArg('version') || null

if (!email) {
  console.error('Usage: node scripts/generate-license.cjs --email <client@example.com> [--type lifetime|subscription] [--days 365] [--version 1.0.0]')
  process.exit(1)
}
if (!['lifetime', 'subscription'].includes(type)) {
  console.error(`--type doit valoir lifetime ou subscription (recu: ${type})`)
  process.exit(1)
}
if (type === 'subscription' && !(days > 0)) {
  console.error('--days > 0 requis pour une licence subscription')
  process.exit(1)
}

let keyPath
try {
  keyPath = require('./keys.cjs').privateKeyPath()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

const payload = {
  iss: 'cursor-clone',
  sub: email,
  licenseId: `lic_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  type,
  product: 'cursor-clone',
  version,
}
if (days > 0) payload.exp = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60

// The LicenseScreen formats the key as XXXX-XXXX-... while typing; a JWT
// already contains dashes, so it is emitted as-is.
const token = jwt.sign(payload, fs.readFileSync(keyPath, 'utf8'), { algorithm: 'RS256' })

console.log(token)
