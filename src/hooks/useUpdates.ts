import { useCallback, useEffect, useRef, useState } from 'react'
import type { UpdateEventPayload } from '../shared/types'

export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'downloaded'

export interface UseUpdatesState {
  /** Vrai uniquement pour une app packagée ; en dev tout est inerte. */
  supported: boolean
  phase: UpdatePhase
  version: string | null
  percent: number | null
  error: string | null
  check(): Promise<void>
  download(): Promise<void>
  install(): void
}

/**
 * Mises à jour (GitHub Releases) : machine à états poussée par le main.
 * La vérification automatique est déclenchée par l'app au démarrage lorsque
 * le réglage « Vérifier au démarrage » est actif ; le téléchargement et
 * l'installation ne partent jamais sans action explicite de l'utilisateur.
 */
export function useUpdates(options: { autoCheck: boolean }): UseUpdatesState {
  const [supported, setSupported] = useState(false)
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoCheckDone = useRef(false)

  // Abonnement aux événements du main (toujours actif : une vérification
  // lancée ailleurs — menu À propos — doit mettre à jour la modale).
  useEffect(() => {
    const bridge = window.electronAPI
    if (!bridge) return

    let disposed = false

    void bridge.updates.supported().then(value => {
      if (!disposed) setSupported(Boolean(value))
    }).catch(() => undefined)

    const dispose = bridge.updates.onEvent(event => {
      const payload = event as UpdateEventPayload
      switch (payload.state) {
        case 'available':
          setVersion(payload.version ?? null)
          setPhase('available')
          setError(null)
          break
        case 'downloading':
          setPhase('downloading')
          setPercent(typeof payload.percent === 'number' ? payload.percent : null)
          break
        case 'downloaded':
          setVersion(payload.version ?? version)
          setPercent(100)
          setPhase('downloaded')
          break
        case 'not-available':
          setPhase('idle')
          break
        case 'error':
          setError(payload.message ?? 'Erreur de mise à jour')
          setPhase(current => (current === 'downloaded' ? current : 'idle'))
          break
        default:
          break
      }
    })

    return () => {
      disposed = true
      dispose()
    }
  }, [])

  // Vérification unique au boot, hors dev, si le réglage l'autorise.
  useEffect(() => {
    if (!supported || !options.autoCheck || autoCheckDone.current) return
    autoCheckDone.current = true
    void window.electronAPI?.updates.check().catch(() => undefined)
  }, [supported, options.autoCheck])

  const check = useCallback(async (): Promise<void> => {
    await window.electronAPI?.updates.check().catch(() => undefined)
  }, [])

  const download = useCallback(async (): Promise<void> => {
    await window.electronAPI?.updates.download().catch(() => undefined)
  }, [])

  const install = useCallback((): void => {
    void window.electronAPI?.updates.install().catch(() => undefined)
  }, [])

  return { supported, phase, version, percent, error, check, download, install }
}
