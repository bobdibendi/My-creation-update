import { BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { resolveInWorkspace, toRelative } from '../agent/workspace.js'
import type { PreviewCapture } from './types.js'

/** Directory the capture is written to, relative to the workspace. */
export const CAPTURE_DIRECTORY = '.preview'
export const CAPTURE_FILENAME = 'latest.png'

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
/** Time allowed for the page to load before capturing whatever is painted. */
const LOAD_TIMEOUT_MS = 15000
/** Extra settle time so fonts, images and entry animations are painted. */
const SETTLE_MS = 700

export interface CaptureOptions {
  url: string
  workspace: string
  width?: number
  height?: number
  /** Overrides the output path, relative to the workspace. */
  relativePath?: string
}

function waitForLoad(win: BrowserWindow): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    // A failed load is still captured: the resulting image shows the error page,
    // which is more useful to the user than no image at all.
    win.webContents.once('did-finish-load', finish)
    win.webContents.once('did-fail-load', finish)
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS)
  })
}

/**
 * Renders a URL in an offscreen window and writes a PNG into the workspace.
 *
 * The window is offscreen rather than merely hidden: a hidden window is not
 * composited on Windows, so `capturePage` would return a blank image.
 */
export async function capturePreview(options: CaptureOptions): Promise<PreviewCapture> {
  const width = Math.min(2560, Math.max(320, options.width ?? DEFAULT_WIDTH))
  const height = Math.min(2560, Math.max(240, options.height ?? DEFAULT_HEIGHT))

  const relative = options.relativePath && options.relativePath.trim().length > 0
    ? options.relativePath.trim()
    : `${CAPTURE_DIRECTORY}/${CAPTURE_FILENAME}`
  const target = await resolveInWorkspace(options.workspace, relative)
  if (path.extname(target).toLowerCase() !== '.png') {
    throw new Error('La capture doit être enregistrée avec l\'extension .png')
  }

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The captured page is untrusted project code; deny it any bridge.
      preload: undefined,
      javascript: true,
    },
  })

  try {
    const loaded = waitForLoad(win)
    void win.loadURL(options.url)
    await loaded
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS))

    const image = await win.webContents.capturePage()
    if (image.isEmpty()) throw new Error(`La page ${options.url} n'a produit aucune image`)
    const png = image.toPNG()

    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, png)

    const size = image.getSize()
    return {
      path: target,
      relativePath: toRelative(options.workspace, target),
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      width: size.width,
      height: size.height,
      bytes: png.byteLength,
      url: options.url,
      capturedAt: Date.now(),
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** Reads a previously written capture so the UI can show it without re-rendering. */
export async function readCapture(workspace: string, relativePath?: string): Promise<PreviewCapture | null> {
  const relative = relativePath && relativePath.trim().length > 0
    ? relativePath.trim()
    : `${CAPTURE_DIRECTORY}/${CAPTURE_FILENAME}`

  let target: string
  try {
    target = await resolveInWorkspace(workspace, relative)
  } catch {
    return null
  }

  try {
    const png = await fs.readFile(target)
    const stats = await fs.stat(target)
    return {
      path: target,
      relativePath: toRelative(workspace, target),
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      // Dimensions are not stored on disk; the renderer scales the image to fit.
      width: 0,
      height: 0,
      bytes: png.byteLength,
      url: '',
      capturedAt: stats.mtimeMs,
    }
  } catch {
    return null
  }
}
