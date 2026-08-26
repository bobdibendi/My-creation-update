/**
 * Test runner.
 *
 * Suites come in two flavours:
 *  - `node`: plain Node processes (providers, runtime) with piped stdio.
 *  - `electron`: hosted inside Electron for real safeStorage and BrowserWindow.
 *    Electron is a GUI-subsystem binary on Windows and cannot reliably write to
 *    a piped stdout, so those suites append to a temp file that this runner
 *    tails live.
 *
 * Usage: node scripts/test.cjs [suite] [-- suite args]
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const electronBinary = process.platform === 'win32'
  ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')

const suites = [
  { id: 'providers', label: 'Providers', script: 'scripts/test-providers.cjs', host: 'node' },
  { id: 'runtime', label: 'Runtime', script: 'scripts/test-runtime.cjs', host: 'node' },
  { id: 'license-tamper', label: 'Licence anti-falsification', script: 'scripts/test-license-tamper.cjs', host: 'node' },
  { id: 'renderer', label: 'Renderer', script: 'scripts/test-renderer.cjs', host: 'electron' },
  { id: 'app', label: 'Application', script: 'scripts/test-app.cjs', host: 'electron' },
  { id: 'agent', label: 'Agent', script: 'scripts/test-agent.cjs', host: 'electron' },
]

const args = process.argv.slice(2)
const requested = args[0] && !args[0].startsWith('-') ? args[0] : null
const suiteArgs = requested ? args.slice(1) : args
const selected = requested ? suites.filter(suite => suite.id === requested) : suites

if (selected.length === 0) {
  console.error(`Suite inconnue: ${requested}. Options: ${suites.map(suite => suite.id).join(', ')}`)
  process.exit(2)
}

if (selected.some(suite => suite.host === 'electron') && !fs.existsSync(electronBinary)) {
  console.error(`Electron introuvable: ${electronBinary}. Lance "npm install".`)
  process.exit(1)
}

function runNodeSuite(suite) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [suite.script, ...suiteArgs], {
      cwd: projectRoot,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', error => {
      console.error(`Impossible de lancer ${suite.label}: ${error.message}`)
      resolve(1)
    })
    child.on('close', code => resolve(code === 0 ? 0 : 1))
  })
}

function runElectronSuite(suite) {
  return new Promise(resolve => {
    console.log(`=== ${suite.label} ===`)
    const outputFile = path.join(os.tmpdir(), `cursor-clone-test-${suite.id}-${Date.now()}.log`)
    fs.writeFileSync(outputFile, '', 'utf8')

    let offset = 0
    const flush = () => {
      try {
        const stats = fs.statSync(outputFile)
        if (stats.size <= offset) return
        const handle = fs.openSync(outputFile, 'r')
        const buffer = Buffer.alloc(stats.size - offset)
        fs.readSync(handle, buffer, 0, buffer.length, offset)
        fs.closeSync(handle)
        offset = stats.size
        process.stdout.write(buffer.toString('utf8'))
      } catch {
        // The file may be mid-write; the next tick picks it up.
      }
    }
    const timer = setInterval(flush, 300)

    const child = spawn(electronBinary, [suite.script, ...suiteArgs], {
      cwd: projectRoot,
      env: { ...process.env, TEST_OUTPUT: outputFile, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: 'ignore',
    })

    child.on('error', error => {
      clearInterval(timer)
      console.error(`Impossible de lancer ${suite.label}: ${error.message}`)
      resolve(1)
    })

    child.on('close', code => {
      clearInterval(timer)
      flush()
      try { fs.unlinkSync(outputFile) } catch { /* best effort */ }
      // Electron reports GUI-subsystem exits with large unsigned codes; only 0 passes.
      resolve(code === 0 ? 0 : 1)
    })
  })
}

void (async () => {
  const results = []
  for (const suite of selected) {
    if (results.length > 0) console.log('')
    const code = suite.host === 'node' ? await runNodeSuite(suite) : await runElectronSuite(suite)
    results.push({ suite, code })
  }

  console.log('\n=== Bilan ===')
  for (const { suite, code } of results) {
    console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${suite.label}`)
  }
  process.exit(results.every(result => result.code === 0) ? 0 : 1)
})()
