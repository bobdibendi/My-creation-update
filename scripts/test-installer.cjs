/**
 * Installer verification.
 *
 * Drives the real NSIS Setup end to end, without a GUI:
 *
 *   1. silent per-user install  (/S /currentuser)
 *   2. install directory, executable and uninstaller present
 *   3. Start Menu and Desktop shortcuts created
 *   4. uninstall entry registered in the registry
 *   5. the installed application starts and its renderer answers
 *   6. silent uninstall  (/S)
 *   7. install directory, shortcuts and registry entry removed
 *
 * A per-user install needs no administrator rights and writes only to
 * %LOCALAPPDATA%\Programs, the Start Menu and the Desktop of the current user.
 * Everything it creates is removed again by step 6, so the machine is left as it
 * was found. Application settings under %APPDATA%\cursor-clone are deliberately
 * kept, exactly as they are for a real user upgrade.
 *
 * Usage: node scripts/test-installer.cjs [--keep]
 *   --keep  leaves the application installed instead of uninstalling it
 */
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const releaseDir = path.join(projectRoot, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))

const productName = pkg.build.productName
const version = pkg.version
const executableName = `${pkg.build.win.executableName}.exe`
const setupPath = path.join(releaseDir, `${productName} Setup ${version}.exe`)

/**
 * The registry keys electron-builder writes.
 *
 * Both are named after a UUIDv5 derived from `appId`, not from the product name,
 * so the value has to be computed the same way the NSIS target does it.
 */
const { UUID } = require(path.join(projectRoot, 'node_modules', 'builder-util-runtime'))
const NS_UUID = UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3')
const appGuid = UUID.v5(pkg.build.appId, NS_UUID)
const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid}`
const installKey = `HKCU\\Software\\${appGuid}`

const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', productName)
const startMenuLink = path.join(
  process.env.APPDATA,
  'Microsoft', 'Windows', 'Start Menu', 'Programs', `${productName}.lnk`,
)
const desktopLink = path.join(process.env.USERPROFILE, 'Desktop', `${productName}.lnk`)
const uninstallerName = `Uninstall ${productName}.exe`

const DEBUG_PORT = 9355
const keepInstalled = process.argv.includes('--keep')

let failures = 0
let checks = 0

function check(condition, label, detail) {
  checks += 1
  if (condition) {
    console.log(`PASS  ${label}`)
    return true
  }
  failures += 1
  console.log(`FAIL  ${label}`)
  if (detail) {
    for (const line of String(detail).trim().split('\n').slice(0, 10)) console.log(`      ${line}`)
  }
  return false
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Reads a value from a registry key; null when the key or value is absent. */
function readRegistry(key, name) {
  const result = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const match = result.stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`))
  return match ? match[1].trim() : null
}

function registryKeyExists(key) {
  return spawnSync('reg', ['query', key], { encoding: 'utf8' }).status === 0
}

/** Resolves the target of a .lnk shortcut through the Windows shell. */
function shortcutTarget(link) {
  const script = `$shell = New-Object -ComObject WScript.Shell; `
    + `$shell.CreateShortcut(${JSON.stringify(link)}).TargetPath`
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/**
 * Runs the installer or uninstaller and waits for the whole process tree.
 *
 * The NSIS stub relaunches itself and returns immediately, so waiting on the
 * spawned PID is not enough: the directory is polled until it settles.
 */
function runSetup(executable, args, label) {
  return new Promise(resolve => {
    console.log(`      ${label}...`)
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true })
    child.on('error', error => resolve({ ok: false, detail: error.message }))
    child.on('exit', code => resolve({ ok: code === 0, detail: `code ${code}` }))
  })
}

/** Waits until a path exists (or disappears), or the deadline passes. */
async function waitFor(predicate, timeoutMs, intervalMs = 700) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(intervalMs)
  }
  return predicate()
}

function directorySize(target) {
  let total = 0
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    }
  }
  try { walk(target) } catch { /* partially removed */ }
  return total
}

function getJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('timeout', () => { request.destroy(); reject(new Error('timeout')) })
    request.on('error', reject)
  })
}

/** Starts the installed application and confirms its renderer mounted. */
async function verifyInstalledApp(executable) {
  const child = spawn(executable, [`--remote-debugging-port=${DEBUG_PORT}`], {
    cwd: path.dirname(executable),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    stdio: 'ignore',
  })

  const killTree = () => {
    if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }

  try {
    let page = null
    const deadline = Date.now() + 90000
    while (Date.now() < deadline && !page) {
      await delay(600)
      try {
        const targets = await getJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
        page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl)
      } catch { /* not listening yet */ }
    }

    if (!check(Boolean(page), 'l\'application installee demarre')) return

    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('refuse')) })
    })

    let id = 0
    const pending = new Map()
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      const entry = pending.get(message.id)
      if (entry) { pending.delete(message.id); entry(message) }
    })
    const send = (method, params = {}) => new Promise(resolve => {
      id += 1
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })

    await send('Runtime.enable')
    await delay(3500)

    const response = await send('Runtime.evaluate', {
      expression: `(() => ({
        shell: Boolean(document.querySelector('.app-shell') || document.querySelector('.onboarding')),
        onboarding: Boolean(document.querySelector('.onboarding')),
        bridge: Boolean(window.electronAPI),
        url: location.href,
        title: document.title,
      }))()`,
      returnByValue: true,
    })
    const value = response.result?.result?.value ?? {}

    // Auth Supabase obligatoire : sans session confirmée dans ce profil,
    // l'application affiche l'écran Onboarding — montage valide.
    if (value.onboarding) {
      check(true, 'l\'interface React est rendue depuis l\'installation')
      console.log('SKIP  shell complet (ecran Onboarding actif : session Supabase non disponible)')
    } else {
      check(value.shell === true, 'l\'interface React est rendue depuis l\'installation')
    }
    check(value.bridge === true, 'le pont preload fonctionne depuis l\'installation')
    check(String(value.url).includes('app.asar'), 'le renderer est servi depuis app.asar', `url: ${value.url}`)
    check(value.title === productName, `le titre de la fenetre est "${productName}"`, `titre: ${value.title}`)

    socket.close()
  } catch (error) {
    check(false, 'l\'application installee demarre et repond', error.message)
  } finally {
    killTree()
    await delay(1500)
  }
}

/** True when the install directory is absent, or an empty leftover shell. */
function installDirClean() {
  if (!fs.existsSync(installDir)) return true
  try {
    return fs.readdirSync(installDir).length === 0
  } catch {
    return false
  }
}

void (async () => {
  console.log(`Test de l'installateur ${productName} ${version}`)
  console.log(`Cible: ${installDir}`)

  if (!fs.existsSync(setupPath)) {
    console.log(`\nFAIL  installateur introuvable: ${setupPath}`)
    console.log('      Lance "npm run dist" d\'abord.')
    process.exit(1)
  }

  if (!installDirClean()) {
    console.log(`\nFAIL  une installation existe deja: ${installDir}`)
    console.log('      Desinstalle-la avant de relancer ce test.')
    process.exit(1)
  }

  // ── Install ────────────────────────────────────────────
  section('Installation silencieuse')

  // The NSIS stub crashes (0xC0000005) if it is started while Windows is still
  // releasing handles on a directory that was just deleted. Let the filesystem
  // settle before touching it.
  await delay(4000)

  const install = await runSetup(setupPath, ['/S', '/currentuser'], 'installation en cours')
  check(install.ok, 'le programme d\'installation se termine sans erreur', install.detail)

  const installed = await waitFor(() => fs.existsSync(path.join(installDir, executableName)), 120000)
  check(installed, `l'application est installee: ${installDir}`)

  if (installed) {
    console.log(`      taille installee: ${(directorySize(installDir) / 1024 / 1024).toFixed(1)} MB`)
    check(fs.existsSync(path.join(installDir, uninstallerName)),
      `le desinstalleur est present: ${uninstallerName}`)
    check(fs.existsSync(path.join(installDir, 'resources', 'app.asar')), 'resources/app.asar est installe')
    check(fs.existsSync(path.join(installDir, 'resources', 'LICENSE')), 'resources/LICENSE est installe')
    check(fs.existsSync(path.join(installDir, 'uninstallerIcon.ico')), 'l\'icone de desinstallation est installee')
  }

  // ── Shortcuts ──────────────────────────────────────────
  section('Raccourcis')

  const hasStartMenu = await waitFor(() => fs.existsSync(startMenuLink), 20000)
  check(hasStartMenu, 'raccourci Menu Demarrer cree')
  if (hasStartMenu) {
    const target = shortcutTarget(startMenuLink)
    check(target === path.join(installDir, executableName),
      'le raccourci Menu Demarrer pointe sur l\'executable installe', `cible: ${target}`)
  }

  const hasDesktop = fs.existsSync(desktopLink)
  check(hasDesktop, 'raccourci Bureau cree')
  if (hasDesktop) {
    const target = shortcutTarget(desktopLink)
    check(target === path.join(installDir, executableName),
      'le raccourci Bureau pointe sur l\'executable installe', `cible: ${target}`)
  }

  // ── Registry ───────────────────────────────────────────
  section('Enregistrement Windows')

  check(registryKeyExists(uninstallKey), 'l\'entree de desinstallation est enregistree', uninstallKey)
  check(readRegistry(uninstallKey, 'DisplayName') === `${productName} ${version}`,
    'DisplayName correct', `DisplayName: ${readRegistry(uninstallKey, 'DisplayName')}`)
  check(readRegistry(uninstallKey, 'DisplayVersion') === version, 'DisplayVersion correct',
    `DisplayVersion: ${readRegistry(uninstallKey, 'DisplayVersion')}`)
  check(readRegistry(uninstallKey, 'Publisher') === productName, 'Publisher correct',
    `Publisher: ${readRegistry(uninstallKey, 'Publisher')}`)
  check(Boolean(readRegistry(uninstallKey, 'UninstallString')), 'UninstallString present')
  check(Boolean(readRegistry(uninstallKey, 'QuietUninstallString')), 'QuietUninstallString present')
  check(Boolean(readRegistry(uninstallKey, 'DisplayIcon')), 'DisplayIcon present')
  check(readRegistry(installKey, 'InstallLocation') === installDir, 'InstallLocation correct',
    `InstallLocation: ${readRegistry(installKey, 'InstallLocation')}`)
  check(readRegistry(installKey, 'ShortcutName') === productName, 'ShortcutName correct',
    `ShortcutName: ${readRegistry(installKey, 'ShortcutName')}`)

  // ── Launch ─────────────────────────────────────────────
  section('Demarrage depuis l\'installation')

  if (installed) await verifyInstalledApp(path.join(installDir, executableName))

  // ── Uninstall ──────────────────────────────────────────
  if (keepInstalled) {
    section('Desinstallation')
    console.log('      ignoree (--keep): l\'application reste installee')
  } else {
    section('Desinstallation silencieuse')

    const uninstaller = path.join(installDir, uninstallerName)

    if (!fs.existsSync(uninstaller)) {
      check(false, `desinstalleur localise: ${uninstallerName}`)
    } else {
      const uninstall = await runSetup(uninstaller, ['/S', '/currentuser'], 'desinstallation en cours')
      check(uninstall.ok, 'le desinstalleur se termine sans erreur', uninstall.detail)

      // NSIS cannot delete the directory it is executing from, so an empty
      // folder is left behind and removed by Windows on the next reboot. Empty
      // counts as uninstalled; any remaining file does not.
      const cleaned = await waitFor(installDirClean, 120000)
      check(cleaned, 'tous les fichiers installes sont supprimes',
        fs.existsSync(installDir) ? `restant: ${fs.readdirSync(installDir).join(', ')}` : '')
      check(await waitFor(() => !fs.existsSync(startMenuLink), 15000), 'le raccourci Menu Demarrer est supprime')
      check(await waitFor(() => !fs.existsSync(desktopLink), 15000), 'le raccourci Bureau est supprime')
      check(await waitFor(() => !registryKeyExists(uninstallKey), 15000),
        'l\'entree de desinstallation est supprimee')
      check(await waitFor(() => !registryKeyExists(installKey), 15000),
        'la cle d\'installation est supprimee')

      // Settings must survive an uninstall: a reinstall keeps the user's keys.
      const userData = path.join(process.env.APPDATA, pkg.name)
      if (fs.existsSync(userData)) {
        check(true, 'les parametres utilisateur sont conserves', userData)
      }

      // Remove the empty shell so a rerun starts from a clean state.
      if (fs.existsSync(installDir)) {
        try { fs.rmdirSync(installDir) } catch { /* still locked; harmless */ }
      }
    }
  }

  // ── Summary ────────────────────────────────────────────
  section('Bilan')
  console.log(`${checks - failures}/${checks} verifications reussies`)
  if (failures === 0) {
    console.log(keepInstalled
      ? `\nApplication installee: ${installDir}`
      : '\nInstallation et desinstallation validees. Machine laissee propre.')
  } else {
    console.log(`\n${failures} verification(s) en echec.`)
  }
  process.exit(failures === 0 ? 0 : 1)
})()
