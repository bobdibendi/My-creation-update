// Shared types — définitions côté electron (miroir renderer : src/shared/types.ts).

export type {
  DependencyEntry,
  GraphNode,
  LanguageBreakdown,
  PackageManager,
  PreviewCapture,
  PreviewEvent,
  PreviewState,
  PreviewStatus,
  PreviewTarget,
  ProjectAnalysis,
  ProjectGraph,
  ProjectIssue,
  ProjectKind,
  ScriptEntry,
  ServedBy,
} from './preview/types.js'

import type {
  PreviewCapture,
  PreviewEvent,
  PreviewStatus,
  PreviewTarget,
  ProjectAnalysis,
  ProjectGraph,
} from './preview/types.js'

// --- File system ---------------------------------------
export interface FileNode {
  name: string
  path: string
  kind: 'file' | 'directory'
}

// --- Chat ----------------------------------------------
export type AIMessageRole = 'user' | 'assistant'

export interface AIMessage {
  role: AIMessageRole
  content: string
}

export interface AIChatRequest {
  messages: AIMessage[]
  model: string
  workspace?: string | null
  activeFilePath?: string
  activeFileExcerpt?: string
  /** Session token: identifies the account for quota accounting. */
  sessionToken?: string
}

export type AIStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'text'; requestId: string; text: string }
  /** Delta de raisonnement d'un modèle « thinking » : indicateur, pas réponse. */
  | { type: 'reasoning'; requestId: string; text: string }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; message: string }

// --- Agent ---------------------------------------------
export interface AgentStartInput {
  prompt: string
  model: string
  workspace: string
  activeFilePath?: string
  activeFileExcerpt?: string
  history?: AIMessage[]
  /** Session token: identifies the account for quota accounting. */
  sessionToken?: string
}

export type AgentEvent =
  | { type: 'status'; sessionId: string; text: string }
  | { type: 'text'; sessionId: string; text: string }
  | { type: 'tool-call'; sessionId: string; id: string; tool: string; args: unknown }
  | { type: 'tool-result'; sessionId: string; id: string; tool: string; success: boolean; summary: string }
  | { type: 'files-changed'; sessionId: string; workspace: string }
  | { type: 'done'; sessionId: string; text: string; turns: number; toolCalls: number }
  | { type: 'error'; sessionId: string; message: string }

// --- Terminal ------------------------------------------
export interface TerminalDataPayload {
  id: string
  data: string
}

export interface TerminalExitPayload {
  id: string
  code: number | null
}

export interface TerminalErrorPayload {
  id: string
  message: string
}

/** Shell flavours offered by the integrated terminal. */
export type TerminalKind = 'cmd' | 'powershell'

// --- Abonnement IA & quota -----------------------------
export type UsageKind = 'chat' | 'agent' | 'other'

export interface PlanInfo {
  id: PlanType
  name: string
  /** Jetons par jour ; `null` = quota non défini (configurable). */
  dailyTokenLimit: number | null
  features: string[]
  price: string
  description: string
}

export interface QuotaPeriodInfo {
  start: number
  end: number
  key: string
}

export interface KindUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

export interface UsageSummary {
  plan: PlanInfo
  period: QuotaPeriodInfo
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

export interface QuotaAlertPayload {
  threshold: number
  summary: UsageSummary
}

// --- Package -------------------------------------------
export interface PackageProgressPayload {
  stage: string
  line: string
}

export interface PackageCompletePayload {
  installerPath: string
  version: string | null
  productName: string
}

export interface PackageErrorPayload {
  message: string
}

// --- Git -----------------------------------------------
export interface GitRepositoryInfo {
  /** Absolute path of the repository that owns the opened folder. */
  root: string
  /** False when the opened folder is a subdirectory of the repository. */
  isRoot: boolean
}

// --- Providers -----------------------------------------
export interface ProviderKeyStatus {
  success: boolean
  provider: string
  configured: boolean
  maskedKey?: string
  error?: string
}

export interface ProviderModelInfo {
  id: string
  label: string
  provider: string
  supportsTools: boolean
}

export interface ProviderInfo {
  id: string
  name: string
  configured: boolean
  /** 'free' = intégré (Kim Pro, Ox Alpha Free) ; 'premium' = clé personnelle. */
  tier: 'free' | 'premium'
  models: ProviderModelInfo[]
}

// --- Permissions ---------------------------------------
export type PlanType = 'free' | 'pro' | 'pro_ultimate'

export interface Permissions {
  chat: boolean
  agent: boolean
  /** Modèle intégré Kim Pro — tous les plans. */
  builtinFreeModels: boolean
  /** Modèle intégré Ox Alpha — PRO et supérieur. */
  oxAlphaModels: boolean
  /** Modèles premium (clé personnelle) — PRO ULTIMATE. */
  premiumModels: boolean
  advancedTools: boolean
  priorityAccess: boolean
}

export interface PermissionsInfo {
  planId: PlanType
  planName: string
  permissions: Permissions
  dailyTokenLimit: number | null
}

// --- Auth & License ------------------------------------
export interface User {
  id: number
  email: string
  name: string
  createdAt: number
}

export interface AuthResult {
  success: boolean
  error?: string
  user?: User
  sessionToken?: string
  /** Compte créé mais confirmation email requise (réservé Supabase côté renderer). */
  pendingConfirmation?: boolean
}

export interface SessionInfo {
  user: User
  expiresAt: number
}

export interface LicenseInfo {
  id: number
  type: string
  product: string
  version: string | null
  activatedAt: number
  expiresAt: number | null
}

export interface LicenseStatus {
  active: boolean
  type: string | null
  expiresAt: number | null
  /** Source de la licence : interne (My Creation) ou Gumroad. */
  source?: 'my-creation' | 'gumroad' | null
  /** Plan d'adhésion porté par la licence, si déterminé. */
  plan?: 'free' | 'pro' | 'pro_ultimate' | null
  error?: string
}

export interface ActivateLicenseResult {
  success: boolean
  error?: string
  license?: LicenseInfo
}

// --- Tasks (Todo) --------------------------------------
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

export interface ActionLogEntry {
  id: number
  kind: string
  label: string
  detail: string | null
  createdAt: number
}

/** Payload diffusé à chaque mutation : la liste complète remplace l'état local. */
export interface TasksChangedPayload {
  tasks: Task[]
  origin: 'user' | 'ai'
}

// --- Preload surface -----------------------------------
export interface SystemVersions {
  app: string
  electron: string
  /** Vrai hors app packagée : mécanismes liés à la distribution désactivés. */
  devMode: boolean
}

/** Événement de la machine à états de mise à jour (canal update:event). */
export interface UpdateEventPayload {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

export interface ElectronAPI {
  system: {
    /** Version de l'app = version de l'installateur (source unique). */
    getVersions(): Promise<SystemVersions>
    /** Journal de diagnostic persistant (%APPDATA%/logs/ai-crash.log). */
    log(line: string): Promise<void>
    /** Export JSON des données utilisateur via dialogue natif. */
    exportData(payload: string): Promise<{ saved: boolean; path?: string }>
    /** Import JSON via dialogue natif ; le renderer valide avant application. */
    importData(): Promise<{ loaded: boolean; payload?: string }>
  }
  window: {
    minimize(): Promise<void>
    maximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    openDevTools(): Promise<void>
    onMaximized(callback: (maximized: boolean) => void): () => void
  }
  git: {
    status(cwd: string): Promise<string>
    branches(cwd: string): Promise<string[]>
    root(cwd: string): Promise<GitRepositoryInfo | null>
    run(cwd: string, args: string[]): Promise<string>
  }
  files: {
    openFolder(): Promise<string | null>
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    list(path: string): Promise<FileNode[]>
    listRecursive(path: string): Promise<FileNode[]>
    create(parentPath: string, name: string, isDir: boolean): Promise<FileNode>
    delete(targetPath: string): Promise<void>
    rename(oldPath: string, newName: string): Promise<FileNode>
    exists(filePath: string): Promise<boolean>
  }
  terminal: {
    create(cwd: string | null, kind?: TerminalKind): Promise<string>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    onData(callback: (payload: TerminalDataPayload) => void): () => void
    onExit(callback: (payload: TerminalExitPayload) => void): () => void
    onError(callback: (payload: TerminalErrorPayload) => void): () => void
  }
  api: {
    storeKey(provider: string, key: string): Promise<ProviderKeyStatus>
    checkKey(provider: string): Promise<ProviderKeyStatus>
    deleteKey(provider: string): Promise<ProviderKeyStatus>
    /** Catalogue complet sans jeton ; filtré selon le plan avec un jeton. */
    listProviders(sessionToken?: string | null): Promise<ProviderInfo[]>
  }
  ai: {
    chat(request: AIChatRequest): Promise<{ requestId: string }>
    cancel(requestId?: string): Promise<void>
    onChunk(callback: (event: AIStreamEvent) => void): () => void
  }
  agent: {
    start(input: AgentStartInput): Promise<{ sessionId: string }>
    cancel(sessionId: string): Promise<void>
    onEvent(callback: (event: AgentEvent) => void): () => void
  }
  planEvents: {
    /** Poussé après activation/expiration/changement de profil. */
    onUpdate(callback: (payload: { reason: string; licenseType?: string }) => void): () => void
  }
  preview: {
    detect(workspace: string, relativePath?: string): Promise<PreviewTarget>
    candidates(workspace: string): Promise<PreviewTarget[]>
    start(workspace: string, relativePath?: string, install?: boolean): Promise<PreviewStatus>
    stop(): Promise<PreviewStatus>
    status(): Promise<PreviewStatus>
    capture(input: { workspace: string; url?: string; width?: number; height?: number }): Promise<PreviewCapture>
    latestCapture(workspace: string): Promise<PreviewCapture | null>
    openExternal(url: string): Promise<boolean>
    onEvent(callback: (event: PreviewEvent) => void): () => void
  }
  project: {
    analyze(workspace: string, relativePath?: string): Promise<ProjectAnalysis>
    graph(workspace: string, relativePath?: string, maxDepth?: number): Promise<ProjectGraph>
  }
  auth: {
    register(email: string, password: string, name: string): Promise<AuthResult>
    login(email: string, password: string): Promise<AuthResult>
    logout(sessionToken: string): Promise<void>
    getSession(sessionToken: string): Promise<SessionInfo | null>
    /**
     * Pont Supabase : synchronise l'identité vérifiée par Supabase Auth dans la
     * base locale (liaison ou création, FREE par défaut) et retourne une
     * session SQLite pour la chaîne licence/quota/tâches existante.
     */
    ensureSupabase(identity: { supabaseId: string; email: string; name?: string | null }): Promise<AuthResult>
    /** Profil réel (SQLite) : nom et/ou e-mail. */
    updateProfile(
      sessionToken: string,
      changes: { name?: string; email?: string },
    ): Promise<{ success: boolean; error?: string; user?: User }>
    /**
     * Changement de mot de passe réel (bcrypt). Révoque les autres sessions
     * et retourne une NOUVELLE sessionToken à conserver.
     */
    changePassword(
      sessionToken: string,
      currentPassword: string,
      newPassword: string,
    ): Promise<{ success: boolean; error?: string; sessionToken?: string }>
    /**
     * Callback de confirmation e-mail (deep link mycreation://) :
     * récupère l'URL en attente au démarrage du renderer, sinon null.
     * L'URL est consommée par cet appel ; les liens reçus pendant que
     * l'application tourne arrivent via onAuthCallback.
     */
    takeAuthCallback(): Promise<string | null>
    /** Deep link d'authentification reçu pendant que l'application tourne. */
    onAuthCallback(callback: (url: string) => void): () => void
  }
  agentExtra: {
    /** Déconnexion pendant une requête : coupe tout. */
    cancelAll(): Promise<boolean>
  }
  license: {
    activate(sessionToken: string, licenseKey: string): Promise<ActivateLicenseResult>
    /** Active une licence Gumroad (lifetime) — vérification côté main. */
    activateGumroad(sessionToken: string, licenseKey: string): Promise<ActivateLicenseResult>
    getStatus(sessionToken: string): Promise<LicenseStatus>
    getLicenses(sessionToken: string): Promise<LicenseInfo[]>
    /** Désactive les licences locales du compte -> retour FREE immédiat. */
    deactivate(sessionToken: string): Promise<{ success: boolean; removed?: number }>
  }
  subscription: {
    /** Plan IA actif du compte (FREE par défaut, PRO/PRO ULTIMATE via licence). */
    getPlan(sessionToken: string): Promise<{ plan: PlanInfo; dailyTokenLimit: number | null; percentUsed: number | null; licenseType: string | null; licenseExpiresAt: number | null }>
    usage(sessionToken: string): Promise<UsageSummary>
    plans(): Promise<PlanInfo[]>
    // Aucun canal d'achat : les adhésions MY CREATION passent par le
    // License Generator administrateur, jamais par un site externe.
    onUpdate(callback: (summary: UsageSummary) => void): () => void
    onAlert(callback: (payload: QuotaAlertPayload) => void): () => void
  }
  permissions: {
    /** Droits effectifs du compte (plan + licence), évalués côté main. */
    get(sessionToken: string): Promise<PermissionsInfo>
  }
  tasks: {
    list(sessionToken: string | null, includeCompleted?: boolean): Promise<Task[]>
    get(sessionToken: string | null, id: string): Promise<Task | null>
    create(
      sessionToken: string | null,
      input: CreateTaskInput & { source?: TaskSource },
    ): Promise<Task>
    update(sessionToken: string | null, id: string, changes: UpdateTaskInput): Promise<Task>
    complete(sessionToken: string | null, id: string): Promise<Task>
    reopen(sessionToken: string | null, id: string): Promise<Task>
    remove(sessionToken: string | null, id: string): Promise<boolean>
    restoreSnapshot(sessionToken: string | null, snapshot: Task): Promise<Task>
    clearCompleted(sessionToken: string | null): Promise<number>
    activityLog(sessionToken: string | null, limit?: number): Promise<ActionLogEntry[]>
    /** Temps réel : poussé après chaque mutation (utilisateur ou IA). */
    onChange(callback: (payload: TasksChangedPayload) => void): () => void
  }
  package: {
    start(sessionToken: string, workspace: string): Promise<{ started: boolean }>
    cancel(): Promise<boolean>
    open(installerPath: string): Promise<boolean>
    showInFolder(installerPath: string): Promise<boolean>
    onProgress(callback: (payload: PackageProgressPayload) => void): () => void
    onComplete(callback: (payload: PackageCompletePayload) => void): () => void
    onError(callback: (payload: PackageErrorPayload) => void): () => void
  }
  updates: {
    /** Faux en développement (app non packagée) : le mécanisme est inerte. */
    supported(): Promise<boolean>
    getState(): Promise<UpdateEventPayload>
    check(): Promise<{ supported: boolean }>
    download(): Promise<{ supported: boolean }>
    install(): Promise<{ supported: boolean }>
    /** Machine à états poussée par le main : checking/available/downloading/downloaded/error. */
    onEvent(callback: (event: UpdateEventPayload) => void): () => void
  }
}
