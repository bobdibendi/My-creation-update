#!/usr/bin/env node
/**
 * PONT ADMIN ONE-SHOT (outil de développement, jamais distribué).
 *
 * Lit la clé 'tools' du keystore legacy (identité 'cursor-clone') et écrit
 * %APPDATA%\My Creation\admin-keys.json pour que l'EXE installé l'importe
 * au prochain démarrage (electron/main.ts -> importAdminKeysFile).
 *
 * La clé n'est JAMAIS imprimée ni loguée : elle transite uniquement entre
 * deux fichiers locaux du même utilisateur Windows.
 *
 * Usage: electron.exe scripts/bridge-admin-key.cjs
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const out = process.env.DIAG_OUT
const write = line => out ? fs.appendFileSync(out, line + '\n', 'utf8') : console.log(line)

app.setName('cursor-clone')
app.disableHardwareAcceleration()

app.whenReady().then(() => {
  try {
    const keystoreModule = require(path.join(__dirname, '..', 'dist-electron', 'keystore.js'))
    write(`module keys: ${Object.keys(keystoreModule).join(',')}`)
    const KeyStore = keystoreModule.KeyStore
    const store = new KeyStore()
    const toolsKey = store.get('tools')
    if (!toolsKey) {
      write('FAIL cle tools absente du keystore legacy')
      app.exit(1)
      return
    }

    const targetDir = path.join(app.getPath('appData'), 'My Creation')
    fs.mkdirSync(targetDir, { recursive: true })
    const targetFile = path.join(targetDir, 'admin-keys.json')
    // Contenu minimal : uniquement les providers nécessaires à l'EXE.
    fs.writeFileSync(targetFile, JSON.stringify({ tools: toolsKey }, null, 2), 'utf8')

    write(`OK admin-keys.json écrit (${safeStorage.isEncryptionAvailable() ? 'l\'EXE le re-chiffrera via safeStorage' : 'fallback plaintext'})`)
    write(`     empreinte: ${toolsKey.slice(0, 6)}.../${toolsKey.length} chars — jamais loguée intégralement`)
    app.exit(0)
  } catch (error) {
    write(`FATAL ${error && error.stack ? error.stack : String(error)}`)
    app.exit(1)
  }
})
