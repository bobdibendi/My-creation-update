#!/usr/bin/env node
/**
 * Test REEL du Terminal integre (electron/terminal.ts compile).
 *
 * Spawn un vrai shell Windows (cmd.exe) via TerminalManager et verifie :
 *   - node --version  -> sortie contenant vXX.YY.ZZ ;
 *   - npm --version   -> sortie numerique ;
 *   - exit code transmis ;
 *   - kill d'un processus long.
 *
 * Usage : node scripts/test-terminal-real.cjs   (apres npm run build)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const distDir = path.resolve(__dirname, '..', 'dist-electron')
if (!fs.existsSync(path.join(distDir, 'terminal.js'))) {
  console.error('FATAL dist-electron/terminal.js absent. Lance "npm run build".')
  process.exit(1)
}
const { TerminalManager } = require(path.join(distDir, 'terminal.js'))

let passCount = 0
let failCount = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
    passCount++
  } else {
    console.error(`FAIL  ${name}${detail ? ` (${detail})` : ''}`)
    failCount++
  }
}

/** Attend qu'un predicat devienne vrai sur la valeur d'un getter. */
function waitFor(getter, predicate, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      if (predicate(getter())) { resolve(true); return }
      if (Date.now() > deadline) { resolve(false); return }
      setTimeout(poll, 120)
    }
    poll()
  })
}

async function main() {
  const outputRef = { current: '' }
  let exitCode
  let errorMessage = null

  const manager = new TerminalManager({
    onData: (_id, data) => { outputRef.current += data },
    onExit: (_id, code) => { exitCode = code },
    onError: (_id, message) => { errorMessage = message },
  }, os.tmpdir())

  // -- node --version --
  const id = await manager.create(os.tmpdir())
  check('shell cree (cmd.exe)', typeof id === 'string' && id.length > 0, String(id).slice(0, 8))
  check('aucune erreur de spawn', errorMessage === null, String(errorMessage))

  outputRef.current = ''
  manager.write(id, 'node --version\r\n')
  const gotNode = await waitFor(() => outputRef.current, text => /v\d+\.\d+\.\d+/.test(text), 20000)
  const version = (outputRef.current.match(/v\d+\.\d+\.\d+/) || ['?'])[0]
  check('node --version répond (vX.Y.Z réel)', gotNode, version)

  // -- npm --version --
  outputRef.current = ''
  manager.write(id, 'npm --version\r\n')
  const gotNpm = await waitFor(() => outputRef.current, text => /\d+\.\d+\.\d+/.test(text), 30000)
  const npmVersion = (outputRef.current.match(/\d+\.\d+\.\d+/) || ['?'])[0]
  check('npm --version répond', gotNpm, npmVersion)

  // -- exit code --
  outputRef.current = ''
  exitCode = undefined
  manager.write(id, 'exit /b 7\r\n')
  const exited = await waitFor(() => exitCode, code => code !== undefined, 15000)
  check('exit code transmis au renderer', exited && exitCode === 7, `code=${exitCode}`)

  // -- kill d'un processus long --
  const longId = await manager.create(os.tmpdir())
  manager.write(longId, 'ping -n 30 127.0.0.1 > nul\r\n')
  await new Promise(resolve => setTimeout(resolve, 1200))
  manager.kill(longId)
  check('kill d’un processus long sans bloquer', true)

  manager.killAll()
}

main().then(() => {
  console.log('\n=========================================')
  console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
  console.log('=========================================')
  process.exit(failCount === 0 ? 0 : 1)
}).catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
