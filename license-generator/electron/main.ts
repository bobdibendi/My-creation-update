import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import jwt from 'jsonwebtoken'
import crypto from 'node:crypto'

const DEV_SERVER_URL = 'http://localhost:5174'

const CONFIG_FILE = path.join(app.getPath('userData'), 'license-generator-config.json')

interface StoredConfig {
  privateKeyPath?: string
}

function readConfig(): StoredConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return JSON.parse(raw) as StoredConfig
  } catch {
    return {}
  }
}

function writeConfig(config: StoredConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

function isValidRsaPrivateKey(content: string): boolean {
  try {
    crypto.createPrivateKey({ key: content, format: 'pem' })
    return true
  } catch {
    return false
  }
}

function findPrivateKeyPath(): string | null {
  const config = readConfig()
  if (config.privateKeyPath && fs.existsSync(config.privateKeyPath)) {
    return config.privateKeyPath
  }
  const appRoot = path.resolve(__dirname, '..')
  const repoRoot = path.resolve(appRoot, '..')
  const candidates: string[] = []
  if (process.env.LICENSE_PRIVATE_KEY_PATH) {
    candidates.push(path.resolve(process.env.LICENSE_PRIVATE_KEY_PATH))
  }
  // Emplacement sécurisé post-rotation : hors du dépôt applicatif empaqueté.
  candidates.push(path.join(appRoot, 'secrets', 'private.pem'))
  candidates.push(path.join(repoRoot, 'license-generator', 'secrets', 'private.pem'))
  candidates.push(path.join(repoRoot, 'electron', 'keys', 'private.pem'))
  candidates.push(path.join(appRoot, 'keys', 'private.pem'))
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// GǸnǸration de licence : mǦme logique que scripts/generate-license.cjs
// ---------------------------------------------------------------------------
// Génération de licence : même logique que scripts/generate-license.cjs
// ---------------------------------------------------------------------------

export type MembershipPlan = 'free' | 'pro' | 'pro_ultimate'
export type DurationType = 'lifetime' | 'subscription'

export interface GenerateParams {
  email: string
  plan: MembershipPlan
  durationType: DurationType
  /** Durée réelle en secondes lorsque durationType='subscription'. */
  durationSeconds?: number
  version?: string | null
}

interface GenerateResult {
  ok: boolean
  error?: string
  token?: string
  info?: {
    email: string
    plan: MembershipPlan
    durationType: DurationType
    durationSeconds: number | null
    licenseId: string
    version: string | null
    issuedAt: number
    expiresAt: number | null
    privateKeyPath: string
  }
}

function buildLicensePayload(params: GenerateParams): { payload: Record<string, unknown>; expiresAt: number | null } {
  // PLAN et DURÉE sont deux axes indépendants :
  //   plan  -> claim `plan`   (free / pro / pro_ultimate)
  //   durée -> claim `type`   (lifetime sans exp / subscription avec exp)
  const payload: Record<string, unknown> = {
    iss: 'cursor-clone',
    sub: params.email.trim(),
    licenseId: `lic_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: params.durationType,
    product: 'cursor-clone',
    version: params.version?.trim() ? params.version.trim() : null,
  }
  if (params.plan !== 'free') payload.plan = params.plan

  let expiresAt: number | null = null
  if (params.durationType === 'subscription') {
    if (!params.durationSeconds || params.durationSeconds <= 0) {
      throw new Error('Durée de subscription invalide')
    }
    expiresAt = Math.floor(Date.now() / 1000) + Math.floor(params.durationSeconds)
    payload.exp = expiresAt
    payload.iat = Math.floor(Date.now() / 1000)
  }
  // lifetime : ni exp ni iat obligatoire.

  return { payload, expiresAt }
}

function handleGenerate(_event: unknown, rawParams: GenerateParams): GenerateResult {
  try {
    const email = String(rawParams?.email ?? '').trim()
    const plan = rawParams?.plan
    const durationType = rawParams?.durationType
    if (!email || !email.includes('@')) {
      return { ok: false, error: 'Email invalide' }
    }
    if (plan !== 'free' && plan !== 'pro' && plan !== 'pro_ultimate') {
      return { ok: false, error: 'Niveau d’adhésion invalide (free, pro ou pro_ultimate attendu)' }
    }
    if (durationType !== 'lifetime' && durationType !== 'subscription') {
      return { ok: false, error: 'Durée invalide (lifetime ou subscription attendu)' }
    }
    let durationSeconds: number | undefined
    if (durationType === 'subscription') {
      durationSeconds = Number(rawParams.durationSeconds)
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { ok: false, error: 'Durée de subscription invalide' }
      }
    }

    const privateKeyPath = findPrivateKeyPath()
    if (!privateKeyPath) {
      return {
        ok: false,
        error:
          'Clé privée introuvable. Placez private.pem dans electron/keys/ (dépôt My Creation) ou ' +
          'license-generator/keys/, ou définissez LICENSE_PRIVATE_KEY_PATH.',
      }
    }

    const normalized: GenerateParams = {
      email,
      plan,
      durationType,
      durationSeconds,
      version: rawParams.version ?? null,
    }

    const { payload, expiresAt } = buildLicensePayload(normalized)
    const issuedAt = Number(payload.iat ?? Math.floor(Date.now() / 1000))
    const token = jwt.sign(payload, fs.readFileSync(privateKeyPath, 'utf8'), { algorithm: 'RS256' })

    return {
      ok: true,
      token,
      info: {
        email: String(payload.sub),
        plan,
        durationType,
        durationSeconds: durationSeconds ?? null,
        licenseId: String(payload.licenseId),
        version: (payload.version as string | null) ?? null,
        issuedAt,
        expiresAt,
        privateKeyPath,
      },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function handleKeyStatus(): { found: boolean; path: string | null } {
  const privateKeyPath = findPrivateKeyPath()
  return { found: privateKeyPath !== null, path: privateKeyPath }
}

async function handleSaveToken(
  _event: unknown,
  args: { defaultName: string; content: string },
): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> {
  try {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showSaveDialog(win!, {
      title: 'Sauvegarder la licence',
      defaultPath: args.defaultName || 'licence.txt',
      filters: [{ name: 'Licence', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return { ok: true, canceled: true }
    fs.writeFileSync(result.filePath, args.content, 'utf-8')
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'My Creation License Generator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.argv.includes('--dev')) {
    void mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function handleChoosePrivateKey(): Promise<{ ok: boolean; path?: string; error?: string }> {
  try {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const result = await dialog.showOpenDialog(win!, {
      title: 'Sélectionner la clé privée (private.pem)',
      filters: [
        { name: 'Fichiers PEM', extensions: ['pem'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    if (result.canceled || !result.filePaths.length) return { ok: false }
    const selectedPath = result.filePaths[0]
    let content: string
    try {
      content = fs.readFileSync(selectedPath, 'utf8')
    } catch {
      return { ok: false, error: 'Impossible de lire le fichier sélectionné.' }
    }
    if (!isValidRsaPrivateKey(content)) {
      return { ok: false, error: 'Le fichier sélectionné n\'est pas une clé privée RSA valide au format PEM.' }
    }
    writeConfig({ privateKeyPath: selectedPath })
    return { ok: true, path: selectedPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function handleGetPrivateKeyStatus(): { found: boolean; path: string | null; stored: boolean; storedPathMissing: boolean } {
  const config = readConfig()
  const resolved = findPrivateKeyPath()
  const storedPathMissing = Boolean(config.privateKeyPath && !fs.existsSync(config.privateKeyPath))
  return {
    found: resolved !== null,
    path: resolved,
    stored: Boolean(config.privateKeyPath),
    storedPathMissing,
  }
}

ipcMain.handle('license:generate', handleGenerate)
ipcMain.handle('license:key-status', handleKeyStatus)
ipcMain.handle('license:save', handleSaveToken)
ipcMain.handle('license:choose-private-key', handleChoosePrivateKey)
ipcMain.handle('license:get-private-key-status', handleGetPrivateKeyStatus)

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
