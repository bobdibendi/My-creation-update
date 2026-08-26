import { useCallback, useEffect, useState } from 'react'

const SETTINGS_KEY = 'cursor-clone.settings'

export interface AppSettings {
  /** Send the active editor buffer to the model along with the prompt. */
  sendFileContents: boolean
  /** Preferred assistant mode on a fresh conversation. */
  defaultMode: 'chat' | 'agent'
  /** Reopen the assistant panel automatically on launch. */
  autoOpenAgent: boolean
  /** Show the boot overlay. */
  showSplash: boolean
  /** Reveal the Aperçu tab as soon as the agent starts a server. */
  autoRevealPreview: boolean
  /** Install dependencies before starting a preview. */
  previewAutoInstall: boolean
  /** Refresh the analysis when the agent reports writes. */
  analysisAutoRefresh: boolean
  /** Name used by the greeting on the home screen. */
  userName: string
  /** Check for updates on launch. Purely a stored preference for now. */
  checkUpdates: boolean
  /** Sauvegarde automatique du fichier actif après une pause de frappe. */
  autosave: boolean
  /** Notifications : actions de l'assistant sur la Todo. */
  notifyAiChanges: boolean
}

const defaultSettings: AppSettings = {
  sendFileContents: true,
  defaultMode: 'agent',
  autoOpenAgent: false,
  showSplash: true,
  autoRevealPreview: true,
  previewAutoInstall: true,
  analysisAutoRefresh: true,
  userName: 'Antoine',
  checkUpdates: true,
  autosave: true,
  notifyAiChanges: true,
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaultSettings
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { ...defaultSettings, ...parsed }
  } catch {
    return defaultSettings
  }
}

export function useSettings() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(loadSettings)

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      // Storage disabled: preferences last for this session only.
    }
  }, [settings])

  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  /** Generic setter so the Settings page does not need one callback per field. */
  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(previous => ({ ...previous, [key]: value }))
  }, [])

  const resetSettings = useCallback(() => setSettings(defaultSettings), [])

  const setSendFileContents = useCallback((value: boolean) => {
    update('sendFileContents', value)
  }, [update])

  return {
    settingsOpen,
    openSettings,
    closeSettings,
    settings,
    update,
    resetSettings,
    sendFileContents: settings.sendFileContents,
    setSendFileContents,
  }
}
