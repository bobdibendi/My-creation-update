// ─── Mises à jour automatiques via GitHub Releases ─────────────────────
//
// electron-updater + provider GitHub (owner/repo dans package.json > build >
// publish). Aucun serveur personnel : les artefacts (Setup .exe, latest.yml,
// .blockmap) sont publiés sur GitHub Releases avec un GH_TOKEN côté
// développeur uniquement ; l'application ne fait que CONSULTER le repo public.
//
// Flux utilisateur :
//   disponible  -> « Nouvelle version disponible » [Mettre à jour] [Plus tard]
//   téléchargement -> « Téléchargement XX % »
//   prête       -> « Mise à jour prête » [Redémarrer maintenant]
//
// Sécurité : autoDownload=false (l'utilisateur choisit), pas d'installation
// silencieuse, et tout le module est inerte si l'app n'est pas packagée.

import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateEvent {
  state: UpdateState
  /** Version proposée quand state = available/downloaded. */
  version?: string
  /** Progression 0-100 quand state = downloading. */
  percent?: number
  message?: string
}

type Broadcast = (channel: string, payload: unknown) => void

let broadcastRef: Broadcast | null = null
let latest: UpdateEvent = { state: 'idle' }

function emit(event: UpdateEvent): void {
  latest = event
  broadcastRef?.('update:event', event)
}

/** Vrai lorsque le mécanisme de mise à jour est utilisable (app packagée). */
export function updatesSupported(): boolean {
  return app.isPackaged
}

/**
 * Branche autoUpdater + IPC. À appeler après whenReady().
 * En développement (app non packagée) aucun écouteur réseau n'est armé :
 * les handlers répondent supported:false au renderer.
 */
export function setupUpdater(broadcast: Broadcast): void {
  broadcastRef = broadcast

  if (!updatesSupported()) {
    console.info('[updater] désactivé en développement (app non packagée)')
    return
  }

  // Le renderer décide du moment de la vérification (réglage « Vérifier au
  // démarrage ») ; le main ne vérifie jamais seul au boot.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  // Journal concis côté main ; aucun contenu tiers n'est exécuté.
  autoUpdater.logger = {
    info: (message: unknown) => console.info(`[updater] ${String(message)}`),
    warn: (message: unknown) => console.warn(`[updater] ${String(message)}`),
    error: (message: unknown) => console.error(`[updater] ${String(message)}`),
    debug: () => { /* silencieux */ },
  }

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }))
  autoUpdater.on('update-available', info => emit({
    state: 'available',
    version: typeof info?.version === 'string' ? info.version : undefined,
  }))
  autoUpdater.on('update-not-available', () => emit({ state: 'not-available' }))
  autoUpdater.on('download-progress', progress => emit({
    state: 'downloading',
    percent: Number.isFinite(progress?.percent) ? Math.round(progress.percent) : undefined,
  }))
  autoUpdater.on('update-downloaded', info => emit({
    state: 'downloaded',
    version: typeof info?.version === 'string' ? info.version : undefined,
  }))
  autoUpdater.on('error', error => emit({ state: 'error', message: error?.message }))

  ipcMain.handle('update:supported', () => updatesSupported())
  ipcMain.handle('update:get-state', () => latest)
  ipcMain.handle('update:check', async () => {
    if (!updatesSupported()) return { supported: false }
    await autoUpdater.checkForUpdates()
    return { supported: true }
  })
  ipcMain.handle('update:download', async () => {
    if (!updatesSupported()) return { supported: false }
    await autoUpdater.downloadUpdate()
    return { supported: true }
  })
  ipcMain.handle('update:install', () => {
    if (!updatesSupported()) return { supported: false }
    // isInstalledGoVersion false, forceRunAfter true : ferme puis relance l'app.
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return { supported: true }
  })
}
