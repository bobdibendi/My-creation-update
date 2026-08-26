import type Database from 'better-sqlite3'
import { getPlan, isPlanType, type PlanDefinition } from './plans.js'

// ─── Types publics ─────────────────────────────────────

export type UsageKind = 'chat' | 'agent' | 'other'

export interface UsageRecordInput {
  kind: UsageKind
  provider?: string
  model?: string
  inputTokens: number
  outputTokens: number
}

export interface KindUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

export interface QuotaPeriod {
  /** Début de la période courante (epoch ms, minuit UTC). */
  start: number
  /** Fin de la période courante (epoch ms). */
  end: number
  /** Libellé lisible, ex. « 2026-08-24 ». */
  key: string
}

export interface UsageSummary {
  plan: PlanDefinition
  period: QuotaPeriod
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  byKind: Record<UsageKind, KindUsage>
  dailyTokenLimit: number | null
  remainingTokens: number | null
  percentUsed: number | null
  nextResetAt: number
}

export interface QuotaCheck {
  allowed: boolean
  reason?: string
  summary: UsageSummary
}

export interface UsageEvent {
  summary: UsageSummary
  /** Seuils franchis par cet enregistrement (80 / 90 / 100). */
  crossedThresholds: number[]
}

export const THRESHOLDS = [80, 90, 100] as const

// ─── Service ───────────────────────────────────────────

/**
 * Comptabilisation et application du quota quotidien de jetons.
 *
 * Le compteur est rattaché à une période réelle (fenêtre [start, end[ en UTC),
 * pas à un simple remise à zéro sur l'horloge locale : une requête enregistrée
 * à 23:59:59 reste dans la période du jour, et le passage à une nouvelle
 * période ouvre un nouveau compteur sans toucher aux anciennes lignes.
 *
 * Le handle SQLite est injecté : le service tourne dans le processus main
 * Electron comme dans les tests Node purs.
 *
 * Sécurité : aucune méthode ne doit être exposée au renderer pour écrire le
 * compteur — seul `recordUsage`, appelé par les flux IA du main process,
 * modifie les données.
 */
export class QuotaService {
  private readonly db: Database.Database
  private readonly statements: {
    insert: Database.Statement
    sumPeriod: Database.Statement
    sumPeriodByKind: Database.Statement
    countPeriod: Database.Statement
    getPlan: Database.Statement
    setPlan: Database.Statement
    markAlert: Database.Statement
    hasAlert: Database.Statement
  }

  constructor(db: Database.Database) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        periodStart INTEGER NOT NULL,
        periodEnd INTEGER NOT NULL,
        periodKey TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        inputTokens INTEGER NOT NULL DEFAULT 0,
        outputTokens INTEGER NOT NULL DEFAULT 0,
        totalTokens INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_user_period ON token_usage(userId, periodStart);
      CREATE TABLE IF NOT EXISTS user_plans (
        userId INTEGER PRIMARY KEY,
        planId TEXT NOT NULL DEFAULT 'free',
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_alerts (
        userId INTEGER NOT NULL,
        periodKey TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        PRIMARY KEY (userId, periodKey, threshold)
      );
    `)

    this.statements = {
      insert: this.db.prepare(`
        INSERT INTO token_usage
          (userId, periodStart, periodEnd, periodKey, kind, provider, model, inputTokens, outputTokens, totalTokens, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      sumPeriod: this.db.prepare(`
        SELECT COALESCE(SUM(inputTokens), 0) AS input, COALESCE(SUM(outputTokens), 0) AS output,
               COUNT(*) AS requests
        FROM token_usage WHERE userId = ? AND periodStart = ?
      `),
      sumPeriodByKind: this.db.prepare(`
        SELECT kind, COALESCE(SUM(inputTokens), 0) AS input, COALESCE(SUM(outputTokens), 0) AS output,
               COUNT(*) AS requests
        FROM token_usage WHERE userId = ? AND periodStart = ? GROUP BY kind
      `),
      countPeriod: this.db.prepare(
        'SELECT COUNT(*) AS n FROM token_usage WHERE userId = ? AND periodStart = ?',
      ),
      getPlan: this.db.prepare('SELECT planId FROM user_plans WHERE userId = ?'),
      setPlan: this.db.prepare(`
        INSERT INTO user_plans (userId, planId, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(userId) DO UPDATE SET planId = excluded.planId, updatedAt = excluded.updatedAt
      `),
      markAlert: this.db.prepare(
        'INSERT OR IGNORE INTO quota_alerts (userId, periodKey, threshold) VALUES (?, ?, ?)',
      ),
      hasAlert: this.db.prepare(
        'SELECT 1 FROM quota_alerts WHERE userId = ? AND periodKey = ? AND threshold = ?',
      ),
    }
  }

  // ─── Périodes ────────────────────────────────────────

  /** Fenêtre de la journée UTC contenant `at`. */
  periodFor(at: number = Date.now()): QuotaPeriod {
    const date = new Date(at)
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    const end = start + 24 * 60 * 60 * 1000
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
    return { start, end, key }
  }

  // ─── Plan ────────────────────────────────────────────

  /**
   * Plan actif d'un utilisateur.
   * Un plan inconnu retombe sur FREE ; une licence PRO ULTIMATE expire via la
   * couche licence (syncPlanFromLicense côté main), qui revalide l'assignation.
   */
  getPlan(userId: number): PlanDefinition {
    const row = this.statements.getPlan.get(userId) as { planId: string } | undefined
    if (!row || !isPlanType(row.planId)) return getPlan('free')
    return getPlan(row.planId)
  }

  /**
   * Assigne un plan. Réservé au backend/administration (scripts, tests) :
   * jamais appelable depuis le renderer.
   */
  assignPlan(userId: number, planId: string): void {
    if (!isPlanType(planId)) throw new Error(`Plan inconnu: ${planId}`)
    this.statements.setPlan.run(userId, planId, Date.now())
  }

  // ─── Usage ───────────────────────────────────────────

  getUsage(userId: number, at: number = Date.now()): UsageSummary {
    const period = this.periodFor(at)
    const plan = this.getPlan(userId)

    const sums = this.statements.sumPeriod.get(userId, period.start) as {
      input: number
      output: number
      requests: number
    }
    const byKindRows = this.statements.sumPeriodByKind.all(userId, period.start) as Array<{
      kind: string
      input: number
      output: number
      requests: number
    }>

    const byKind: Record<UsageKind, KindUsage> = {
      chat: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      agent: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      other: { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    }
    for (const row of byKindRows) {
      const kind: UsageKind = row.kind === 'chat' || row.kind === 'agent' ? row.kind : 'other'
      byKind[kind] = {
        inputTokens: row.input,
        outputTokens: row.output,
        totalTokens: row.input + row.output,
        requests: row.requests,
      }
    }

    const inputTokens = Number(sums?.input ?? 0)
    const outputTokens = Number(sums?.output ?? 0)
    const totalTokens = inputTokens + outputTokens
    const requests = Number(sums?.requests ?? 0)

    const remainingTokens = plan.dailyTokenLimit === null ? null : Math.max(0, plan.dailyTokenLimit - totalTokens)
    const percentUsed = plan.dailyTokenLimit === null
      ? null
      : plan.dailyTokenLimit > 0
        ? Math.min(100, (totalTokens / plan.dailyTokenLimit) * 100)
        : 100

    return {
      plan,
      period,
      inputTokens,
      outputTokens,
      totalTokens,
      requests,
      byKind,
      dailyTokenLimit: plan.dailyTokenLimit,
      remainingTokens,
      percentUsed,
      nextResetAt: period.end,
    }
  }

  getRemaining(userId: number): number | null {
    return this.getUsage(userId).remainingTokens
  }

  /**
   * Enregistre une consommation réelle et retourne les seuils franchis.
   * Les seuils sont mémorisés par période : quitter puis rouvrir
   * l'application ne rejoue pas les alertes déjà émises.
   */
  recordUsage(userId: number, record: UsageRecordInput): UsageEvent {
    const period = this.periodFor()
    const before = this.usagePercentBefore(userId, period)

    const inputTokens = Math.max(0, Math.round(record.inputTokens))
    const outputTokens = Math.max(0, Math.round(record.outputTokens))
    this.statements.insert.run(
      userId,
      period.start,
      period.end,
      period.key,
      record.kind,
      record.provider ?? null,
      record.model ?? null,
      inputTokens,
      outputTokens,
      inputTokens + outputTokens,
      Date.now(),
    )

    const summary = this.getUsage(userId)
    const after = summary.percentUsed ?? 0

    const crossed: number[] = []
    for (const threshold of THRESHOLDS) {
      const alreadyNotified = Boolean(this.statements.hasAlert.get(userId, period.key, threshold))
      if (!alreadyNotified && before < threshold && after >= threshold) {
        this.statements.markAlert.run(userId, period.key, threshold)
        crossed.push(threshold)
      }
    }

    return { summary, crossedThresholds: crossed }
  }

  private usagePercentBefore(userId: number, period: QuotaPeriod): number {
    const plan = this.getPlan(userId)
    if (plan.dailyTokenLimit === null || plan.dailyTokenLimit <= 0) return 0
    const sums = this.statements.sumPeriod.get(userId, period.start) as { input: number; output: number }
    const total = Number(sums?.input ?? 0) + Number(sums?.output ?? 0)
    return Math.min(100, (total / plan.dailyTokenLimit) * 100)
  }

  // ─── Contrôle ────────────────────────────────────────

  /** Vrai tant que la requête estimée tient dans le quota restant. */
  checkQuota(userId: number, estimatedTokens: number = 0): QuotaCheck {
    const summary = this.getUsage(userId)
    if (summary.dailyTokenLimit === null) return { allowed: true, summary }

    const projected = summary.totalTokens + Math.max(0, Math.round(estimatedTokens))
    if (projected <= summary.dailyTokenLimit) return { allowed: true, summary }

    const resetLabel = new Date(summary.nextResetAt).toLocaleString('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    return {
      allowed: false,
      reason: `Quota quotidien atteint (${summary.plan.name}). Prochain reset : ${resetLabel}.`,
      summary,
    }
  }

  /** Estimation grossière (~4 caractères par token) quand l'API ne renvoie pas de usage. */
  static estimateTokens(text: string | null | undefined): number {
    if (!text) return 0
    return Math.ceil(text.length / 4)
  }
}
