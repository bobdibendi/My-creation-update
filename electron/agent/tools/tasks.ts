import type { Tool } from '../types.js'
import { asRecord, objectSchema, optionalString, requireString } from '../validate.js'
import { isTaskPriority, isTaskStatus, type TaskService, type TaskSource } from '../../tasks.js'

/**
 * Pont scoping les operations de taches a l'utilisateur d'une session.
 * L'IA ne touche jamais la base : chaque appel traverse le TaskService,
 * qui valide puis diffuse l'evenement de mise a jour au renderer.
 */
export interface TaskToolBridge {
  userId: number | null
  service: TaskService
}

function summarize(task: Awaited<ReturnType<TaskService['update']>>) {
  return {
    id: task.id,
    titre: task.title,
    statut: task.status,
    priorite: task.priority,
    source: task.source,
    bloquee_raison: task.blockedReason,
  }
}

export function createTaskTools(bridge: TaskToolBridge): Tool[] {
  const origin: TaskSource = 'ai'
  const { service, userId } = bridge

  return [
    {
      name: 'listTasks',
      description: 'Liste la Todo reelle de l\'utilisateur (taches enregistrees). A utiliser AVANT de parler des taches de l\'utilisateur : ne jamais inventer une liste. Repond aussi a "que dois-je faire ensuite ?" en regardant les taches EN COURS et les priorites hautes.',
      mutates: false,
      parameters: objectSchema({}),
      async execute() {
        const tasks = service.list(userId)
        if (tasks.length === 0) return { taches: [], message: 'Aucune tache enregistree.' }
        return {
          total: tasks.length,
          ouvertes: tasks.filter(t => t.status !== 'completed').length,
          taches: tasks.map(t => ({
            id: t.id, titre: t.title, statut: t.status, priorite: t.priority,
            source: t.source, raison_blocage: t.blockedReason,
          })),
        }
      },
    },
    {
      name: 'getTask',
      description: 'Lit une tache precise par son id (apres listTasks) : titre, description complete, statut, priorite.',
      mutates: false,
      parameters: objectSchema({ id: { type: 'string', description: 'Identifiant de la tache' } }, ['id']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'getTask')
        const task = service.get(userId, requireString(record, 'id'))
        if (!task) throw new Error('Tache introuvable')
        return {
          ...summarize(task),
          description: task.description,
          creee_le: new Date(task.createdAt).toISOString(),
          terminee_le: task.completedAt ? new Date(task.completedAt).toISOString() : null,
        }
      },
    },
    {
      name: 'createTask',
      description: 'Cree UNE tache dans la Todo de l\'utilisateur (source = IA). A utiliser quand un travail supplementaire est detecte ou quand l\'utilisateur demande d\'organiser/preparer quelque chose. Regles : maximum 5 taches par reponse, titres courts et concrets (une action par tache), decouper un gros travail en sous-taches claires. Ne pas creer de doublon avec une tache existante (appeler listTasks avant).',
      mutates: true,
      parameters: objectSchema({
        title: { type: 'string', description: 'Titre court et actionnable (max 200 caracteres)' },
        description: { type: 'string', description: 'Detail optionnel' },
        priority: { type: 'string', description: 'low | medium | high', enum: ['low', 'medium', 'high'] },
        status: { type: 'string', description: 'todo | in_progress | blocked (todo par defaut)', enum: ['todo', 'in_progress', 'blocked'] },
        blockedReason: { type: 'string', description: 'Si status=blocked : pourquoi' },
      }, ['title']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'createTask')
        const title = requireString(record, 'title')
        if (title.trim().length < 3) throw new Error('Titre trop court (3 caracteres minimum)')
        const priority = optionalString(record, 'priority', 'medium')
        if (!isTaskPriority(priority)) throw new Error('Priorite invalide : low, medium ou high')
        const status = optionalString(record, 'status', 'todo')
        if (status !== 'todo' && !isTaskStatus(status)) throw new Error('Statut invalide')
        const created = service.create(userId, {
          title,
          description: optionalString(record, 'description', '') || null,
          priority,
          status: isTaskStatus(status) ? status : 'todo',
          source: origin,
          blockedReason: optionalString(record, 'blockedReason', '') || null,
        })
        return { ok: true, creee: summarize(created) }
      },
    },
    {
      name: 'updateTask',
      description: 'Modifie une tache existante : titre, description, priorite, statut. Utilise status="in_progress" quand tu COMMENCES a travailler sur cette tache, status="blocked" avec blockedReason si un obstacle reel empeche de continuer (dependance manquante, information manquante...).',
      mutates: true,
      parameters: objectSchema({
        id: { type: 'string', description: 'Identifiant de la tache' },
        title: { type: 'string', description: 'Nouveau titre' },
        description: { type: 'string', description: 'Nouvelle description' },
        priority: { type: 'string', description: 'low | medium | high', enum: ['low', 'medium', 'high'] },
        status: { type: 'string', description: 'todo | in_progress | completed | blocked', enum: ['todo', 'in_progress', 'completed', 'blocked'] },
        blockedReason: { type: 'string', description: 'Si status=blocked : raison precise' },
      }, ['id']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'updateTask')
        const id = requireString(record, 'id')
        const changes: Parameters<TaskService['update']>[2] = {}
        if (record.title !== undefined) changes.title = requireString(record, 'title')
        if (record.description !== undefined) changes.description = String(record.description)
        if (record.priority !== undefined) {
          const priority = requireString(record, 'priority')
          if (!isTaskPriority(priority)) throw new Error('Priorite invalide : low, medium ou high')
          changes.priority = priority
        }
        if (record.status !== undefined) {
          const status = requireString(record, 'status')
          if (!isTaskStatus(status)) throw new Error('Statut invalide')
          changes.status = status
        }
        if (record.blockedReason !== undefined) changes.blockedReason = String(record.blockedReason)
        if (Object.keys(changes).length === 0) throw new Error('Aucune modification fournie')
        const updated = service.update(userId, id, changes, origin)
        return { ok: true, modifiee: summarize(updated) }
      },
    },
    {
      name: 'completeTask',
      description: 'Marque une tache comme terminee. REGLE DE CONFIANCE : appelle cet outil UNIQUEMENT apres verification reelle via tes outils (fichier ecrit + relu, build passe, commande reussie...). Ne marque JAMAIS une tache terminee sur une simple supposition. Si tu penses qu\'elle est finie sans preuve complete, dis-le dans ta reponse et laisse l\'utilisateur confirmer.',
      mutates: true,
      parameters: objectSchema({
        id: { type: 'string', description: 'Identifiant de la tache' },
        evidence: { type: 'string', description: 'Preuve concrete : ce qui a ete verifie' },
      }, ['id']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'completeTask')
        const updated = service.complete(userId, requireString(record, 'id'), origin)
        return { ok: true, terminee: summarize(updated), evidence: optionalString(record, 'evidence', '') || null }
      },
    },
    {
      name: 'reopenTask',
      description: 'Rouvre une tache terminee (statut todo) quand on realise qu\'elle n\'est finalement pas finie ou qu\'un retour de l\'utilisateur la remet en question.',
      mutates: true,
      parameters: objectSchema({ id: { type: 'string', description: 'Identifiant de la tache' } }, ['id']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'reopenTask')
        const updated = service.reopen(userId, requireString(record, 'id'), origin)
        return { ok: true, rouverte: summarize(updated) }
      },
    },
    {
      name: 'deleteTask',
      description: 'Supprime une tache. ACTION SENSIBLE : uniquement si l\'utilisateur le demande explicitement ou si la tache est un doublon evident que tu viens de creer toi-meme. Jamais pour "nettoyer" la liste a l\'insu de l\'utilisateur.',
      mutates: true,
      parameters: objectSchema({ id: { type: 'string', description: 'Identifiant de la tache' } }, ['id']),
      async execute(args) {
        const record = asRecord(args ?? {}, 'deleteTask')
        const removed = service.remove(userId, requireString(record, 'id'), origin)
        if (!removed) throw new Error('Tache introuvable')
        return { ok: true }
      },
    },
  ]
}
