const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const mode = process.argv[2]
if (mode !== 'dev' && mode !== 'prod') {
  console.error('Usage: node scripts/launch-electron.cjs <dev|prod>')
  process.exit(2)
}

const cwd = path.resolve(__dirname, '..')
const electronPath = process.platform === 'win32'
  ? path.join(cwd, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(cwd, 'node_modules', 'electron', 'dist', 'electron')

if (!fs.existsSync(electronPath)) {
  console.error(`[launch] Electron introuvable: ${electronPath}`)
  console.error('[launch] Lance "npm install" puis reessaie.')
  process.exit(1)
}

if (!fs.existsSync(path.join(cwd, 'dist-electron', 'main.js'))) {
  console.error('[launch] dist-electron/main.js manquant. Lance "npm run build".')
  process.exit(1)
}

if (mode === 'prod' && !fs.existsSync(path.join(cwd, 'dist', 'index.html'))) {
  console.error('[launch] dist/index.html manquant. Lance "npm run build".')
  process.exit(1)
}

const env = { ...process.env, ELECTRON_DEV: mode === 'dev' ? 'true' : 'false' }
console.log(`[launch] mode=${mode} platform=${process.platform}`)

const child = spawn(electronPath, ['.'], { cwd, env, stdio: 'inherit' })

child.on('error', error => {
  console.error(`[launch] demarrage impossible: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
