// ─── Pool de clés API Top-Tools-AI ─────────────────────
//
// Les clés maîtres ne vivent QUE dans le processus main :
//   - variables d'environnement en développement
//     (TOP_TOOLS_AI_API_KEYS, séparées par virgules ou points-virgules) ;
//   - jamais dans le code, le bundle renderer, app.asar côté UI,
//     package.json ou Git ;
//   - jamais envoyées au renderer, qui ne voit que Plan / Usage / Remaining /
//     Reset via le QuotaService.
//
// Rotation round-robin avec mise au repos temporaire des clés en échec
// (401/402/429) : la requête suivante part sur une autre clé.

const COOLDOWN_MS = 60_000

export interface PoolKey {
  value: string
  failedAt: number | null
}

export class ApiKeyPool {
  private keys: PoolKey[] = []
  private cursor = 0

  constructor(sources: Array<() => string | null | undefined>) {
    const seen = new Set<string>()
    for (const source of sources) {
      let raw: string | null | undefined
      try {
        raw = source()
      } catch {
        continue
      }
      if (typeof raw !== 'string') continue
      for (const piece of raw.split(/[,;]/)) {
        const value = piece.trim()
        if (value.length === 0 || seen.has(value)) continue
        seen.add(value)
        this.keys.push({ value, failedAt: null })
      }
    }
  }

  get size(): number {
    return this.keys.length
  }

  /** Clés actuellement utilisables (hors cooldown). */
  private available(): PoolKey[] {
    const now = Date.now()
    return this.keys.filter(key => key.failedAt === null || now - key.failedAt >= COOLDOWN_MS)
  }

  /** Prochaine clé en rotation, ou null si aucune n'est disponible. */
  next(): string | null {
    const candidates = this.available()
    if (candidates.length === 0) return this.keys[0]?.value ?? null

    const current = candidates[this.cursor % candidates.length]
    this.cursor = (this.cursor + 1) % candidates.length
    return current.value
  }

  /** Signale un échec d'authentification/quotid pour mettre la clé au repos. */
  reportFailure(key: string): void {
    const entry = this.keys.find(candidate => candidate.value === key)
    if (entry) entry.failedAt = Date.now()
  }

  /** Réinitialise l'état d'une clé après un succès. */
  reportSuccess(key: string): void {
    const entry = this.keys.find(candidate => candidate.value === key)
    if (entry) entry.failedAt = null
  }
}
