#!/usr/bin/env node
/**
 * Test du pool de clés API (electron/keypool.ts compilé).
 *
 * Couverture :
 *   - lecture de plusieurs sources (variables d'environnement) ;
 *   - dédoublonnage et rejet des valeurs vides ;
 *   - rotation round-robin ;
 *   - mise au repos après échec puis réutilisation après cooldown.
 *
 * Usage : node scripts/test-keypool.cjs   (lance `npm run build:electron` avant)
 */
const fs = require('node:fs')
const path = require('node:path')

const distDir = path.resolve(__dirname, '..', 'dist-electron')
if (!fs.existsSync(path.join(distDir, 'keypool.js'))) {
  console.error('FATAL dist-electron/keypool.js absent. Lance "npm run build".')
  process.exit(1)
}
const { ApiKeyPool } = require(path.join(distDir, 'keypool.js'))

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

process.env.TEST_KEYS_A = 'sk-aaa, sk-bbb ; sk-ccc'
process.env.TEST_KEYS_B = 'sk-aaa' // doublon volontaire
const pool = new ApiKeyPool([
  () => process.env.TEST_KEYS_A,
  () => process.env.TEST_KEYS_B,
])

check('3 clés uniques chargées', pool.size === 3, `size=${pool.size}`)

// Rotation round-robin.
const first = [pool.next(), pool.next(), pool.next()]
check('rotation couvre toutes les clés', new Set(first).size === 3, first.join(','))

// Une clé vide ne casse rien.
const sparse = new ApiKeyPool([() => ' , ,sk-only'])
check('clé vide ignorée', sparse.size === 1 && typeof sparse.next() === 'string')

// Aucune clé -> null sans crash.
const empty = new ApiKeyPool([() => '', () => null])
check('pool vide -> next() = null', empty.size === 0 && empty.next() === null)

// Échec : la clé est mise au repos, le pool continue sur les autres.
pool.reportFailure(first[0])
const afterFailure = pool.next()
check('après échec on tourne sur une autre clé', afterFailure !== first[0], afterFailure)

// Cooldown écoulé : la clé redevient utilisable via reportSuccess.
pool.reportSuccess(first[0])
let recovered = false
for (let i = 0; i < 6; i++) {
  if (pool.next() === first[0]) { recovered = true; break }
}
check('clé rétablie réintégrée en rotation', recovered)

console.log('\n=========================================')
console.log(`RESULT: ${passCount} PASS, ${failCount} FAIL`)
console.log('=========================================')
process.exit(failCount === 0 ? 0 : 1)
