import fs from 'node:fs/promises'
import path from 'node:path'
import { detectCheckCommands } from '../agent/tools/analysis.js'
import { isBinaryPath, walkWorkspace, type WalkEntry } from '../agent/workspace.js'
import { detectPreviewTarget } from './detect.js'
import type {
  DependencyEntry,
  LanguageBreakdown,
  ProjectAnalysis,
  ProjectIssue,
  ScriptEntry,
} from './types.js'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.astro': 'Astro',
  '.json': 'JSON',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.html': 'HTML',
  '.md': 'Markdown',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.java': 'Java',
  '.cs': 'C#',
  '.php': 'PHP',
  '.rb': 'Ruby',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.bat': 'Batch',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.sql': 'SQL',
  '.toml': 'TOML',
}

/** Files large enough that counting their lines is not worth the read. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024
const COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro'])

export function languageOf(relativePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? ''
}

/**
 * Counts components in a source file.
 *
 * Single-file formats (.vue, .svelte, .astro) are one component each. For
 * React, exported function/class/const declarations whose name is capitalised
 * are counted, which is the convention React itself enforces.
 */
function countComponents(relativePath: string, content: string): number {
  const extension = path.extname(relativePath).toLowerCase()
  if (extension === '.vue' || extension === '.svelte' || extension === '.astro') return 1
  if (extension !== '.tsx' && extension !== '.jsx') return 0

  const names = new Set<string>()
  const patterns = [
    /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+function\s+([A-Z][A-Za-z0-9_]*)/g,
    /export\s+(?:const|let)\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/g,
    /export\s+class\s+([A-Z][A-Za-z0-9_]*)/g,
    /^\s*function\s+([A-Z][A-Za-z0-9_]*)\s*\(/gm,
    /^\s*const\s+([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/gm,
  ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) names.add(match[1])
  }

  // `export default function () {}` has no name but is still a component.
  if (names.size === 0 && /export\s+default\s+(?:function|\()/.test(content)) return 1
  return names.size
}

async function readJson(target: string): Promise<{ value: Record<string, unknown> | null; error: string | null }> {
  let raw: string
  try {
    raw = await fs.readFile(target, 'utf8')
  } catch {
    return { value: null, error: null }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, error: `${path.basename(target)} ne contient pas un objet JSON` }
    }
    return { value: parsed as Record<string, unknown>, error: null }
  } catch (error: unknown) {
    return {
      value: null,
      error: `${path.basename(target)} est invalide: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Static checks that do not require running a build. */
async function structuralIssues(workspace: string, entries: WalkEntry[]): Promise<ProjectIssue[]> {
  const issues: ProjectIssue[] = []
  const relativePaths = new Set(entries.filter(entry => entry.kind === 'file').map(entry => entry.relativePath))

  for (const name of ['package.json', 'tsconfig.json']) {
    const { error } = await readJson(path.join(workspace, name))
    if (error) issues.push({ severity: 'error', file: name, message: error, source: 'structure' })
  }

  // Local references in HTML that point at files which do not exist. The user
  // sees a broken page otherwise, with nothing in the console explaining why.
  for (const entry of entries) {
    if (entry.kind !== 'file' || path.extname(entry.relativePath).toLowerCase() !== '.html') continue
    if (entry.size > MAX_COUNTED_BYTES) continue

    let html: string
    try {
      html = await fs.readFile(entry.absolutePath, 'utf8')
    } catch {
      continue
    }

    const references = new Set<string>()
    const pattern = /(?:href|src)\s*=\s*["']([^"']+)["']/gi
    let match: RegExpExecArray | null
    while ((match = pattern.exec(html)) !== null) references.add(match[1])

    for (const reference of references) {
      if (/^([a-z]+:|\/\/|#|data:|mailto:|tel:)/i.test(reference)) continue
      const cleaned = reference.split(/[?#]/)[0]
      if (cleaned.length === 0) continue
      const base = path.posix.dirname(entry.relativePath)
      const resolved = path.posix.normalize(
        cleaned.startsWith('/')
          ? cleaned.replace(/^\/+/, '')
          : base === '.' ? cleaned : `${base}/${cleaned}`,
      )
      if (resolved.startsWith('..')) continue
      if (relativePaths.has(resolved)) continue
      // Framework projects resolve paths through their bundler, so a missing
      // file there is not necessarily a real problem.
      issues.push({
        severity: 'warning',
        file: entry.relativePath,
        message: `Référence introuvable: ${reference}`,
        source: 'structure',
      })
    }
  }

  return issues
}

export interface AnalyzeOptions {
  workspace: string
  /** Directory to inspect for previewability; empty means auto-detect. */
  previewPath?: string
  maxEntries?: number
}

/**
 * Builds the full project report shown in the Analyse tab.
 *
 * Line and component counts require reading the files, so the walk is capped
 * and oversized files are counted as zero lines rather than being loaded.
 */
export async function analyzeProject(options: AnalyzeOptions): Promise<ProjectAnalysis> {
  const workspace = path.resolve(options.workspace)
  const maxEntries = Math.min(20000, Math.max(200, options.maxEntries ?? 6000))

  const { entries, truncated } = await walkWorkspace(workspace, workspace, {
    maxDepth: 8,
    maxEntries,
  })

  const languageStats = new Map<string, { files: number; lines: number }>()
  let files = 0
  let directories = 0
  let lines = 0
  let components = 0
  let bytes = 0

  for (const entry of entries) {
    if (entry.kind === 'directory') {
      directories += 1
      continue
    }
    files += 1
    bytes += entry.size

    const language = languageOf(entry.relativePath)
    const extension = path.extname(entry.relativePath).toLowerCase()
    let fileLines = 0

    if (!isBinaryPath(entry.absolutePath) && entry.size <= MAX_COUNTED_BYTES) {
      try {
        const content = await fs.readFile(entry.absolutePath, 'utf8')
        if (!content.includes('\u0000')) {
          fileLines = content.length === 0 ? 0 : content.split('\n').length
          lines += fileLines
          if (COMPONENT_EXTENSIONS.has(extension)) {
            components += countComponents(entry.relativePath, content)
          }
        }
      } catch {
        fileLines = 0
      }
    }

    if (language.length > 0) {
      const current = languageStats.get(language) ?? { files: 0, lines: 0 }
      current.files += 1
      current.lines += fileLines
      languageStats.set(language, current)
    }
  }

  const target = await detectPreviewTarget(workspace, options.previewPath ?? '')
  const { value: manifest, error: manifestError } = await readJson(path.join(workspace, 'package.json'))

  const dependencies = stringRecord(manifest?.dependencies)
  const devDependencies = stringRecord(manifest?.devDependencies)
  const dependencyList: DependencyEntry[] = [
    ...Object.entries(dependencies).map(([name, version]) => ({ name, version, dev: false })),
    ...Object.entries(devDependencies).map(([name, version]) => ({ name, version, dev: true })),
  ].sort((a, b) => Number(a.dev) - Number(b.dev) || a.name.localeCompare(b.name))

  const scripts: ScriptEntry[] = Object.entries(stringRecord(manifest?.scripts))
    .map(([name, command]) => ({ name, command }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const issues = await structuralIssues(workspace, entries)
  if (manifestError && !issues.some(issue => issue.message === manifestError)) {
    issues.push({ severity: 'error', file: 'package.json', message: manifestError, source: 'structure' })
  }
  if (target.manifestError) {
    issues.push({
      severity: 'error',
      file: path.posix.join(target.relativeRoot === '.' ? '' : target.relativeRoot, 'package.json'),
      message: target.manifestError,
      source: 'structure',
    })
  }
  if (target.needsInstall) {
    issues.push({
      severity: 'warning',
      file: null,
      message: 'Les dépendances ne sont pas installées (node_modules absent). Lance l\'installation avant de prévisualiser.',
      source: 'structure',
    })
  }

  const languages: LanguageBreakdown[] = Array.from(languageStats.entries())
    .map(([language, stats]) => ({ language, files: stats.files, lines: stats.lines }))
    .sort((a, b) => b.files - a.files || a.language.localeCompare(b.language))

  const typeLabel = target.kind === 'unknown' ? 'Projet' : target.framework
  const name = typeof manifest?.name === 'string' && manifest.name.trim().length > 0
    ? manifest.name.trim()
    : path.basename(workspace)

  return {
    name,
    workspace,
    kind: target.kind,
    framework: target.framework,
    typeLabel,
    stats: { files, directories, lines, components, bytes },
    languages,
    dependencies: dependencyList,
    scripts,
    checkCommands: await detectCheckCommands(workspace),
    issues,
    state: issues.some(issue => issue.severity === 'error') ? 'FAIL' : 'PASS',
    preview: {
      previewable: target.previewable,
      relativeRoot: target.relativeRoot,
      servedBy: target.servedBy,
      command: target.command,
      hint: target.hint,
    },
    truncated,
    analyzedAt: Date.now(),
  }
}
