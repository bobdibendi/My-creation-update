#!/usr/bin/env node
/**
 * Résolution centralisée des clés RSA de licence pour les scripts Node.
 *
 * Après la rotation d'août 2026, la clé PRIVÉE ne vit plus dans
 * electron/keys/ : elle est réservée à l'environnement sécurisé du
 * License Generator. Ordre de résolution :
 *   1. MC_PRIVATE_KEY_PATH (environnement)
 *   2. LICENSE_PRIVATE_KEY_PATH (environnement, compatibilité générateur)
 *   3. <repo>/license-generator/secrets/private.pem
 *   4. <repo>/electron/keys/private.pem (historique, si encore présent)
 *
 * La clé PUBLIQUE reste dans electron/keys/public.pem (embarquée au build).
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

function privateKeyCandidates() {
  const list = []
  if (process.env.MC_PRIVATE_KEY_PATH) list.push(path.resolve(process.env.MC_PRIVATE_KEY_PATH))
  if (process.env.LICENSE_PRIVATE_KEY_PATH) list.push(path.resolve(process.env.LICENSE_PRIVATE_KEY_PATH))
  list.push(path.join(root, 'license-generator', 'secrets', 'private.pem'))
  list.push(path.join(root, 'electron', 'keys', 'private.pem'))
  return list
}

/** Chemin de la clé privée disponible, sinon null. */
function findPrivateKeyPath() {
  return privateKeyCandidates().find(candidate => fs.existsSync(candidate)) ?? null
}

/** Chemin de la clé privée, ou erreur explicite (jamais de fallback silencieux). */
function privateKeyPath() {
  const found = findPrivateKeyPath()
  if (!found) {
    throw new Error(
      'Clé privée introuvable : définissez MC_PRIVATE_KEY_PATH ou placez private.pem '
      + 'dans license-generator/secrets/ (environnement sécurisé du License Generator).',
    )
  }
  return found
}

/** Contenu PEM de la clé privée (lecture unique par appel). */
function readPrivateKey() {
  return fs.readFileSync(privateKeyPath(), 'utf8')
}

/** Chemin de la clé publique embarquée par l'application. */
function publicKeyPath() {
  return path.join(root, 'electron', 'keys', 'public.pem')
}

module.exports = { root, privateKeyCandidates, findPrivateKeyPath, privateKeyPath, readPrivateKey, publicKeyPath }
