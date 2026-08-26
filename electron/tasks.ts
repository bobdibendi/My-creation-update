import { randomUUID } from 'node:crypto'
import { getDatabase } from './database.js'

export type TaskStatus = 'todo' | 'in_progress' | 'completed' | 'blocked'
export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskSource = 'user' | 'ai'

export interface Task {
  id: string
  userId: number | null
  projectId: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  source: TaskSource
  blockedReason: string | null
  position: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface ActionLogEntry {
  id: number
  kind: string
  label: string
  detail: string | null
  createdAt: number
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  priority?: TaskPriority
  status?: TaskStatus
  source?: TaskSource
  projectId?: string | null
  blockedReason?: string | null
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  status?: TaskStatus
  priority?: TaskPriority
  projectId?: string | null
  blockedReason?: string | null
}

const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'completed', 'blocked']
const PRIORITIES: readonly TaskPriority[] = ['low', 'medium', 'high']
const MAX_TITLE = 200
const MAX_DESCRIPTION = 2000
const MAX_TASKS = 500

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    userId: row.userId === null || row.userId === undefined ? null : Number(row.userId),
    projectId: row.projectId === null || row.projectId === undefined ? null : String(row.projectId),
    title: String(row.title),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    status: String(row.status) as TaskStatus,
    priority: String(row.priority) as TaskPriority,
    source: String(row.source) as TaskSource,
    blockedReason: row.blockedReason === null || row.blockedReason === undefined ? null : String(row.blockedReason),
    position: Number(row.position),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    completedAt: row.completedAt === null || row.completedAt === undefined ? null : Number(row.completedAt),
  }
}

/**
 * TaskService : seule couche autorisee a ecrire dans la table tasks.
 *
 * Le renderer passe par les canaux IPC `tasks:*` et l'IA par les outils
 * `*_task` - aucun des deux ne touche la base directement. Chaque mutation
 * est validee puis diffusee au renderer via un callback d'evenement, ce qui
 * garantit une UI synchronisee en temps reel sans polling.
 */
export class TaskService {
  private onChangeRef: ((userId: number | null, origin: TaskSource) => void) | null = null

  setChangeNotifier(notify: ((userId: number | null, origin: TaskSource) => void) | null): void {
    this.onChangeRef = notify
  }

  private notify(userId: number | null, origin: TaskSource = 'user'): void {
    try { this.onChangeRef?.(userId, origin) } catch { /* jamais fatal */ }
  }

  /** Scope SQL : taches du compte + taches locales (mode sans compte). */
  private scope(userId: number | null): string {
    return userId === null ? 'userId IS NULL' : '(userId IS NULL OR userId = ?)'
  }

  private scopeArgs(userId: number | null): unknown[] {
    return userId === null ? [] : [userId]
  }

  list(userId: number | null): Task[] {
    const rows = getDatabase()
      .prepare(`SELECT * FROM tasks WHERE ${this.scope(userId)} ORDER BY position ASC, createdAt DESC LIMIT 1000`)
      .all(...this.scopeArgs(userId)) as Array<Record<string, unknown>>
    return rows.map(rowToTask)
  }

  get(userId: number | null, id: string): Task | null {
    const row = getDatabase()
      .prepare(`SELECT * FROM tasks WHERE id = ? AND ${this.scope(userId)}`)
      .get(id, ...this.scopeArgs(userId)) as Record<string, unknown> | undefined
    return row ? rowToTask(row) : null
  }

  create(userId: number | null, input: CreateTaskInput): Task {
    const title = input.title.trim().slice(0, MAX_TITLE)
    if (title.length === 0) throw new Error('Le titre de la tâche ne peut pas être vide')
    const db = getDatabase()

    const countRow = db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${this.scope(userId)}`)
      .get(...this.scopeArgs(userId)) as { n: number }
    if (countRow.n >= MAX_TASKS) throw new Error('La liste de tâches est pleine (500 maximum)')

    const status: TaskStatus = input.status ?? 'todo'
    const now = Date.now()
    const task: Task = {
      id: randomUUID(),
      userId,
      projectId: input.projectId?.trim() || null,
      title,
      description: input.description?.trim().slice(0, MAX_DESCRIPTION) || null,
      status,
      priority: input.priority ?? 'medium',
      source: input.source ?? 'user',
      blockedReason: input.blockedReason?.trim().slice(0, MAX_TITLE) || null,
      position: Math.floor(now / 1000) % 2_000_000_000,
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'completed' ? now : null,
    }

    db.prepare(
      `INSERT INTO tasks (id, userId, projectId, title, description, status, priority, source, blockedReason, position, createdAt, updatedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id, task.userId, task.projectId, task.title, task.description,
      task.status, task.priority, task.source, task.blockedReason,
      task.position, task.createdAt, task.updatedAt, task.completedAt,
    )

    this.logActivity(
      userId,
      input.source === 'ai' ? 'task-created-ai' : 'task-created',
      title,
      null,
    )
    this.notify(userId, task.source)
    return task
  }

  update(userId: number | null, id: string, changes: UpdateTaskInput, origin: TaskSource = 'user'): Task {
    const existing = this.get(userId, id)
    if (!existing) throw new Error('Tâche introuvable')

    const next: Task = { ...existing }
    if (changes.title !== undefined) {
      const title = changes.title.trim().slice(0, MAX_TITLE)
      if (title.length === 0) throw new Error('Le titre de la tâche ne peut pas être vide')
      next.title = title
    }
    if (changes.description !== undefined) {
      next.description = changes.description?.trim().slice(0, MAX_DESCRIPTION) || null
    }
    if (changes.priority !== undefined) {
      if (!isTaskPriority(changes.priority)) throw new Error('Priorité invalide')
      next.priority = changes.priority
    }
    if (changes.projectId !== undefined) {
      next.projectId = changes.projectId?.trim() || null
    }
    if (changes.status !== undefined) {
      if (!isTaskStatus(changes.status)) throw new Error('Statut invalide')
      this.applyStatus(next, changes.status, changes.blockedReason)
    } else if (changes.blockedReason !== undefined && next.status === 'blocked') {
      next.blockedReason = changes.blockedReason?.trim().slice(0, MAX_TITLE) || null
    }

    next.updatedAt = Date.now()
    getDatabase().prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, projectId = ?, blockedReason = ?, updatedAt = ?, completedAt = ?
       WHERE id = ?`,
    ).run(
      next.title, next.description, next.status, next.priority, next.projectId,
      next.blockedReason, next.updatedAt, next.completedAt, id,
    )

    this.logActivity(userId, `task-${next.status}`, next.title, existing.status !== next.status ? `${existing.status} -> ${next.status}` : null)
    this.notify(userId, origin)
    return next
  }

  private applyStatus(task: Task, status: TaskStatus, blockedReason?: string | null): void {
    task.status = status
    if (status === 'completed') {
      task.completedAt = Date.now()
      task.blockedReason = null
    } else {
      task.completedAt = null
      task.blockedReason = status === 'blocked'
        ? (blockedReason?.trim().slice(0, MAX_TITLE) || 'Raison non précisée.')
        : null
    }
  }

  complete(userId: number | null, id: string, origin: TaskSource = 'user'): Task {
    return this.update(userId, id, { status: 'completed' }, origin)
  }

  reopen(userId: number | null, id: string, origin: TaskSource = 'user'): Task {
    return this.update(userId, id, { status: 'todo' }, origin)
  }

  remove(userId: number | null, id: string, origin: TaskSource = 'user'): boolean {
    const existing = this.get(userId, id)
    if (!existing) return false
    getDatabase().prepare('DELETE FROM tasks WHERE id = ?').run(id)
    this.logActivity(userId, 'task-deleted', existing.title, origin === 'ai' ? 'Supprimee par l assistant' : null)
    this.notify(userId, origin)
    return true
  }

  /** Restaure un etat complet (annulation). L'id est conserve. */
  restoreSnapshot(userId: number | null, snapshot: Task): Task {
    const now = Date.now()
    getDatabase().prepare(
      `INSERT INTO tasks (id, userId, projectId, title, description, status, priority, source, blockedReason, position, createdAt, updatedAt, completedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, description = excluded.description, status = excluded.status,
         priority = excluded.priority, projectId = excluded.projectId, blockedReason = excluded.blockedReason,
         updatedAt = excluded.updatedAt, completedAt = excluded.completedAt`,
    ).run(
      snapshot.id, snapshot.userId, snapshot.projectId, snapshot.title, snapshot.description,
      snapshot.status, snapshot.priority, snapshot.source, snapshot.blockedReason,
      snapshot.position, snapshot.createdAt, now, snapshot.completedAt,
    )
    this.logActivity(userId, 'task-restored', snapshot.title, null)
    this.notify(snapshot.userId, 'user')
    return this.get(userId, snapshot.id) ?? snapshot
  }

  clearCompleted(userId: number | null): number {
    const result = getDatabase()
      .prepare(`DELETE FROM tasks WHERE ${this.scope(userId)} AND status = 'completed'`)
      .run(...this.scopeArgs(userId))
    if (result.changes > 0) {
      this.logActivity(userId, 'tasks-cleared', `${result.changes} tache(s) terminee(s) supprimee(s)`, null)
      this.notify(userId, 'user')
    }
    return result.changes
  }

  logActivity(userId: number | null, kind: string, label: string, detail?: string | null): void {
    try {
      getDatabase().prepare(
        'INSERT INTO action_log (userId, kind, label, detail, createdAt) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, kind.slice(0, 60), label.slice(0, MAX_TITLE), detail?.slice(0, MAX_TITLE) ?? null, Date.now())
    } catch { /* le journal ne doit jamais faire echouer une action */ }
  }

  activityLog(userId: number | null, limit = 80): ActionLogEntry[] {
    const rows = getDatabase()
      .prepare(`SELECT id, kind, label, detail, createdAt FROM action_log WHERE ${this.scope(userId)} ORDER BY createdAt DESC LIMIT ?`)
      .all(...this.scopeArgs(userId), Math.min(Math.max(limit, 1), 300)) as Array<Record<string, unknown>>
    return rows.map(row => ({
      id: Number(row.id),
      kind: String(row.kind),
      label: String(row.label),
      detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
      createdAt: Number(row.createdAt),
    }))
  }

  /** Resume compact injecte dans les prompts de l'IA. */
  summaryForPrompt(userId: number | null, max = 20): string {
    const tasks = this.list(userId)
    if (tasks.length === 0) return ''
    const icon: Record<TaskStatus, string> = {
      todo: '[ ]', in_progress: '[~]', completed: '[x]', blocked: '[!]',
    }
    const lines = tasks.slice(0, max).map(task =>
      `${icon[task.status]} ${task.title} (priorite: ${task.priority}${task.status === 'in_progress' ? ', EN COURS' : ''}${task.status === 'blocked' && task.blockedReason ? `, bloque: ${task.blockedReason}` : ''})`)
    const openCount = tasks.filter(t => t.status !== 'completed').length
    return [
      `Liste Todo actuelle de l'utilisateur (${openCount} ouverte(s) sur ${tasks.length}).`,
      ...lines,
    ].join('\n')
  }
}
