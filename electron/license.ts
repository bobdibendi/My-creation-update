import jwt from 'jsonwebtoken'
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { getDatabase, type License } from './database.js'
import {
  computePeriodEndsAt, resolveSubscriptionState,
  type GumroadPlan, type SubscriptionProvider, type SubscriptionStatus,
} from './gumroad.js'

// Compiled to CommonJS by tsc, so __dirname is available.
const PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY_PATH
  ? path.resolve(process.env.LICENSE_PUBLIC_KEY_PATH)
  : path.join(__dirname, 'keys', 'public.pem')

/**
 * Fenêtre de revalidation d'une licence Gumroad (12 h par défaut,
 * GUMROAD_REVALIDATE_MS pour surcharger). Entre deux revalidations la
 * dernière validation locale fait foi : une coupure internet ne dégrade
 * JAMAIS brutalement l'utilisateur en FREE.
 */
const GUMROAD_REVALIDATE_MS = Number.parseInt(process.env.GUMROAD_REVALIDATE_MS ?? '', 10) > 0
  ? Number.parseInt(process.env.GUMROAD_REVALIDATE_MS ?? '', 10)
  : 12 * 60 * 60 * 1000

/**
 * Tolérance de renouvellement : un abonnement ACTIF (non annulé) n'expire
 * localement que periodEndsAt + cette marge, le temps que Gumroad confirme
 * le paiement suivant ou que le réseau revienne. Surchargeable via
 * MC_SUB_RENEWAL_GRACE_HOURS.
 */
const RENEWAL_GRACE_MS = (() => {
  const hours = Number.parseInt(process.env.MC_SUB_RENEWAL_GRACE_HOURS ?? '', 10)
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
})()

/**
 * Plan revendiqué par les données Gumroad historiques, quand aucun Product ID
 * n'est mappé chez le fournisseur. Jamais utilisé lorsque le provider résout
 * déjà le plan depuis l'identifiant produit réel.
 */
function resolveLegacyPlanClaim(data: GumroadLicenseData): GumroadPlan | null {
  return data.plan ?? null
}

/** Données stockées dans licenseData pour une licence issue de Gumroad. */
export interface GumroadLicenseData {
  source: 'gumroad'
  plan: 'pro' | 'pro_ultimate'
  productId: string
  saleId: string | null
  email: string | null
  /** Dernière validation réussie auprès de l'API Gumroad. */
  validatedAt: number
  refunded: boolean
  /** ── Abonnement (v2) — absent pour les licences lifetime one-time ── */
  /** Identifiant d'abonnement Gumroad (clé constante aux renouvellements). */
  subscriptionId?: string | null
  /** Dernier paiement vu chez Gumroad (avance à chaque renouvellement). */
  saleTimestamp?: number | null
  cancelledAt?: number | null
  failedAt?: number | null
  endedAt?: number | null
  /** Fin de période payée = saleTimestamp + cadence du produit. */
  periodEndsAt?: number | null
  cadence?: 'monthly' | 'yearly'
}

export interface LicensePayload {
  iss: string // issuer
  sub: string // subject (userId)
  licenseId: string
  /** DURÉE : 'lifetime' | 'subscription' (| 'pro_ultimate' historique). */
  type: 'lifetime' | 'subscription' | 'pro_ultimate'
  /** NIVEAU D'ADHÉSION : free / pro / pro_ultimate (claim du License Generator). */
  plan?: 'free' | 'pro' | 'pro_ultimate'
  product: string
  version: string | null
  iat: number // issued at
  exp?: number // expiration
}

export interface VerifyResult {
  valid: boolean
  error?: string
  payload?: LicensePayload
}

export interface ActivateResult {
  success: boolean
  error?: string
  license?: License
}

export interface LicenseStatus {
  active: boolean
  type: string | null
  expiresAt: number | null
  /** Source de la licence active : interne ou Gumroad. */
  source?: 'my-creation' | 'gumroad' | null
  /** Plan d'adhésion porté par la licence (si déterminable). */
  plan?: 'free' | 'pro' | 'pro_ultimate' | null
  /** Détail d'abonnement Gumroad (statut normalisé + fin de période). */
  subscription?: {
    status: SubscriptionStatus
    periodEndsAt: number | null
  } | null
  error?: string
}

/**
 * LicenseService handles license verification, activation, and management.
 * Uses RSA public key to verify JWT signatures without needing the private key.
 */
export class LicenseService {
  private db: Database.Database
  private publicKey: string
  /** Notifie le main process qu'un changement de plan a pu survenir (revalidation Gumroad). */
  private notifyPlanChange: (() => void) | null = null
  /** Revalidations Gumroad déjà planifiées (une seule à la fois par ligne). */
  private pendingRevalidations = new Set<number>()

  /**
   * @param db Handle SQLite optionnel (injection pour les tests, même
   *        convention que QuotaService) ; par défaut la base applicative.
   */
  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase()
    try {
      this.publicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8')
    } catch {
      throw new Error('Failed to load RSA public key for license verification')
    }
  }

  /** Branche la notification de changement de plan (broadcast plan:update). */
  setPlanChangeNotifier(notify: (() => void) | null): void {
    this.notifyPlanChange = notify
  }
  /**
   * Verify a license key signature and decode its payload.
   * This works offline - no server needed.
   */
  verifyLicenseKey(licenseKey: string): VerifyResult {
    // Diagnostic verbeux uniquement si MC_LICENSE_DIAG=1 (jamais en production).
    const diag = process.env.MC_LICENSE_DIAG === '1'
    try {
      if (diag) {
        const pubKeySha256 = createHash('sha256').update(this.publicKey).digest('hex')
        console.log('[LICENSE-DIAG] PUBLIC_KEY_SHA256:', pubKeySha256)
      }
      const payload = jwt.verify(licenseKey, this.publicKey, {
        algorithms: ['RS256'],
        issuer: 'cursor-clone',
      }) as LicensePayload
      if (diag) console.log('[LICENSE-DIAG] JWT_VERIFY: PASS')

      // Validate required fields
      if (!payload.licenseId || !payload.type || !payload.product) {
        return { valid: false, error: 'Données de licence invalides' }
      }

      // Validate product. 'my-creation' est accepté pour la compatibilité
      // avec les licences futures ; les licences existantes émettent
      // 'cursor-clone' et restent valides.
      if (payload.product !== 'cursor-clone' && payload.product !== 'my-creation') {
        return { valid: false, error: 'Cette licence est destinée à un autre produit' }
      }

      // Check expiration
      if (payload.exp && payload.exp * 1000 < Date.now()) {
        return { valid: false, error: 'Licence expirée' }
      }

      return { valid: true, payload }
    } catch (err) {
      if (diag) {
        console.log('[LICENSE-DIAG] JWT_VERIFY: FAIL')
        console.log('[LICENSE-DIAG] EXACT_ERROR:', err instanceof Error ? err.constructor.name + ' | ' + err.message : String(err))
      }
      // TokenExpiredError étend JsonWebTokenError : tester l'expiration
      // D'ABORD pour afficher le message exact à l'utilisateur.
      if (err instanceof jwt.TokenExpiredError) {
        return { valid: false, error: 'Licence expirée' }
      }
      if (err instanceof jwt.JsonWebTokenError) {
        return { valid: false, error: 'Clé de licence invalide' }
      }
      return { valid: false, error: 'Erreur lors de la vérification de la licence' }
    }
  }

  /**
   * Activate a license for a user.
   */
  activateLicense(userId: number, licenseKey: string): ActivateResult {
    // First verify the license key is valid
    const verifyResult = this.verifyLicenseKey(licenseKey)
    if (!verifyResult.valid) {
      return { success: false, error: verifyResult.error }
    }

    const payload = verifyResult.payload!

    // Check if license already activated by another user
    const existing = this.db
      .prepare('SELECT userId FROM licenses WHERE licenseKey = ?')
      .get(licenseKey) as { userId: number } | undefined

    if (existing && existing.userId !== userId) {
      return { success: false, error: 'Cette licence a déjà été activée par un autre utilisateur' }
    }

    if (existing) {
      return { success: false, error: 'Cette licence est déjà activée sur votre compte' }
    }

    // Insert license
    try {
      const result = this.db
        .prepare(
          `INSERT INTO licenses (userId, licenseKey, type, product, version, activatedAt, expiresAt, licenseData)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          licenseKey,
          payload.type,
          payload.product,
          payload.version,
          Date.now(),
          payload.exp ? payload.exp * 1000 : null,
          JSON.stringify(payload),
        )

      const license: License = {
        id: result.lastInsertRowid as number,
        userId,
        licenseKey,
        type: payload.type,
        product: payload.product,
        version: payload.version,
        activatedAt: Date.now(),
        expiresAt: payload.exp ? payload.exp * 1000 : null,
        licenseData: JSON.stringify(payload),
      }

      return { success: true, license }
    } catch {
      return { success: false, error: 'Erreur lors de l\'activation de la licence' }
    }
  }

  /**
   * Active une licence GUMROAD après vérification auprès du fournisseur
   * d'abonnement. La clé validée est convertie en licence interne : même
   * table, même résolution de plan, source marquée dans licenseData.
   *
   * ABONNEMENTS : la license_key reste IDENTIQUE à chaque renouvellement
   * Gumroad (c'est le subscription_id qui relie les paiements) — aucun
   * nouvel enregistrement n'est créé, seule la ligne existante est
   * rafraîchie (saleTimestamp, dates d'abonnement, fin de période).
   */
  async activateGumroadLicense(userId: number, licenseKey: string, provider: SubscriptionProvider): Promise<ActivateResult> {
    const outcome = await provider.verifyLicenseKey(licenseKey)
    if (!outcome.ok) {
      return { success: false, error: outcome.error }
    }

    // Une clé Gumroad est unique : déjà activée par un autre compte -> refus.
    const existing = this.db
      .prepare('SELECT userId FROM licenses WHERE licenseKey = ?')
      .get(licenseKey) as { userId: number } | undefined
    if (existing && existing.userId !== userId) {
      return { success: false, error: 'Cette licence Gumroad a déjà été activée sur un autre compte' }
    }

    const cadence = provider.cadenceFor(outcome.productId)
    const data: GumroadLicenseData = {
      source: 'gumroad',
      plan: outcome.plan,
      productId: outcome.productId,
      saleId: outcome.saleId,
      email: outcome.email,
      validatedAt: Date.now(),
      refunded: false,
      saleTimestamp: outcome.saleTimestamp,
      subscriptionId: outcome.subscription?.id ?? null,
      cancelledAt: outcome.subscription?.cancelledAt ?? null,
      failedAt: outcome.subscription?.failedAt ?? null,
      endedAt: outcome.subscription?.endedAt ?? null,
      periodEndsAt: outcome.saleTimestamp !== null
        ? computePeriodEndsAt(outcome.saleTimestamp, cadence)
        : null,
      cadence,
    }

    try {
      if (existing) {
        // Même compte qui réactive (ou re-valide) sa clé : rafraîchissement.
        this.db
          .prepare('UPDATE licenses SET activatedAt = ?, licenseData = ? WHERE licenseKey = ?')
          .run(Date.now(), JSON.stringify(data), licenseKey)
        const row = this.db
          .prepare('SELECT id, activatedAt FROM licenses WHERE licenseKey = ?')
          .get(licenseKey) as { id: number; activatedAt: number }

        // Le plan peut avoir changé côté produit (upgrade PRO -> ULTIMATE) :
        // il est dérivé du Product ID réel, jamais du JSON stocké.
        this.syncPlanFromGumroadData(userId, data)
        return {
          success: true,
          license: {
            id: row.id,
            userId,
            licenseKey,
            type: 'lifetime',
            product: 'cursor-clone',
            version: null,
            activatedAt: row.activatedAt,
            expiresAt: null,
            licenseData: JSON.stringify(data),
          },
        }
      }

      const result = this.db
        .prepare(
          `INSERT INTO licenses (userId, licenseKey, type, product, version, activatedAt, expiresAt, licenseData)
           VALUES (?, ?, 'lifetime', 'cursor-clone', NULL, ?, NULL, ?)`,
        )
        .run(userId, licenseKey, Date.now(), JSON.stringify(data))

      this.syncPlanFromGumroadData(userId, data)
      return {
        success: true,
        license: {
          id: result.lastInsertRowid as number,
          userId,
          licenseKey,
          type: 'lifetime',
          product: 'cursor-clone',
          version: null,
          activatedAt: Date.now(),
          expiresAt: null,
          licenseData: JSON.stringify(data),
        },
      }
    } catch {
      return { success: false, error: 'Erreur lors de l\'enregistrement de la licence Gumroad' }
    }
  }

  /** Lit les données Gumroad d'une ligne si elle en provient. */
  private readGumroadData(license: License | { licenseData: string }): GumroadLicenseData | null {
    try {
      const parsed = JSON.parse(license.licenseData) as Partial<GumroadLicenseData> & Partial<LicensePayload>
      return parsed?.source === 'gumroad' && typeof parsed.plan === 'string'
        ? parsed as GumroadLicenseData
        : null
    } catch {
      return null
    }
  }

  /**
   * Get license status for a user.
   *
   * Source-aware :
   *   - licence interne  -> re-vérification JWT RS256 locale (hors-ligne OK) ;
   *   - licence Gumroad  -> statut résolu depuis le dernier état validé
   *     (dates déterministes) + revalidation API en arrière-plan au-delà de
   *     la fenêtre de confiance ; une coupure réseau laisse l'état précédent
   *     inchangé.
   */
  getLicenseStatus(userId: number): LicenseStatus {
    const license = this.db
      .prepare('SELECT * FROM licenses WHERE userId = ? ORDER BY id DESC LIMIT 1')
      .get(userId) as License | undefined

    if (!license) {
      return { active: false, type: null, expiresAt: null, source: null, plan: null, subscription: null }
    }

    const gumroadData = this.readGumroadData(license)
    if (gumroadData) {
      const resolved = this.getGumroadStatus(gumroadData, license.id)
      const latest = this.getUserLicenses(userId)[0]
      void latest
      // Le PLAN est dérivé du Product ID réel chez le fournisseur : une
      // modification locale du champ plan dans SQLite est ignorée.
      const plan = resolved.active
        ? (this.providerRef?.resolvePlan(gumroadData.productId)
          ?? resolveLegacyPlanClaim(gumroadData))
        : null
      return {
        active: resolved.active,
        type: 'lifetime',
        expiresAt: license.expiresAt,
        source: 'gumroad',
        plan,
        subscription: {
          status: resolved.status,
          periodEndsAt: gumroadData.periodEndsAt ?? null,
        },
        ...(resolved.error ? { error: resolved.error } : {}),
      }
    }

    // ── Licence interne : vérification JWT RS256 locale ──
    const verifyResult = this.verifyLicenseKey(license.licenseKey)
    if (!verifyResult.valid) {
      return {
        active: false,
        type: license.type,
        expiresAt: license.expiresAt,
        source: 'my-creation',
        plan: null,
        subscription: null,
        error: verifyResult.error,
      }
    }

    // Check expiration
    if (license.expiresAt && license.expiresAt < Date.now()) {
      return {
        active: false,
        type: license.type,
        expiresAt: license.expiresAt,
        source: 'my-creation',
        plan: null,
        subscription: null,
        error: 'Licence expirée',
      }
    }

    return {
      active: true,
      type: license.type,
      expiresAt: license.expiresAt,
      source: 'my-creation',
      plan: verifyResult.payload?.plan ?? (license.type === 'pro_ultimate' ? 'pro_ultimate' : undefined),
      subscription: null,
    }
  }

  /**
   * Statut d'une licence Gumroad : dates locales déterministes d'abord
   * (fonction pure partagée avec les tests), puis revalidation différée si
   * la fenêtre de confiance est dépassée. JAMAIS bloquant.
   */
  private getGumroadStatus(
    data: GumroadLicenseData,
    licenseId: number,
  ): { status: SubscriptionStatus; active: boolean; error?: string } {
    const resolved = resolveSubscriptionState(
      {
        refunded: data.refunded,
        disabled: data.refunded && data.endedAt !== null ? data.refunded : undefined,
        chargebacked: undefined,
        disputed: undefined,
        subscriptionId: data.subscriptionId ?? null,
        cancelledAt: data.cancelledAt ?? null,
        failedAt: data.failedAt ?? null,
        endedAt: data.endedAt ?? null,
        saleTimestamp: data.saleTimestamp ?? null,
        periodEndsAt: data.periodEndsAt ?? null,
        validatedAt: data.validatedAt,
      },
      { nowMs: Date.now(), renewalGraceMs: RENEWAL_GRACE_MS },
    )

    const base = {
      status: resolved.status,
      active: resolved.active,
      ...(resolved.status === 'REFUNDED' && data.refunded
        ? { error: 'Cette licence Gumroad a été remboursée ou désactivée.' }
        : {}),
    }

    if (Date.now() - data.validatedAt > GUMROAD_REVALIDATE_MS && licenseId !== null) {
      this.scheduleGumroadRevalidation(licenseId)
    }
    return base
  }

  /**
   * Revalidation Gumroad en arrière-plan (jamais bloquante) :
   * remboursement / fin d'abonnement détectés -> licence inactive localement
   * + plan recalculé ; renouvellement détecté -> période prolongée ;
   * échec réseau -> aucun changement (règle hors-ligne).
   */
  scheduleGumroadRevalidation(licenseId: number): void {
    if (this.pendingRevalidations.has(licenseId)) return
    this.pendingRevalidations.add(licenseId)

    void this.revalidateNow(licenseId)
      .catch(() => { /* jamais fatal */ })
      .finally(() => this.pendingRevalidations.delete(licenseId))
  }

  /** Revalidation immédiate d'une ligne (utilisée aussi par le mode test). */
  async revalidateNow(licenseId: number): Promise<void> {
    const row = this.db
      .prepare('SELECT * FROM licenses WHERE id = ?')
      .get(licenseId) as License | undefined
    if (!row || !this.providerRef) return
    const data = this.readGumroadData(row)
    if (!data) return

    const outcome = await this.providerRef.verifyLicenseKey(row.licenseKey)
    let next: GumroadLicenseData

    if (outcome.ok) {
      const cadence = this.providerRef.cadenceFor(outcome.productId)
      next = {
        ...data,
        plan: outcome.plan,
        productId: outcome.productId,
        saleId: outcome.saleId,
        email: outcome.email ?? data.email,
        validatedAt: Date.now(),
        refunded: false,
        saleTimestamp: outcome.saleTimestamp,
        subscriptionId: outcome.subscription?.id ?? null,
        cancelledAt: outcome.subscription?.cancelledAt ?? null,
        failedAt: outcome.subscription?.failedAt ?? null,
        endedAt: outcome.subscription?.endedAt ?? null,
        periodEndsAt: outcome.saleTimestamp !== null
          ? computePeriodEndsAt(outcome.saleTimestamp, cadence)
          : data.periodEndsAt ?? null,
        cadence,
      }
    } else if (outcome.kind === 'refunded' || outcome.kind === 'invalid') {
      // Remboursé / clé révoquée / abonnement terminé confirmé par l'API :
      // désactivation locale réelle.
      next = { ...data, validatedAt: Date.now(), refunded: true, endedAt: data.endedAt ?? Date.now() }
    } else {
      // network / unconfigured : on garde l'état local (règle hors-ligne).
      return
    }

    if (JSON.stringify(next) !== JSON.stringify(data)) {
      this.db.prepare('UPDATE licenses SET licenseData = ? WHERE id = ?').run(JSON.stringify(next), licenseId)
      this.requestPlanSync?.(row.userId)
      this.notifyPlanChange?.()
    }
  }

  /** Service fournisseur injecté par main.ts (Gumroad réel ou test local). */
  private providerRef: SubscriptionProvider | null = null
  setSubscriptionProvider(provider: SubscriptionProvider | null): void {
    this.providerRef = provider
  }

  /** Compatibilité historique du nom. */
  setGumroadService(provider: SubscriptionProvider | null): void {
    this.setSubscriptionProvider(provider)
  }

  /**
   * Callback demandant au main process de resynchroniser le plan effectif
   * d'un compte après un changement d'état d'abonnement.
   */
  private requestPlanSync: ((userId: number) => void) | null = null
  setPlanRequestNotifier(notify: ((userId: number) => void) | null): void {
    this.requestPlanSync = notify
  }

  /** Synchronisation immédiate après activation (montée/descente de plan). */
  private syncPlanFromGumroadData(userId: number, data: GumroadLicenseData): void {
    void data
    this.requestPlanSync?.(userId)
  }

  /**
   * Get all licenses for a user.
   */
  getUserLicenses(userId: number): License[] {
    return this.db
      .prepare('SELECT * FROM licenses WHERE userId = ? ORDER BY activatedAt DESC')
      .all(userId) as License[]
  }

  /**
   * Deactivate a single local license (testing/admin).
   */
  deactivateLicense(licenseId: number, userId: number): boolean {
    const result = this.db
      .prepare('DELETE FROM licenses WHERE id = ? AND userId = ?')
      .run(licenseId, userId)

    return result.changes > 0
  }

  /**
   * Désactive TOUTES les licences locales du compte (bouton « Désactiver »).
   * N'affecte évidemment pas le License Generator ni Gumroad côté serveur :
   * seule la référence locale est supprimée.
   */
  deactivateAllForUser(userId: number): number {
    const result = this.db
      .prepare('DELETE FROM licenses WHERE userId = ?')
      .run(userId)
    return result.changes
  }
}
