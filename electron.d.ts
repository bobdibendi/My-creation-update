import type { ElectronAPI } from './src/shared/types'

export {}

declare global {
  interface Window {
    /** Injected by electron/preload.ts. Undefined when the renderer runs in a plain browser. */
    electronAPI?: ElectronAPI
  }
}
