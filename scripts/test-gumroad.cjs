#!/usr/bin/env node
/**
 * TESTS GUMROAD — service de vérification (main process), hors EXE.
 *
 * Un serveur HTTP local simule l'API officielle POST /v2/licenses/verify :
 *   1. clé PRO valide            -> ok, plan=pro
 *   2. clé PRO ULTIMATE valide   -> ok, plan=pro_ultimate
 *   3. clé inconnue              -> kind=invalid
 *   4. clé remboursée            -> kind=refunded
 *   5. serveur injoignable       -> kind=network (règle hors-ligne)
 *   6. aucun produit configuré   -> kind=unconfigured
 *   7. resolvePlan : mapping Product ID -> plan
 *
 * Usage: node scripts/test-gumroad.cjs   (après npm run build:electron)
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const distGumroad = path.resolve(__dirname, '..', 'dist-electron', 'gumroad.js')
if (!fs.existsSync(distGumroad)) {
  console.error('FATAL dist-electron/gumroad.js absent. Lance "npm run build:electron".')
  process.exit(1)
}
const { GumroadService } = require(distGumroad)

const problems = []
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`)
  if (!condition) problems.push(name)
}

/** Serveur mock : répond selon la clé fournie. */
function startMock() {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const params = new URLSearchParams(body)
        const key = params.get('license_key') ?? ''
        const productId = params.get('product_id') ?? ''
        response.setHeader('Content-Type', 'application/json')

        // Comme le vrai Gumroad : une clé n'appartient qu'à UN produit.
        // Une combinaison produit/clé inconnue -> 404.
        const keyProduct = {
          'PRO-VALID-KEY-123': 'prod_pro_111',
          'ULT-VALID-KEY-456': 'prod_ult_222',
          'REFUNDED-KEY-789': 'prod_pro_111',
          'DISABLED-KEY-000': 'prod_ult_222',
        }[key]

        if (keyProduct !== undefined && keyProduct === productId) {
          const refunded = key === 'REFUNDED-KEY-789'
          const disabled = key === 'DISABLED-KEY-000'
          response.end(JSON.stringify({
            success: true,
            purchase: {
              email: `${key.toLowerCase()}@example.com`,
              product_id: productId,
              sale_id: 1001,
              refunded,
              disabled,
              test: key === 'ULT-VALID-KEY-456',
            },
          }))
        } else {
          response.statusCode = 404
          response.end(JSON.stringify({ success: false, message: 'License not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  const server = await startMock()
  const { port } = server.address()

  // ── 7. Mapping Product ID -> plan ──
  const svc = new GumroadService({
    proProductId: 'prod_pro_111',
    ultimateProductId: 'prod_ult_222',
    apiBase: `http://127.0.0.1:${port}`,
  })
  check('resolvePlan(PRO) -> pro', svc.resolvePlan('prod_pro_111') === 'pro')
  check('resolvePlan(ULTIMATE) -> pro_ultimate', svc.resolvePlan('prod_ult_222') === 'pro_ultimate')
  check('resolvePlan(inconnu) -> null', svc.resolvePlan('other') === null)
  check('configured=true quand au moins un produit', svc.configured === true)

  // ── 1. Clé PRO valide ──
  const pro = await svc.verifyLicenseKey('PRO-VALID-KEY-123')
  check('clé PRO valide -> ok', pro.ok === true)
  if (pro.ok) {
    check('clé PRO -> plan=pro', pro.plan === 'pro')
    check('clé PRO -> productId résolu', pro.productId === 'prod_pro_111', pro.productId)
    check('clé PRO -> email lu', pro.email === 'pro-valid-key-123@example.com')
    check('clé PRO -> saleId lu', pro.saleId === '1001')
  }

  // ── 2. Clé PRO ULTIMATE valide ──
  const ult = await svc.verifyLicenseKey('ULT-VALID-KEY-456')
  check('clé ULTIMATE valide -> ok + plan=pro_ultimate', ult.ok === true && ult.plan === 'pro_ultimate')
  if (ult.ok) check('achat test détecté (info)', ult.test === true)

  // ── 3. Clé inconnue ──
  const bad = await svc.verifyLicenseKey('UNKNOWN-KEY')
  check('clé inconnue -> refusée', bad.ok === false && bad.kind === 'invalid')

  // ── 4. Clé remboursée ──
  const refunded = await svc.verifyLicenseKey('REFUNDED-KEY-789')
  check('clé remboursée -> refusée (kind=refunded)', refunded.ok === false && refunded.kind === 'refunded')

  // Clé désactivée : même traitement que remboursée.
  const disabled = await svc.verifyLicenseKey('DISABLED-KEY-000')
  check('clé désactivée -> refusée (kind=refunded)', disabled.ok === false && disabled.kind === 'refunded')

  // ── 5. Serveur injoignable (règle hors-ligne) ──
  const offlineSvc = new GumroadService({
    proProductId: 'prod_pro_111',
    ultimateProductId: null,
    apiBase: 'http://127.0.0.1:9', // port discard, rien n'écoute
  })
  const netFail = await offlineSvc.verifyLicenseKey('PRO-VALID-KEY-123')
  check('API injoignable -> kind=network', netFail.ok === false && netFail.kind === 'network')

  // ── 6. Aucun produit configuré ──
  const emptySvc = new GumroadService({ proProductId: null, ultimateProductId: null, apiBase: `http://127.0.0.1:${port}` })
  const uncon = await emptySvc.verifyLicenseKey('PRO-VALID-KEY-123')
  check('aucun produit configuré -> kind=unconfigured', uncon.ok === false && uncon.kind === 'unconfigured')

  // readGumroadConfig depuis l'environnement.
  process.env.GUMROAD_PRO_PRODUCT_ID = 'env_pro'
  process.env.GUMROAD_API_URL = ''
  delete process.env.GUMROAD_API_URL
  const { readGumroadConfig } = require(distGumroad)
  const cfg = readGumroadConfig()
  check('readGumroadConfig lit GUMROAD_PRO_PRODUCT_ID', cfg.proProductId === 'env_pro')
  check('readGumroadConfig base par défaut', cfg.apiBase === 'https://api.gumroad.com')
  delete process.env.GUMROAD_PRO_PRODUCT_ID

  server.closeAllConnections?.()
  server.close()
  console.log(`\nRESULT: ${7 + 8 - problems.length} PASS, ${problems.length} FAIL`)
  // Petit délai : laisse les sockets keep-alive finir de se fermer (sinon
  // Node/Windows émet une assertion libuv bénigne au moment du exit).
  setTimeout(() => process.exit(problems.length === 0 ? 0 : 1), 100)
}

main().catch(error => {
  console.error('FATAL', error?.stack ?? String(error))
  process.exit(1)
})
