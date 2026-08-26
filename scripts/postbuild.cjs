const fs = require('fs')
const path = require('path')

// Write package.json so Node resolves dist-electron/ as CommonJS
const pkg = { type: 'commonjs' }
const dest = path.resolve(__dirname, '..', 'dist-electron', 'package.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(pkg, null, 2), 'utf-8')
console.log('✓ dist-electron/package.json created (type: commonjs)')

// license.ts resolves keys/public.pem next to its compiled file (__dirname).
// The key pair stays out of git; the public half ships with the app, the
// private half never leaves the machine of whoever signs licenses.
const publicKey = path.resolve(__dirname, '..', 'electron', 'keys', 'public.pem')
const publicKeyDest = path.resolve(__dirname, '..', 'dist-electron', 'keys', 'public.pem')
if (fs.existsSync(publicKey)) {
  fs.mkdirSync(path.dirname(publicKeyDest), { recursive: true })
  fs.copyFileSync(publicKey, publicKeyDest)
  console.log('✓ dist-electron/keys/public.pem copied')
} else {
  console.warn('⚠ electron/keys/public.pem introuvable : la vérification de licence échouera')
}
