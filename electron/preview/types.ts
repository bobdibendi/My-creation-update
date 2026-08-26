// Preview and project-analysis types — electron-side definition.
// The renderer mirrors them in src/shared/types.ts.

/** Project families the preview pipeline knows how to serve. */
export type ProjectKind =
  | 'html'
  | 'vite'
  | 'react'
  | 'next'
  | 'astro'
  | 'vue'
  | 'svelte'
  | 'node'
  | 'unknown'

/** How a project is served: by the built-in static server or by its own dev command. */
export type ServedBy = 'static' | 'command'

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** Everything detection could establish about a previewable directory. */
export interface PreviewTarget {
  /** Absolute directory that gets served. */
  root: string
  /** Same directory, workspace-relative and POSIX-style ('.' for the root). */
  relativeRoot: string
  kind: ProjectKind
  /** Human-readable framework label, shown in the UI. */
  framework: string
  servedBy: ServedBy
  /** Dev command for `servedBy === 'command'`, empty otherwise. */
  command: string
  /** Port probed when the dev command does not announce its URL. */
  defaultPort: number
  /** Entry HTML file, workspace-relative, when there is one. */
  entryFile: string | null
  packageManager: PackageManager
  /** True when a package.json exists but node_modules does not. */
  needsInstall: boolean
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  manifestName: string | null
  /** Set when package.json exists but could not be parsed. */
  manifestError: string | null
  /** Why this kind was chosen, so the UI can explain the decision. */
  reasons: string[]
  previewable: boolean
  /** Actionable message when `previewable` is false. */
  hint: string
}

export type PreviewState = 'idle' | 'installing' | 'starting' | 'running' | 'error' | 'stopped'

export interface PreviewStatus {
  state: PreviewState
  workspace: string | null
  target: PreviewTarget | null
  /** URL that actually answered an HTTP request. */
  url: string | null
  command: string | null
  pid: number | null
  message: string
  /** Tail of the dev-server output. */
  log: string[]
  startedAt: number | null
  readyAt: number | null
}

export interface PreviewCapture {
  /** Absolute path of the written PNG. */
  path: string
  /** Workspace-relative path, POSIX-style: '.preview/latest.png'. */
  relativePath: string
  /** PNG as a data URL so the renderer can display it under a strict CSP. */
  dataUrl: string
  width: number
  height: number
  bytes: number
  url: string
  capturedAt: number
}

export type PreviewEvent =
  | { type: 'status'; status: PreviewStatus }
  | { type: 'log'; line: string }
  | { type: 'reload'; reason: string }
  | { type: 'screenshot'; capture: PreviewCapture }

/** Preview lifecycle surface used by the agent tools. */
export interface PreviewService {
  detect(workspace: string, relativePath: string): Promise<PreviewTarget>
  start(input: { workspace: string; relativePath: string; install: boolean }): Promise<PreviewStatus>
  stop(): Promise<PreviewStatus>
  status(): PreviewStatus
}

// ─── Project analysis ──────────────────────────────────
export interface LanguageBreakdown {
  language: string
  files: number
  lines: number
}

export interface DependencyEntry {
  name: string
  version: string
  dev: boolean
}

export interface ScriptEntry {
  name: string
  command: string
}

/** One problem found by the analysis, from any source. */
export interface ProjectIssue {
  severity: 'error' | 'warning'
  /** Workspace-relative file when known. */
  file: string | null
  message: string
  /** Where the issue came from: 'structure' (static checks) or a command name. */
  source: string
}

export interface ProjectAnalysis {
  name: string
  workspace: string
  kind: ProjectKind
  framework: string
  /** Combined label shown in the UI, e.g. "React + Vite". */
  typeLabel: string
  stats: {
    files: number
    directories: number
    lines: number
    components: number
    bytes: number
  }
  languages: LanguageBreakdown[]
  dependencies: DependencyEntry[]
  scripts: ScriptEntry[]
  checkCommands: string[]
  issues: ProjectIssue[]
  /** 'PASS' when no error-level issue was found. */
  state: 'PASS' | 'FAIL'
  preview: {
    previewable: boolean
    relativeRoot: string
    servedBy: ServedBy
    command: string
    hint: string
  }
  truncated: boolean
  analyzedAt: number
}

// ─── Project graph ─────────────────────────────────────
export interface GraphNode {
  id: string
  label: string
  kind: 'file' | 'directory'
  /** 0 for the root node. */
  depth: number
  /** Child files/directories, already sorted. */
  children: GraphNode[]
  /** Number of descendants collapsed away when the tree was capped. */
  hiddenChildren: number
  /** Language label for files, empty for directories. */
  language: string
}

export interface ProjectGraph {
  root: GraphNode
  /** ASCII rendering, used in agent summaries. */
  ascii: string
  nodeCount: number
  truncated: boolean
}
