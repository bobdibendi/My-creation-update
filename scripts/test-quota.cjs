#!/usr/bin/env node
/**
 * Test du QuotaService (electron/quota.ts compilé).
 *
 * Couverture :
 *   - plan FREE = 10M tokens/jour ;
 *   - comptabilisation input/output/total par type (chat/agent/autre) ;
 *   - checkQuota accepte puis refuse au dépassement avec message de reset ;
 *   - périodes réelles : la consommation d'hier ne compte pas aujourd'hui ;
 *   - seuils 80/90/100 franchis une seule fois chacun ;
 *   - changement de plan (assignation réservée au backend).
 *
 * Usage : node scripts/test-quota.cjs   (lance `npm run build:electron` avant)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')

const distDir = path.resolve(__dirname, '..', 'dist-electron')
if (!fs.existsSync(path.join(distDir, 'quota.js'))) {
  console.error('FATAL dist-electron/quota.js absent. Lance "npm run build".')
  process.exit(1)
}
const { QuotaService } = require(path.join(distDir, 'quota.js'))

let passCount = 0
let failCount = 0
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` (${detail})` : ''}`)
    passCount++
  } else {
    console.error(`FAIL  ${name}${detail ? ` (${detail})` : ''}`)
    failCount++
  }
}

// Base isolée en mémoire temporaire.
const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mycreation-quota-')), 'test.db')
const db = new Database(dbPath)
const quota = new QuotaService(db)

const DAY = 24 * 60 * 60 * 1000
const USER = 1

// ── 1. Plan FREE ──────────────────────────────────────────────────────────
{
  const usage = quota.getUsage(USER)
  check('plan par défaut = FREE', usage.plan.id === 'free')
  check('quota FREE = 10 000 000 tokens/jour', usage.dailyTokenLimit === 10_000_000, `${usage.dailyTokenLimit}`)
  check('usage initial = 0', usage.totalTokens === 0 && usage.requests === 0)
  check('restant initial = 10M', usage.remainingTokens === 10_000_000)
}

// ── 2. Comptabilisation réelle ────────────────────────────────────────────
quota.recordUsage(USER, { kind: 'chat', provider: 'tools', model: 'Top-Tools-Ai', inputTokens: 1_200_000, outputTokens: 800_000 })
quota.recordUsage(USER, { kind: 'agent', provider: 'tools', model: 'Top-Tools-Ai', inputTokens: 500_000, outputTokens: 80_000 })
{
  const usage = quota.getUsage(USER)
  check('total = input + output', usage.totalTokens === 2_580_000, `${usage.totalTokens}`)
  check('répartition Chat', usage.byKind.chat.totalTokens === 2_000_000)
  check('répartition Agent', usage.byKind.agent.totalTokens === 580_000)
  check('requêtes comptées', usage.requests === 2)
  check('pourcentage cohérent', Math.abs(usage.percentUsed - 25.8) < 0.01, `${usage.percentUsed}%`)
}

// ── 3. Refus au dépassement ───────────────────────────────────────────────
{
  // 9.9M utilisés -> une requête estimée à 200K doit être REFUSÉE.
  const db2path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mycreation-quota-')), 'test2.db')
  const db2 = new Database(db2path)
  const q2 = new QuotaService(db2)
  q2.recordUsage(7, { kind: 'chat', inputTokens: 9_900_000, outputTokens: 0 })
  const ok = q2.checkQuota(7, 50_000)
  check('9.9M + 50K -> autorisée', ok.allowed === true)
  const refused = q2.checkQuota(7, 200_000)
  check('9.9M + 200K -> refusée', refused.allowed === false)
  check('message de refus explicite', /Quota quotidien atteint/i.test(refused.reason ?? ''), refused.reason?.slice(0, 60))
  check('reset mentionné dans le refus', /reset/i.test(refused.reason ?? ''))
  db2.close()
}

// ── 4. Reset quotidien réel (fenêtre UTC) ─────────────────────────────────
{
  const yesterday = Date.now() - DAY
  const past = quota.periodFor(yesterday)
  const now = quota.periodFor()
  check('périodes distinctes hier/aujourd’hui', past.key !== now.key)
  check(
    'bornes de période = journée UTC',
    now.end - now.start === DAY,
    `${new Date(now.start).toISOString().slice(0, 10)} -> ${new Date(now.end).toISOString()}`,
  )
  check('prochain reset = fin de période', quota.getUsage(USER).nextResetAt === now.end)

  // Une consommation datée d'hier n'entre pas dans le compteur du jour :
  // insertion directe dans l'ancienne fenêtre.
  db.prepare(`
    INSERT INTO token_usage
      (userId, periodStart, periodEnd, periodKey, kind, provider, model, inputTokens, outputTokens, totalTokens, createdAt)
    VALUES (?, ?, ?, ?, 'chat', null, null, 999999, 0, 999999, ?)
  `).run(USER, past.start, past.end, past.key, yesterday)
  const after = quota.getUsage(USER)
  check('la consommation d’hier ne compte pas aujourd’hui', after.totalTokens === 2_580_000, `${after.totalTokens}`)
}

// ── 5. Seuils 80 / 90 / 100 ───────────────────────────────────────────────
{
  const db3path = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mycreation-quota-')), 'test3.db')
  const db3 = new Database(db3path)
  const q3 = new QuotaService(db3)
  let crossed = []
  crossed = q3.recordUsage(42, { kind: 'chat', inputTokens: 8_000_000, outputTokens: 0 }).crossedThresholds
  check('seuil 80% franchi', crossed.includes(80), JSON.stringify(crossed))
  crossed = q3.recordUsage(42, { kind: 'chat', inputTokens: 1_000_000, outputTokens: 0 }).crossedThresholds
  check('seuil 90% franchi', crossed.includes(90), JSON.stringify(crossed))
  crossed = q3.recordUsage(42, { kind: 'chat', inputTokens: 100_000, outputTokens: 0 }).crossedThresholds
  check('pas de re-notification entre les seuils', crossed.length === 0, JSON.stringify(crossed))
  crossed = q3.recordUsage(42, { kind: 'agent', inputTokens: 1_000_000, outputTokens: 0 }).crossedThresholds
  check('seuil 100% franchi', crossed.includes(100), JSON.stringify(crossed))
  crossed = q3.recordUsage(42, { kind: 'agent', inputTokens: 500_000, outputTokens: 0 }).crossedThresholds
  check('aucun seuil rejoué au-delà de 100%', crossed.length === 0, JSON.stringify(crossed))

  // Simulation d'un vrai reset : nouvelle période -> nouveaux seuils.
  const nowKey = q3.periodFor().key
  db3.prepare('DELETE FROM token_usage WHERE userId = 42').run()
  db3.prepare('DELETE FROM quota_alerts WHERE userId = 42 AND periodKey = ?').run(nowKey)
  crossed = q3.recordUsage(42, { kind: 'chat', inputTokens: 8_000_000, outputTokens: 0 }).crossedThresholds
  check('après reset le seuil 80% est à nouveau notifiable', crossed.includes(80), JSON.stringify(crossed))
  db3.close()
}

// ── 6. Plans configurables ────────────────────────────────────────────────
{
  quota.assignPlan(99, 'pro_ultimate')
  const ultimate = quota.getUsage(99)
  check('plan PRO ULTIMATE assignable côté backend', ultimate.plan.id === 'pro_ultimate')
  check(
    'PRO ULTIMATE reste configurable (null par défaut)',
    ultimate.plan.dailyTokenLimit === null,
    `${ultimate.plan.dailyTokenLimit}`,
  )
  check(
    'PRO ULTIMATE = permissions maximales',
    ultimate.plan.permissions.priorityAccess === true && ultimate.plan.permissions.advancedTools === true,
  )

  let threw = false
  try { quota.assignPlan(99, 'gold') } catch { threw = true }
  check('plan inconnu rejeté', threw)
}

db.close()

console.log('\n=========================================')
console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
console.log('=========================================')
process.exit(failCount === 0 ? 0 : 1)
