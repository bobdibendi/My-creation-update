/**
 * Test reporter shared by the Electron-hosted suites.
 *
 * Electron on Windows runs as a GUI subsystem binary, so writes to stdout are
 * unreliable once a BrowserWindow exists. Each suite appends its lines to the
 * file named by TEST_OUTPUT and the runner relays them, which keeps output
 * visible while the suite is still running.
 */
const fs = require('node:fs')

const target = process.env.TEST_OUTPUT || null

function report(line) {
  const text = String(line)
  if (target) {
    try {
      fs.appendFileSync(target, text + '\n', 'utf8')
      return
    } catch {
      // Fall through to stdout.
    }
  }
  try {
    fs.writeSync(1, text + '\n')
  } catch {
    process.stdout.write(text + '\n')
  }
}

module.exports = { report }
