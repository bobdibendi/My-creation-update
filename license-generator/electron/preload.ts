import { contextBridge, ipcRenderer } from 'electron'

export type MembershipPlan = 'free' | 'pro' | 'pro_ultimate'
export type DurationType = 'lifetime' | 'subscription'

export interface GenerateParams {
  email: string
  /** Niveau d'adhésion MY CREATION (claim `plan` du JWT). */
  plan: MembershipPlan
  /** 'lifetime' = pas d'exp ; 'subscription' = exp obligatoire. */
  durationType: DurationType
  /** Durée en secondes lorsque durationType='subscription'. */
  durationSeconds?: number
  version?: string | null
}

export interface GenerateResult {
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

export interface KeyStatus {
  found: boolean
  path: string | null
}

export interface PrivateKeyStatus {
  found: boolean
  path: string | null
  stored: boolean
  storedPathMissing: boolean
}

const api = {
  generateLicense: (params: GenerateParams): Promise<GenerateResult> => ipcRenderer.invoke('license:generate', params),
  getKeyStatus: (): Promise<KeyStatus> => ipcRenderer.invoke('license:key-status'),
  saveLicense: (defaultName: string, content: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('license:save', { defaultName, content }),
  choosePrivateKey: () => ipcRenderer.invoke('license:choose-private-key') as Promise<{ ok: boolean; path?: string; error?: string }>,
  getPrivateKeyStatus: (): Promise<PrivateKeyStatus> => ipcRenderer.invoke('license:get-private-key-status'),
}

contextBridge.exposeInMainWorld('licenseApi', api)
