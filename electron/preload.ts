import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AIChatRequest,
  AIStreamEvent,
  AgentEvent,
  AgentStartInput,
  ElectronAPI,
  PackageCompletePayload,
  PackageErrorPayload,
  PackageProgressPayload,
  PreviewEvent,
  QuotaAlertPayload,
  TasksChangedPayload,
  TerminalDataPayload,
  TerminalErrorPayload,
  TerminalExitPayload,
  TerminalKind,
  UpdateEventPayload,
  UsageSummary,
} from './types.js'/** Subscribes to a main-process channel and returns an unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: ElectronAPI = {
  system: {
    getVersions: () => ipcRenderer.invoke('system:get-versions'),
    log: line => ipcRenderer.invoke('diag:log', line),
    exportData: payload => ipcRenderer.invoke('data:export', payload),
    importData: () => ipcRenderer.invoke('data:import'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    openDevTools: () => ipcRenderer.invoke('window:devtools'),
    onMaximized: callback => subscribe<boolean>('window:maximized', callback),
  },

  git: {
    status: cwd => ipcRenderer.invoke('git:status', cwd),
    branches: cwd => ipcRenderer.invoke('git:branches', cwd),
    root: cwd => ipcRenderer.invoke('git:root', cwd),
    run: (cwd, args) => ipcRenderer.invoke('git:run', cwd, args),
  },

  files: {
    openFolder: () => ipcRenderer.invoke('files:open-folder'),
    read: target => ipcRenderer.invoke('files:read', target),
    write: (target, content) => ipcRenderer.invoke('files:write', target, content),
    list: target => ipcRenderer.invoke('files:list', target),
    listRecursive: target => ipcRenderer.invoke('files:list-recursive', target),
    create: (parent, name, isDir) => ipcRenderer.invoke('files:create', parent, name, isDir),
    delete: target => ipcRenderer.invoke('files:delete', target),
    rename: (target, newName) => ipcRenderer.invoke('files:rename', target, newName),
    exists: target => ipcRenderer.invoke('files:exists', target),
  },

  terminal: {
    create: (cwd, kind?: TerminalKind) => ipcRenderer.invoke('terminal:create', cwd, kind ?? 'cmd'),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: id => ipcRenderer.invoke('terminal:kill', id),
    onData: callback => subscribe<TerminalDataPayload>('terminal:data', callback),
    onExit: callback => subscribe<TerminalExitPayload>('terminal:exit', callback),
    onError: callback => subscribe<TerminalErrorPayload>('terminal:error', callback),
  },

  api: {
    storeKey: (provider, key) => ipcRenderer.invoke('api:storeKey', provider, key),
    checkKey: provider => ipcRenderer.invoke('api:checkKey', provider),
    deleteKey: provider => ipcRenderer.invoke('api:deleteKey', provider),
    // Avec un jeton de session : catalogue filtré par le plan du compte.
    listProviders: sessionToken => ipcRenderer.invoke('api:listProviders', sessionToken ?? null),
  },

  ai: {
    chat: (request: AIChatRequest) => ipcRenderer.invoke('ai:chat', request),
    cancel: requestId => ipcRenderer.invoke('ai:cancel', requestId),
    onChunk: callback => subscribe<AIStreamEvent>('ai:chunk', callback),
  },

  agent: {
    start: (input: AgentStartInput) => ipcRenderer.invoke('agent:start', input),
    cancel: sessionId => ipcRenderer.invoke('agent:cancel', sessionId),
    onEvent: callback => subscribe<AgentEvent>('agent:event', callback),
  },

  preview: {
    detect: (workspace, relativePath) => ipcRenderer.invoke('preview:detect', workspace, relativePath ?? ''),
    candidates: workspace => ipcRenderer.invoke('preview:candidates', workspace),
    start: (workspace, relativePath, install) =>
      ipcRenderer.invoke('preview:start', workspace, relativePath ?? '', install !== false),
    stop: () => ipcRenderer.invoke('preview:stop'),
    status: () => ipcRenderer.invoke('preview:status'),
    capture: input => ipcRenderer.invoke('preview:capture', input),
    latestCapture: workspace => ipcRenderer.invoke('preview:latest-capture', workspace),
    openExternal: url => ipcRenderer.invoke('preview:open-external', url),
    onEvent: callback => subscribe<PreviewEvent>('preview:event', callback),
  },

  project: {
    analyze: (workspace, relativePath) => ipcRenderer.invoke('project:analyze', workspace, relativePath ?? ''),
    graph: (workspace, relativePath, maxDepth) =>
      ipcRenderer.invoke('project:graph', workspace, relativePath ?? '', maxDepth),
  },

  auth: {
    register: (email, password, name) => ipcRenderer.invoke('auth:register', email, password, name),
    login: (email, password) => ipcRenderer.invoke('auth:login', email, password),
    logout: sessionToken => ipcRenderer.invoke('auth:logout', sessionToken),
    getSession: sessionToken => ipcRenderer.invoke('auth:get-session', sessionToken),
    ensureSupabase: identity => ipcRenderer.invoke('auth:ensure-supabase', identity),
    updateProfile: (sessionToken, changes) => ipcRenderer.invoke('auth:update-profile', sessionToken, changes),
    changePassword: (sessionToken, currentPassword, newPassword) =>
      ipcRenderer.invoke('auth:change-password', sessionToken, currentPassword, newPassword),
    takeAuthCallback: () => ipcRenderer.invoke('auth:take-auth-callback'),
    onAuthCallback: callback => subscribe<string>('auth:callback', callback),
  },

  agentExtra: {
    cancelAll: () => ipcRenderer.invoke('agent:cancel-all'),
  },

  planEvents: {
    onUpdate: callback => subscribe<{ reason: string; licenseType?: string }>('plan:update', callback),
  },

  license: {
    activate: (sessionToken, licenseKey) => ipcRenderer.invoke('license:activate', sessionToken, licenseKey),
    activateGumroad: (sessionToken, licenseKey) =>
      ipcRenderer.invoke('license:activate-gumroad', sessionToken, licenseKey),
    getStatus: sessionToken => ipcRenderer.invoke('license:get-status', sessionToken),
    getLicenses: sessionToken => ipcRenderer.invoke('license:get-licenses', sessionToken),
    deactivate: sessionToken => ipcRenderer.invoke('license:deactivate', sessionToken),
  },

  subscription: {
    getPlan: sessionToken => ipcRenderer.invoke('subscription:get', sessionToken),
    usage: sessionToken => ipcRenderer.invoke('subscription:usage', sessionToken),
    plans: () => ipcRenderer.invoke('subscription:plans'),
    onUpdate: callback => subscribe<UsageSummary>('quota:update', callback),
    onAlert: callback => subscribe<QuotaAlertPayload>('quota:alert', callback),
  },

  permissions: {
    get: sessionToken => ipcRenderer.invoke('permissions:get', sessionToken),
  },

  tasks: {
    list: (sessionToken, includeCompleted = true) =>
      ipcRenderer.invoke('tasks:list', sessionToken, includeCompleted),
    get: (sessionToken, id) => ipcRenderer.invoke('tasks:get', sessionToken, id),
    create: (sessionToken, input) => ipcRenderer.invoke('tasks:create', sessionToken, input),
    update: (sessionToken, id, changes) => ipcRenderer.invoke('tasks:update', sessionToken, id, changes),
    complete: (sessionToken, id) => ipcRenderer.invoke('tasks:complete', sessionToken, id),
    reopen: (sessionToken, id) => ipcRenderer.invoke('tasks:reopen', sessionToken, id),
    remove: (sessionToken, id) => ipcRenderer.invoke('tasks:remove', sessionToken, id),
    restoreSnapshot: (sessionToken, snapshot) => ipcRenderer.invoke('tasks:restore', sessionToken, snapshot),
    clearCompleted: sessionToken => ipcRenderer.invoke('tasks:clear-completed', sessionToken),
    activityLog: (sessionToken, limit) => ipcRenderer.invoke('tasks:activity-log', sessionToken, limit),
    onChange: callback => subscribe<TasksChangedPayload>('tasks:changed', callback),
  },

  package: {
    start: (sessionToken, workspace) => ipcRenderer.invoke('package:start', sessionToken, workspace),
    cancel: () => ipcRenderer.invoke('package:cancel'),
    open: installerPath => ipcRenderer.invoke('package:open', installerPath),
    showInFolder: installerPath => ipcRenderer.invoke('package:show-in-folder', installerPath),
    onProgress: callback => subscribe<PackageProgressPayload>('package:progress', callback),
    onComplete: callback => subscribe<PackageCompletePayload>('package:complete', callback),
    onError: callback => subscribe<PackageErrorPayload>('package:error', callback),
  },

  updates: {
    supported: () => ipcRenderer.invoke('update:supported'),
    getState: () => ipcRenderer.invoke('update:get-state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: callback => subscribe<UpdateEventPayload>('update:event', callback),
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)
