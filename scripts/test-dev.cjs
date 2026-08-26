/**
 * Dev-mode smoke test.
 *
 * Starts the Vite dev server, waits for it to answer, then runs the renderer
 * suite against http://127.0.0.1:5173 so `npm run dev` is verified end to end
 * (Vite + HMR transform pipeline + Electron + preload).
 *
 * Usage: node scripts/test-dev.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const http = require('node:http')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const viteBinary = path.join(
  projectRoot,
  'node_modules',
  'vite',
  'bin',
  'vite.js',
)
const electronBinary = process.platform === 'win32'
  ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron')

const DEV_URL = 'http://127.0.0.1:5173/'

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    })
    request.on('error', reject)
    request.setTimeout(4000, () => request.destroy(new Error('timeout')))
  })
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await get(DEV_URL)
      if (response.status === 200) return response.body
    } catch {
      // Not listening yet.
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`le serveur Vite n'a pas repondu en ${timeoutMs / 1000}s`)
}

function runRendererSuite() {
  return new Promise(resolve => {
    const outputFile = path.join(os.tmpdir(), `cursor-clone-test-dev-${Date.now()}.log`)
    fs.writeFileSync(outputFile, '', 'utf8')

    const child = spawn(electronBinary, ['scripts/test-renderer.cjs', '--dev'], {
      cwd: projectRoot,
      env: { ...process.env, TEST_OUTPUT: outputFile, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      stdio: 'ignore',
    })

    child.on('error', error => {
      console.log(`FAIL  Dev: impossible de lancer Electron (${error.message})`)
      resolve(1)
    })

    child.on('close', code => {
      try {
        const output = fs.readFileSync(outputFile, 'utf8')
        if (output.trim().length > 0) process.stdout.write(output)
        fs.unlinkSync(outputFile)
      } catch { /* best effort */ }
      resolve(code === 0 ? 0 : 1)
    })
  })
}

void (async () => {
  console.log('=== Dev (Vite + Electron) ===')

  // Run Vite through Node directly: no shell, so the process tree stays killable.
  const vite = spawn(process.execPath, [viteBinary], {
    cwd: projectRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: 'ignore',
  })

  let exitCode = 1
  try {
    const html = await waitForServer(60000)
    if (!/<div id="root">/.test(html)) throw new Error('la page servie ne contient pas #root')

    const module = await get('http://127.0.0.1:5173/src/main.tsx')
    if (module.status !== 200) throw new Error(`Vite ne transforme pas src/main.tsx (HTTP ${module.status})`)
    if (!/createRoot/.test(module.body)) throw new Error('le module transforme ne contient pas createRoot')

    console.log('PASS  Serveur Vite (page + transformation TSX)')
    exitCode = await runRendererSuite()
  } catch (error) {
    console.log(`FAIL  Dev: ${error.message}`)
    exitCode = 1
  } finally {
    vite.kill()
  }

  console.log(`\n=== Bilan ===\n${exitCode === 0 ? 'PASS' : 'FAIL'}  Dev`)
  process.exit(exitCode)
})()
