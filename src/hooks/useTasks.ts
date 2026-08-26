import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CreateTaskInput,
  Task,
  TaskPriority,
  TasksChangedPayload,
  TaskStatus,
  UpdateTaskInput,
} from '../shared/types'

/**
 * Store Todo côté renderer.
 *
 * Source de vérité : SQLite via le main process. Le hook garde une copie
 * locale synchronisée par l'événement `tasks:changed` (diffusé après CHAQUE
 * mutation, qu'elle vienne de l'utilisateur ou de l'IA) — aucune boucle de
 * polling. Chaque mutation utilisateur pousse un instantané dans une pile
 * d'annulation locale pour un undo sûr.
 */
export function useTasks(sessionToken: string | null) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loaded, setLoaded] = useState(false)
  const undoStack = useRef<Task[]>([])

  const tokenRef = useRef(sessionToken)
  tokenRef.current = sessionToken

  const reload = useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI?.tasks.list(tokenRef.current)
      if (list) setTasks(list)
    } catch { /* le main process répondra au prochain événement */ }
    setLoaded(true)
  }, [])

  useEffect(() => {
    void reload()
    const bridge = window.electronAPI
    if (!bridge) return
    return bridge.tasks.onChange((payload: TasksChangedPayload) => {
      setTasks(payload.tasks)
      setLoaded(true)
      document.dispatchEvent(new CustomEvent<TasksChangedPayload>('tasks-changed', { detail: payload }))
    })
  }, [reload])

  const pushUndo = useCallback((snapshot: Task | null): void => {
    if (snapshot) {
      undoStack.current.push(snapshot)
      if (undoStack.current.length > 50) undoStack.current.shift()
    }
  }, [])

  const mutate = useCallback(async (
    action: (token: string | null) => Promise<Task | null>,
  ): Promise<void> => {
    try {
      const previous = await action(tokenRef.current)
      pushUndo(previous)
      setTasks(await window.electronAPI!.tasks.list(tokenRef.current))
    } catch { /* l'erreur est déjà visible via l'UI appelante */ }
  }, [pushUndo])

  const addTask = useCallback((input: CreateTaskInput): Promise<Task | null> =>
    (async () => {
      try {
        const created = await window.electronAPI!.tasks.create(tokenRef.current, input)
        setTasks(await window.electronAPI!.tasks.list(tokenRef.current))
        return created
      } catch { return null }
    })(), [])

  const updateTask = useCallback((id: string, changes: UpdateTaskInput): Promise<void> =>
    mutate(async token => {
      const previous = await window.electronAPI!.tasks.get(token, id)
      await window.electronAPI!.tasks.update(token, id, changes)
      return previous
    }), [mutate])

  const setStatus = useCallback((id: string, status: TaskStatus, blockedReason?: string | null): Promise<void> =>
    updateTask(id, status === 'blocked'
      ? { status, blockedReason: blockedReason ?? 'Raison non précisée.' }
      : { status }), [updateTask])

  const completeTask = useCallback((id: string): Promise<void> =>
    mutate(async token => {
      const previous = await window.electronAPI!.tasks.get(token, id)
      await window.electronAPI!.tasks.complete(token, id)
      return previous
    }), [mutate])

  const removeTask = useCallback((id: string): Promise<void> =>
    mutate(async token => {
      const previous = await window.electronAPI!.tasks.get(token, id)
      await window.electronAPI!.tasks.remove(token, id)
      return previous
    }), [mutate])

  const undoLast = useCallback(async (): Promise<boolean> => {
    const snapshot = undoStack.current.pop()
    if (!snapshot) return false
    try {
      await window.electronAPI?.tasks.restoreSnapshot(tokenRef.current, snapshot)
      setTasks(await window.electronAPI!.tasks.list(tokenRef.current))
      return true
    } catch { return false }
  }, [])

  const clearCompleted = useCallback(async (): Promise<void> => {
    for (const task of tasks.filter(entry => entry.status === 'completed')) pushUndo(task)
    try {
      await window.electronAPI?.tasks.clearCompleted(tokenRef.current)
      setTasks(await window.electronAPI!.tasks.list(tokenRef.current))
    } catch { /* silencieux */ }
  }, [tasks, pushUndo])

  const grouped = useMemo(() => ({
    todo: tasks.filter(task => task.status === 'todo'),
    inProgress: tasks.filter(task => task.status === 'in_progress'),
    blocked: tasks.filter(task => task.status === 'blocked'),
    completed: tasks.filter(task => task.status === 'completed'),
  }), [tasks])

  /** Tâche mise en avant : la première « en cours » sinon la plus urgente ouverte. */
  const activeTask = useMemo((): Task | null => {
    const priorityWeight: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 }
    return grouped.inProgress[0]
      ?? [...grouped.blocked, ...grouped.todo].sort(
        (a, b) => priorityWeight[a.priority] - priorityWeight[b.priority],
      )[0]
      ?? null
  }, [grouped])

  const counts = useMemo(() => ({
    total: tasks.length,
    open: tasks.length - grouped.completed.length,
    done: grouped.completed.length,
  }), [tasks, grouped.completed.length])

  return {
    tasks,
    loaded,
    grouped,
    counts,
    activeTask,
    addTask,
    updateTask,
    setStatus,
    completeTask,
    removeTask,
    undoLast,
    canUndo: () => undoStack.current.length > 0,
    clearCompleted,
    reload,
  }
}

export type TasksApi = ReturnType<typeof useTasks>
