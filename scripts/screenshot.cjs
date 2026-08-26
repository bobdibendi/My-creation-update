/**
 * Captures screenshots of the running application so the UI can be reviewed.
 *
 * The DOM selectors below are a contract with the renderer. If a class or a
 * button title changes, update this file in the same commit.
 *
 * Usage: node scripts/screenshot.cjs [outputDir]
 */
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const projectRoot = path.resolve(__dirname, '..')
const outputDir = process.argv[2] || path.join(os.tmpdir(), 'cursor-clone-screens')

app.setName('cursor-clone')
app.on('window-all-closed', () => {})

require(path.join(projectRoot, 'dist-electron', 'main.js'))

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      const value = predicate()
      if (value) { resolve(value); return }
      if (Date.now() > deadline) { reject(new Error(`timeout: ${label}`)); return }
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function capture(win, name) {
  await new Promise(resolve => setTimeout(resolve, 800))
  const image = await win.capturePage()
  const file = path.join(outputDir, `${name}.png`)
  await fsp.writeFile(file, image.toPNG())
  console.log(`ecrit ${file}`)
}

function click(win, script) {
  return win.webContents.executeJavaScript(script)
}

/**
 * Waits until `selector` leaves the DOM.
 *
 * Used for the splash overlay: its timer runs on the renderer main thread, which
 * the Monaco bundle stalls for a few seconds, so a fixed delay is not enough.
 */
function waitGone(win, selector, timeoutMs) {
  return win.webContents.executeJavaScript(`(async () => {
    const deadline = Date.now() + ${timeoutMs}
    while (document.querySelector(${JSON.stringify(selector)})) {
      if (Date.now() > deadline) return false
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    return true
  })()`)
}

/** Dismisses any open dropdown: they close on `mousedown`, not on `click`. */
function dismiss(win, waitMs = 400) {
  return win.webContents.executeJavaScript(`(async () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, ${waitMs}))
    return true
  })()`)
}

/** Clicks a rail button whose accessible title contains `needle`. */
function railScript(needle, waitMs) {
  return `(async () => {
    const button = Array.from(document.querySelectorAll('.activitybar button'))
      .find(candidate => (candidate.getAttribute('title') || '').includes(${JSON.stringify(needle)}))
    if (button) button.click()
    await new Promise(resolve => setTimeout(resolve, ${waitMs}))
    return Boolean(button)
  })()`
}

app.whenReady().then(async () => {
  await fsp.mkdir(outputDir, { recursive: true })

  // A demo workspace so the explorer, editor, git and analysis panels have content.
  const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'cursor-clone-shot-'))
  await fsp.mkdir(path.join(workspace, 'src', 'composants'), { recursive: true })
  await fsp.writeFile(path.join(workspace, 'package.json'),
    JSON.stringify({ name: 'demo-sushis', version: '1.0.0', scripts: { build: 'vite build', typecheck: 'tsc --noEmit' } }, null, 2) + '\n', 'utf8')
  await fsp.writeFile(path.join(workspace, 'README.md'),
    '# Demo sushis\n\nPetit projet de demonstration pour My Creation.\n\n## Utilisation\n\n```bash\nnpm install\nnpm run build\n```\n', 'utf8')
  await fsp.writeFile(path.join(workspace, 'index.html'),
    '<!doctype html>\n<html lang="fr">\n<head><meta charset="utf-8"><title>Sushis</title></head>\n<body><h1>Carte des sushis</h1></body>\n</html>\n', 'utf8')
  await fsp.writeFile(path.join(workspace, 'src', 'main.ts'),
    [
      "import { carte } from './composants/carte'",
      '',
      'export interface Sushi {',
      '  nom: string',
      '  prix: number',
      '  vegetarien: boolean',
      '}',
      '',
      'export function total(items: Sushi[]): number {',
      '  return items.reduce((somme, item) => somme + item.prix, 0)',
      '}',
      '',
      'export function afficher(items: Sushi[]): string {',
      '  return items.map(item => `${item.nom} �?" ${item.prix.toFixed(2)} �,�`).join(\'\\n\')',
      '}',
      '',
      'carte()',
      '',
    ].join('\n'), 'utf8')
  await fsp.writeFile(path.join(workspace, 'src', 'composants', 'carte.ts'),
    ['export function carte(): void {', '  console.info(\'carte des sushis\')', '}', ''].join('\n'), 'utf8')

  // The folder picker is a native dialog: answer it with the demo workspace.
  ipcMain.removeHandler('files:open-folder')
  ipcMain.handle('files:open-folder', () => workspace)

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 20000, 'fenetre')
  if (win.webContents.isLoading()) {
    await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
  }
  win.setSize(1440, 900)
  // The splash timer runs on the renderer main thread, which the Monaco bundle
  // stalls: poll the overlay out instead of guessing a delay.
  await waitGone(win, '.splash', 20000)

  await capture(win, '01-accueil')

  await click(win, `(async () => {
    document.querySelectorAll('.commandbar .toolbar-btn')[0].click()
    await new Promise(resolve => setTimeout(resolve, 1600))
    return document.querySelectorAll('.tree-row').length
  })()`)
  await capture(win, '02-accueil-projet')

  await capture(win, '03-explorateur')

  await click(win, `(async () => {
    const rows = Array.from(document.querySelectorAll('.tree-row'))
    const folder = rows.find(row => (row.textContent || '').trim() === 'src')
    if (folder) folder.click()
    await new Promise(resolve => setTimeout(resolve, 900))
    const file = Array.from(document.querySelectorAll('.tree-row'))
      .find(row => (row.textContent || '').includes('main.ts'))
    if (file) file.click()
    await new Promise(resolve => setTimeout(resolve, 1800))
    return Boolean(file)
  })()`)
  await capture(win, '04-editeur')

  await click(win, railScript('Terminal', 2400))
  await capture(win, '05-terminal')

  await click(win, railScript('Assistant', 1200))
  await capture(win, '06-assistant')

  await click(win, `(async () => {
    const area = document.querySelector('.agent-composer textarea')
    if (area) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(area, 'Analyse le projet et corrige les erreurs.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    return Boolean(area)
  })()`)
  await capture(win, '07-assistant-saisie')

  await click(win, `(async () => {
    const selects = document.querySelectorAll('.agent-topbar .agent-select')
    if (selects[1]) selects[1].click()
    await new Promise(resolve => setTimeout(resolve, 600))
    return selects.length
  })()`)
  await capture(win, '08-modeles')

  // Dropdowns dismiss on mousedown, not on click.
  await dismiss(win)

  await click(win, railScript('Conversations', 800))
  await capture(win, '09-conversations')

  await click(win, railScript('source', 1100))
  await capture(win, '10-source-control')

  await click(win, railScript('Recherche', 600))
  await click(win, `(async () => {
    const input = document.querySelector('.search-panel input')
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, 'sushi')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    await new Promise(resolve => setTimeout(resolve, 1800))
    return Boolean(input)
  })()`)
  await capture(win, '11-recherche')

  // Close the assistant: the remaining panels are wide and read better full width.
  await click(win, railScript('Assistant', 700))

  await click(win, railScript('Aperçu', 1600))
  await capture(win, '12-apercu')

  // Serve the demo workspace so the frame shows a real page rather than an empty state.
  const served = await click(win, `(async () => {
    const button = document.querySelector('.preview__candidates button')
    if (!button) return false
    button.click()
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500))
      if (document.querySelector('.preview__frame')) return true
    }
    return false
  })()`)
  if (served) {
    await new Promise(resolve => setTimeout(resolve, 1800))
    await capture(win, '13-apercu-servi')
    await click(win, `(async () => {
      const mobile = Array.from(document.querySelectorAll('.preview__devicebar .ui-segmented__item'))
        .find(option => (option.textContent || '').includes('Mobile'))
      if (mobile) mobile.click()
      await new Promise(resolve => setTimeout(resolve, 1200))
      return Boolean(mobile)
    })()`)
    await capture(win, '14-apercu-mobile')
  } else {
    console.warn('aperçu non démarré: captures 13/14 ignorées')
  }

  await click(win, railScript('Analyse', 3200))
  await capture(win, '15-analyse')

  for (const [name, label] of [['16-analyse-arbre', 'Arbre'], ['17-analyse-dependances', 'Dépendances'], ['18-analyse-qualite', 'Qualité']]) {
    await click(win, `(async () => {
      const option = Array.from(document.querySelectorAll('.analysis__toolbar .ui-segmented__item'))
        .find(candidate => (candidate.textContent || '').includes(${JSON.stringify(label)}))
      if (option) option.click()
      await new Promise(resolve => setTimeout(resolve, 1100))
      return Boolean(option)
    })()`)
    await capture(win, name)
  }

  await click(win, `(async () => {
    document.dispatchEvent(new CustomEvent('open-settings'))
    await new Promise(resolve => setTimeout(resolve, 900))
    return true
  })()`)
  await capture(win, '19-parametres')

  await click(win, `(async () => {
    const themes = Array.from(document.querySelectorAll('.settings__nav-item'))
      .find(item => (item.textContent || '').includes('Thèmes'))
    if (themes) themes.click()
    await new Promise(resolve => setTimeout(resolve, 700))
    return Boolean(themes)
  })()`)
  await capture(win, '20-themes')

  await click(win, `(async () => {
    const cards = Array.from(document.querySelectorAll('.theme-card'))
    const cursor = cards.find(card => (card.textContent || '').includes('Cursor'))
    if (cursor) cursor.click()
    await new Promise(resolve => setTimeout(resolve, 700))
    return Boolean(cursor)
  })()`)
  await capture(win, '21-theme-cursor')

  // A light theme exercises the palette on the opposite end of the range.
  const light = await click(win, `(async () => {
    const cards = Array.from(document.querySelectorAll('.theme-card'))
    const target = cards.find(card => (card.textContent || '').includes('clair'))
    if (!target) return false
    target.click()
    await new Promise(resolve => setTimeout(resolve, 700))
    return true
  })()`)
  if (light) await capture(win, '22-theme-clair')

  await click(win, `(async () => {
    const cards = Array.from(document.querySelectorAll('.theme-card'))
    const claude = cards.find(card => (card.textContent || '').trim().startsWith('Claude'))
    if (claude) claude.click()
    await new Promise(resolve => setTimeout(resolve, 500))
    const close = document.querySelector('.settings-modal header button[aria-label="Fermer"]')
      || document.querySelector('.settings-modal header button')
    if (close) close.click()
    await new Promise(resolve => setTimeout(resolve, 500))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 800))
    return Boolean(document.querySelector('.command-palette'))
  })()`)
  await capture(win, '23-palette')

  // The terminal holds a handle on the workspace; ignore a locked cleanup.
  await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {})
  console.log(`dossier: ${outputDir}`)
  app.exit(0)
}).catch(error => {
  console.error(error && error.stack ? error.stack : String(error))
  app.exit(1)
})
