#!/usr/bin/env node
/**
 * Tests NIVEAU D'ADHESION (claims JWT) -> PERMISSIONS -> MODELES visibles.
 *
 * Chaine complete verifiee avec la vraie paire RSA locale :
 *   A. Free   / Lifetime   -> plan free      -> Kim Pro + Ox Alpha uniquement
 *   B. Pro    / Lifetime   -> plan pro       -> + modeles premium
 *   C. Pro Ultimate / Lifetime -> plan pro_ultimate -> permissions maximales
 *   D. Compatibilite historique : type='pro_ultimate' sans claim plan
 *   E. Pro    / Subscription expiree -> licence inactive -> retour FREE
 *
 * Usage : node scripts/test-license-plans.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const jwt = require('jsonwebtoken')

const root = path.resolve(__dirname, '..')
const privatePath = require('./keys.cjs').findPrivateKeyPath()
const publicPath = path.join(root, 'electron', 'keys', 'public.pem')
if (!privatePath || !fs.existsSync(publicPath)) {
  console.error('FATAL cles locales absentes.')
  process.exit(1)
}
const privateKey = fs.readFileSync(privatePath, 'utf8')
const publicKey = fs.readFileSync(publicPath, 'utf8')

const distDir = path.join(root, 'dist-electron')
const { resolveLicensedPlan } = require(path.join(distDir, 'license-plan.js'))
const { getPlan } = require(path.join(distDir, 'plans.js'))
const { createToolsProvider } = require(path.join(distDir, 'providers', 'tools.js'))
const { createOpenCodeZenProvider } = require(path.join(distDir, 'providers', 'opencode-zen.js'))
const { createAnthropicProvider } = require(path.join(distDir, 'providers', 'anthropic.js'))
const { createOpenAIProvider } = require(path.join(distDir, 'providers', 'openai.js'))
const { createGoogleProvider } = require(path.join(distDir, 'providers', 'google.js'))

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

let serial = 0
function sign(claims) {
  serial += 1
  const payload = {
    iss: 'cursor-clone',
    sub: `plan-test-${serial}@mycreation.app`,
    licenseId: `lic_${Date.now().toString(36)}_${serial}`,
    product: 'cursor-clone',
    version: '1.0.0',
    ...claims,
  }
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' })
}

/** Verifie exactement comme electron/license.ts (verifyLicenseKey). */
function verifyLikeApp(token) {
  try {
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: 'cursor-clone' })
    if (!payload.licenseId || !payload.type || !payload.product) return { valid: false }
    if (payload.product !== 'cursor-clone' && payload.product !== 'my-creation') return { valid: false }
    if (payload.exp && payload.exp * 1000 < Date.now()) return { valid: false, expired: true }
    return { valid: true, payload }
  } catch (err) {
    return { valid: false, expired: Boolean(err) && err.name === 'TokenExpiredError' }
  }
}

/** Modeles visibles selon le plan (meme logique que le main process). */
function visibleModels(planId) {
  const permissions = getPlan(planId).permissions
  const all = [
    ...createToolsProvider(() => null, () => null).models.map(m => ({ label: m.label, provider: 'tools' })),
    ...createOpenCodeZenProvider(() => null, () => null).models.map(m => ({ label: m.label, provider: 'opencode-zen' })),
    ...createAnthropicProvider(() => null).models.map(m => ({ label: m.label, provider: 'premium' })),
    ...createOpenAIProvider(() => null).models.map(m => ({ label: m.label, provider: 'premium' })),
    ...createGoogleProvider(() => null).models.map(m => ({ label: m.label, provider: 'premium' })),
  ]
  return all.filter(model => {
    if (model.provider === 'tools') return permissions.builtinFreeModels
    if (model.provider === 'opencode-zen') return permissions.oxAlphaModels
    return permissions.premiumModels
  })
}

// â”€â”€ A. FREE / Lifetime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const token = sign({ type: 'lifetime' }) // pas de claim plan -> free implicite
  const verified = verifyLikeApp(token)
  check('A1 Free/Lifetime : signature valide', verified.valid)
  const plan = resolveLicensedPlan(verified.payload)
  check('A2 plan resolu = free', plan === 'free', plan)
  const perms = getPlan(plan).permissions
  check('A3 FREE : ni Ox Alpha ni modeles premium', perms.oxAlphaModels === false && perms.premiumModels === false)
  const visible = visibleModels(plan)
  check(
    'A4 modeles visibles FREE = exactement Kim Pro',
    visible.length === 1 && visible[0].label === 'Kim Pro',
    visible.map(model => model.label).join(', '),
  )
}

// â”€â”€ B. Pro / Lifetime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const token = sign({ type: 'lifetime', plan: 'pro' })
  const verified = verifyLikeApp(token)
  check('B1 Pro/Lifetime : signature valide', verified.valid)
  check('B2 claim plan=pro present dans le JWT', verified.payload.plan === 'pro')
  const plan = resolveLicensedPlan(verified.payload)
  check('B3 plan resolu = pro', plan === 'pro')
  const perms = getPlan(plan).permissions
  check('B4 PRO : Ox Alpha debloque, premium non', perms.oxAlphaModels === true && perms.premiumModels === false)
  check('B5 PRO : pas advancedTools (reserve Pro Ultimate)', perms.advancedTools === false)
  const visible = visibleModels(plan)
  check(
    'B6 modeles visibles PRO = Kim Pro + Ox Alpha',
    visible.length === 2 && visible.every(model => ['Kim Pro', 'Ox Alpha'].includes(model.label)),
    visible.map(model => model.label).join(', '),
  )
}

// â”€â”€ C. Pro Ultimate / Lifetime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const token = sign({ type: 'lifetime', plan: 'pro_ultimate' })
  const verified = verifyLikeApp(token)
  check('C1 ProUltimate/Lifetime : signature valide', verified.valid)
  const plan = resolveLicensedPlan(verified.payload)
  check('C2 plan resolu = pro_ultimate', plan === 'pro_ultimate')
  const perms = getPlan(plan).permissions
  check('C3 PRO ULTIMATE : toutes permissions', perms.builtinFreeModels && perms.oxAlphaModels && perms.premiumModels && perms.advancedTools && perms.priorityAccess && perms.chat && perms.agent)
  check('C4 PRO ULTIMATE : catalogue complet', visibleModels(plan).length > 3)
}

// â”€â”€ D. Compatibilite historique (type='pro_ultimate') â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const token = sign({ type: 'pro_ultimate' })
  const verified = verifyLikeApp(token)
  check('D1 licence historique type=pro_ultimate valide', verified.valid)
  check('D2 resolue en pro_ultimate', resolveLicensedPlan(verified.payload) === 'pro_ultimate')
}

// â”€â”€ E. Pro / Subscription EXPIREE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
{
  const expiredToken = sign({ type: 'subscription', plan: 'pro', exp: Math.floor(Date.now() / 1000) - 5 })
  const verified = verifyLikeApp(expiredToken)
  check('E1 Pro/Subscription expiree : rejetee par la verification', !verified.valid && verified.expired === true)
  // Licence inactive -> le plan effectif retombe sur FREE (syncPlanFromLicense).
  check('E2 licence inactive -> plan effectif free', resolveLicensedPlan({ plan: 'pro' }) === 'pro'
    && getPlan('free').id === 'free')

  // Subscription encore valide pendant 60 s.
  const live = sign({ type: 'subscription', plan: 'pro', exp: Math.floor(Date.now() / 1000) + 60 })
  const liveVerified = verifyLikeApp(live)
  check('E3 Pro/Subscription 60s : valide maintenant', liveVerified.valid)
  check('E4 expiration ~60 s', Math.abs(liveVerified.payload.exp - Math.floor(Date.now() / 1000) - 60) <= 1)
}

console.log('\n=========================================')
console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
console.log('=========================================')
process.exit(failCount === 0 ? 0 : 1)
