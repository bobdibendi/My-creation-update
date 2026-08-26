/**
 * Launch smoke test.
 *
 * Starts the application exactly as a user would (`npm start` for production,
 * `npm run dev` for development), waits for the main process to report that the
 * renderer finished loading, then shuts it down. Verifies the real entry points
 * rather than a test harness.
 *
 * Usage: node scripts/test-launch.cjs [prod|dev|both]
 */
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmCliFallback = path.join(projectRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npmEntry = fs.existsSync(npmCli) ? npmCli : npmCliFallback

const requested = process.argv[2] || 'both'
const modes = requested === 'both' ? ['prod', 'dev'] : [requested]

if (!modes.every(mode => mode === 'prod' || mode === 'dev')) {
  console.error('Usage: node scripts/test-launch.cjs [prod|dev|both]')
  process.exit(2)
}

if (!fs.existsSync(npmEntry)) {
  console.error(`npm-cli.js introuvable: ${npmEntry}`)
  process.exit(1)
}

/** Kills a process tree; npm and concurrently both spawn children. */
function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }
}

function launch(mode) {
  return new Promise(resolve => {
    const script = mode === 'prod' ? 'start' : 'dev'
    console.log(`\n=== npm run ${script} ===`)

    const child = spawn(process.execPath, [npmEntry, 'run', script], {
      cwd: projectRoot,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let output = ''
    let settled = false
    const problems = []

    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      resolve({ code, output, problems })
    }

    const timer = setTimeout(() => {
      problems.push(`le renderer n'a pas signale son chargement en 120s`)
      finish(1)
    }, 120000)

    const inspect = (chunk) => {
      output += chunk
      if (/\[main\] renderer ready/.test(output)) finish(0)
      // Any of these means the app came up broken.
      if (/did-fail-load|renderer load failed|Cannot find module|MODULE_NOT_FOUND/.test(chunk)) {
        problems.push(chunk.trim().split('\n')[0])
        finish(1)
      }
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)

    child.on('error', error => {
      problems.push(`demarrage impossible: ${error.message}`)
      finish(1)
    })

    child.on('close', code => {
      if (settled) return
      problems.push(`le processus s'est arrete prematurement (code ${code})`)
      finish(1)
    })
  })
}

void (async () => {
  const results = []
  for (const mode of modes) {
    const result = await launch(mode)
    if (result.code === 0) {
      console.log(`PASS  Lancement ${mode}`)
    } else {
      console.log(`FAIL  Lancement ${mode}`)
      for (const problem of result.problems) console.log(`      ${problem}`)
      const tail = result.output.trim().split('\n').slice(-15)
      for (const line of tail) console.log(`      ${line}`)
    }
    results.push(result.code)
    // Let the previous instance release the port and the single-instance lock.
    await new Promise(resolve => setTimeout(resolve, 2500))
  }

  console.log('\n=== Bilan ===')
  modes.forEach((mode, index) => {
    console.log(`${results[index] === 0 ? 'PASS' : 'FAIL'}  Lancement ${mode}`)
  })
  process.exit(results.every(code => code === 0) ? 0 : 1)
})()
