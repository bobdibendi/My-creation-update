/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')

// Write package.json so Node resolves dist-electron/ as CommonJS.
const pkg = { type: 'commonjs' }
const dest = path.resolve(__dirname, '..', 'dist-electron', 'package.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(pkg, null, 2), 'utf-8')
console.log('✓ dist-electron/package.json created (type: commonjs)')
