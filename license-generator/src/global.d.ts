import type {
  GenerateParams,
  GenerateResult,
  KeyStatus,
  PrivateKeyStatus,
} from '../electron/preload'

declare global {
  interface Window {
    licenseApi: {
      generateLicense: (params: GenerateParams) => Promise<GenerateResult>
      getKeyStatus: () => Promise<KeyStatus>
      saveLicense: (
        defaultName: string,
        content: string,
      ) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      choosePrivateKey: () => Promise<{ ok: boolean; path?: string; error?: string }>
      getPrivateKeyStatus: () => Promise<PrivateKeyStatus>
    }
  }
}

export {}
