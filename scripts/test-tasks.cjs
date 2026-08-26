#!/usr/bin/env node
/**
 * TESTS TODO — système de tâches de My Creation.
 *
 * Boote le vrai processus main puis vérifie dans le renderer :
 *   TEST 1  création d'une tâche sans compte (FREE local)
 *   TEST 2  événement temps réel reçu après mutation
 *   TEST 3  mise à jour du statut (in_progress -> completed -> todo)
 *   TEST 4  priorité + tâche bloquée avec raison
 *   TEST 5  persistance après rechargement de la fenêtre
 *   TEST 6  suppression + restauration (undo)
 *   TEST 7  journal d'activité alimenté
 *   TEST 8  outils IA enregistrés (create_task/listTasks...) via l'agent réel
 *
 * Usage : npx electron scripts/test-tasks.cjs   (après npm run build)
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { report } = require('./lib/reporter.cjs')

const projectRoot = path.resolve(__dirname, '..')

app.setName('cursor-clone')
app.disableHardwareAcceleration()
app.on('window-all-closed', () => { /* le test contrôle sa vie */ })

async function main() {
  const problems = []

  process.on('uncaughtException', error => {
    report('FATAL uncaught: ' + (error && error.stack ? error.stack : String(error)))
    process.exit(1)
  })

  // Profil réel requis : le keystore administrateur a été chiffré sous le nom
  // 'cursor-clone' et safeStorage lie son déchiffrement au contexte de l'app
  // (même règle que test-free-flow.cjs).

  require(path.join(projectRoot, 'dist-electron', 'main.js'))

  let win = null
  for (let i = 0; i < 200 && !win; i += 1) {
    win = BrowserWindow.getAllWindows()[0] ?? null
    if (!win) await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!win) { report('FAIL aucune fenetre'); process.exit(1) }
  await new Promise(resolve => setTimeout(resolve, 2500))

  const run = script => win.webContents.executeJavaScript(script, true)

  // ── TEST 1-4 : cycle de vie complet ──
  const lifecycle = await run(`
    (async () => {
      const bridge = window.electronAPI
      if (!bridge || !bridge.tasks) return { error: 'bridge.tasks absent' }

      let event = null
      const off = bridge.tasks.onChange(payload => { event = payload })

      const created = await bridge.tasks.create(null, {
        title: 'Finaliser la page d accueil',
        description: 'Tests de la refonte',
        priority: 'high',
      })
      await new Promise(r => setTimeout(r, 250))

      const started = await bridge.tasks.update(null, created.id, { status: 'in_progress' })
      const completed = await bridge.tasks.complete(null, created.id)
      const reopened = await bridge.tasks.reopen(null, created.id)

      const blocked = await bridge.tasks.create(null, { title: 'Configurer Gumroad' })
      const blockedTask = await bridge.tasks.update(null, blocked.id, {
        status: 'blocked',
        blockedReason: 'Product ID manquant.',
      })

      await new Promise(r => setTimeout(r, 300))
      off()

      return {
        createdOk: Boolean(created.id) && created.source === 'user',
        eventReceived: Boolean(event) && Array.isArray(event.tasks),
        startedStatus: started.status,
        completedHasDate: typeof completed.completedAt === 'number',
        reopenedStatus: reopened.status,
        blockedReason: blockedTask.blockedReason,
        totalAfter: event ? event.tasks.length : -1,
      }
    })()
  `, true)

  report(`${lifecycle.createdOk ? 'PASS' : 'FAIL'}  TEST1 creation tache sans compte`)
  report(`${lifecycle.eventReceived ? 'PASS' : 'FAIL'}  TEST2 evenement temps reel recu (${lifecycle.totalAfter} tache(s))`)
  report(`${lifecycle.startedStatus === 'in_progress' && lifecycle.reopenedStatus === 'todo' && lifecycle.completedHasDate ? 'PASS' : 'FAIL'}  TEST3 statuts in_progress/completed/reopen`)
  report(`${lifecycle.blockedReason === 'Product ID manquant.' ? 'PASS' : 'FAIL'}  TEST4 tache bloquee avec raison`)

  for (const [name, ok] of [
    ['TEST1 creation tache', lifecycle.createdOk],
    ['TEST2 evenement temps reel', lifecycle.eventReceived],
    ['TEST3 cycle statuts', lifecycle.startedStatus === 'in_progress' && lifecycle.reopenedStatus === 'todo' && lifecycle.completedHasDate],
    ['TEST4 blocage avec raison', lifecycle.blockedReason === 'Product ID manquant.'],
  ]) {
    if (!ok) problems.push(name)
  }

  // ── TEST 5 : persistance après reload ──
  await win.reload()
  await new Promise(resolve => setTimeout(resolve, 2500))

  const persisted = await run(`
    (async () => {
      const tasks = await window.electronAPI.tasks.list(null)
      return { count: tasks.length, hasHigh: tasks.some(t => t.priority === 'high') }
    })()
  `, true)
  report(`${persisted.count >= 2 && persisted.hasHigh ? 'PASS' : 'FAIL'}  TEST5 persistance apres reload (${persisted.count} taches)`)
  if (!(persisted.count >= 2)) problems.push('TEST5 persistance')

  // ── TEST 6 : suppression + restauration (undo) ──
  const undo = await run(`
    (async () => {
      const bridge = window.electronAPI
      const before = await bridge.tasks.list(null)
      const target = before[0]
      await bridge.tasks.remove(null, target.id)
      const afterRemove = await bridge.tasks.list(null)
      await bridge.tasks.restoreSnapshot(null, target)
      const afterRestore = await bridge.tasks.list(null)
      return {
        removed: afterRemove.length === before.length - 1,
        restored: afterRestore.length === before.length,
        idKept: afterRestore.some(t => t.id === target.id),
      }
    })()
  `, true)
  report(`${undo.removed && undo.restored && undo.idKept ? 'PASS' : 'FAIL'}  TEST6 suppression + restauration`)
  if (!(undo.removed && undo.restored)) problems.push('TEST6 undo')

  // ── TEST 7 : journal d'activité ──
  const log = await run(`window.electronAPI.tasks.activityLog(null, 50)`, true)
  report(`${Array.isArray(log) && log.length > 0 ? 'PASS' : 'FAIL'}  TEST7 journal d activite (${log.length} entrees)`)
  if (!Array.isArray(log) || log.length === 0) problems.push('TEST7 journal')

  // ── TEST 8 : outils IA disponibles côté agent ──
  // On vérifie que les schémas d'outils sont exposés par une vraie exécution
  // agent : un appel listTasks via le runtime réel.
  const toolsCheck = await run(`
    (async () => {
      const bridge = window.electronAPI
      await bridge.tasks.create(null, { title: 'Tache visible par l assistant' })
      return { ok: true }
    })()
  `, true)

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mycreation-agent-tasks-'))
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'hello\n', 'utf8')

  const agentResult = await new Promise(resolve => {
    const timeout = setTimeout(() => resolve({ done: false, error: 'timeout' }), 120_000)
    let sid = null
    const off = win.webContents.executeJavaScript(`
      (async () => {
        const res = await window.electronAPI.agent.start({
          prompt: 'Utilise l outil listTasks pour lire la Todo, puis cite simplement le titre de la premiere tache ouverte dans ta reponse.',
          model: 'kim-pro',
          workspace: ${JSON.stringify(workspace)},
        })
        return res.sessionId
      })()
    `, true).then(id => { sid = id })
    win.webContents.on('console-message', () => {})
    const poll = setInterval(async () => {
      if (!sid) return
      const state = await win.webContents.executeJavaScript(`
        (function(){ return window.__taskAgentState || null })()
      `, true)
      void state; void poll; void off
    }, 1000)
    void off
    void timeout
    // Simplification : on attend done via listener executeJavaScript.
  })

  // L'approche ci-dessus est trop complexe : test direct des outils via IPC
  // interne = non applicable ; on valide donc la présence des outils par une
  // exécution agent simplifiée avec collecte d'événements propre.
  const aiCheck = await win.webContents.executeJavaScript(`
    (async () => {
      const bridge = window.electronAPI
      const ws = ${JSON.stringify(workspace)}
      let text = ''
      let toolCalled = false
      let done = false
      let error = null
      const off = bridge.agent.onEvent(event => {
        if (event.type === 'tool-call' && event.tool === 'listTasks') toolCalled = true
        else if (event.type === 'text') text += event.text
        else if (event.type === 'done') done = true
        else if (event.type === 'error') error = event.message
      })
      try {
        await bridge.agent.start({
          prompt: 'Appelle listTasks maintenant, puis réponds uniquement: OK',
          model: 'kim-pro',
          workspace: ws,
        })
      } catch (e) { error = e.message }
      const start = Date.now()
      while (Date.now() - start < 120000 && !done && !error) {
        await new Promise(r => setTimeout(r, 200))
      }
      off()
      return { done, toolCalled, text: text.slice(0, 120), error }
    })()
  `, true)

  report(`${aiCheck.done && aiCheck.toolCalled ? 'PASS' : 'FAIL'}  TEST8 outil listTasks appele par l agent (${aiCheck.toolCalled ? 'ok' : 'jamais appele'})`)
  if (!(aiCheck.done && aiCheck.toolCalled)) problems.push('TEST8 outils IA: ' + (aiCheck.error ?? ''))

  console.log('')
  const ok = problems.length === 0
  report(ok ? 'PASS  Systeme Todo complet' : 'FAIL  ' + problems.length + ' probleme(s): ' + problems.join(' | '))
  app.exit(ok ? 0 : 1)
}

main().catch(error => {
  report('FATAL ' + (error && error.stack ? error.stack : String(error)))
  process.exit(1)
})
