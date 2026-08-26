import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * API keys live in a single file inside Electron's userData directory.
 * They are encrypted with safeStorage when the OS keychain is available; a
 * plaintext file written by a previous version is migrated on first read.
 */
export class KeyStore {
  private readonly file: string

  constructor(directory = path.join(app.getPath('userData'), 'config')) {
    mkdirSync(directory, { recursive: true })
    this.file = path.join(directory, '.api-keys.enc')
  }

  load(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    const raw = readFileSync(this.file)

    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decoded = JSON.parse(safeStorage.decryptString(raw)) as Record<string, string>
        return this.sanitize(decoded)
      } catch {
        // Not encrypted yet: fall through to the legacy plaintext path.
      }
    }

    try {
      const decoded = JSON.parse(raw.toString('utf8')) as Record<string, string>
      const keys = this.sanitize(decoded)
      // Upgrade the legacy file in place so it is never read as plaintext again.
      if (Object.keys(keys).length > 0 && safeStorage.isEncryptionAvailable()) this.save(keys)
      return keys
    } catch {
      return {}
    }
  }

  save(keys: Record<string, string>): void {
    const payload = JSON.stringify(this.sanitize(keys))
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(payload)
      : Buffer.from(payload, 'utf8')

    // Write to a sibling file first so a crash cannot leave a truncated store.
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, data)
    renameSync(temporary, this.file)
  }

  get(provider: string): string | null {
    return this.load()[provider] ?? null
  }

  set(provider: string, key: string): void {
    const keys = this.load()
    keys[provider] = key.trim()
    this.save(keys)
  }

  remove(provider: string): void {
    const keys = this.load()
    delete keys[provider]
    this.save(keys)
  }

  private sanitize(input: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [provider, value] of Object.entries(input ?? {})) {
      if (typeof value === 'string' && value.trim().length > 0) out[provider] = value.trim()
    }
    return out
  }
}

export function maskKey(key: string): string {
  if (key.length <= 10) return `${key.slice(0, 2)}${'*'.repeat(Math.max(2, key.length - 4))}${key.slice(-2)}`
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}
