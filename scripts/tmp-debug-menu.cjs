const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const projectRoot = path.resolve(__dirname, '..')
app.setName('cursor-clone')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

async function main() {
  require(path.join(projectRoot, 'dist-electron', 'main.js'))
  let win = null
  for (let i = 0; i < 200 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] ?? null
    if (!win) await new Promise(r => setTimeout(r, 100))
  }
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message.slice(0, 300)} (${sourceId.split('/').pop()}:${line})`)
  })
  await new Promise(r => setTimeout(r, 2500))
  const boot = await win.webContents.executeJavaScript(`
    (async () => {
      const bridge = window.electronAPI
      const registered = await bridge.auth.register('dbg3-' + Date.now() + '@mycreation.app', 'mot-de-passe-123', 'Dbg3')
      return { sessionToken: registered.sessionToken ?? null }
    })()
  `, true)
  await win.webContents.executeJavaScript(`localStorage.setItem('cursor-clone:session-token', ${JSON.stringify(boot.sessionToken)})`, true)
  console.log('--- RELOAD ---')
  await win.reload()
  await new Promise(r => setTimeout(r, 3500))
  const snapshot = await win.webContents.executeJavaScript(`
    ({
      bodyChildren: Array.from(document.body.children).map(el => el.className || el.tagName).slice(0, 6),
      hasSplash: Boolean(document.querySelector('.splash')),
      splashVisibleText: document.querySelector('.splash')?.textContent?.slice(0,80) ?? null,
      hasOnboarding: Boolean(document.querySelector('.onboarding')),
      hasLicenseScreen: Boolean(document.querySelector('.license-screen, [class*="license"]')),
      hasAppShell: Boolean(document.querySelector('.workspace, .app-shell, [class*="titlebar"]')),
      firstClasses: document.body.innerHTML.slice(0, 400),
    })
  `, true)
  console.log('SNAPSHOT:', JSON.stringify(snapshot, null, 1))
  app.exit(0)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
