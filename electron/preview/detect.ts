import fs from 'node:fs/promises'
import path from 'node:path'
import { IGNORED_DIRECTORIES, resolveInWorkspace, toRelative } from '../agent/workspace.js'
import type { PackageManager, PreviewTarget, ProjectKind, ServedBy } from './types.js'

interface Manifest {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** Config file names that identify a framework on their own. */
const CONFIG_SIGNATURES: Array<{ pattern: RegExp; kind: ProjectKind; framework: string }> = [
  { pattern: /^next\.config\.(js|cjs|mjs|ts)$/i, kind: 'next', framework: 'Next.js' },
  { pattern: /^astro\.config\.(js|cjs|mjs|ts)$/i, kind: 'astro', framework: 'Astro' },
  { pattern: /^nuxt\.config\.(js|cjs|mjs|ts)$/i, kind: 'vue', framework: 'Nuxt' },
  { pattern: /^svelte\.config\.(js|cjs|mjs|ts)$/i, kind: 'svelte', framework: 'SvelteKit' },
  { pattern: /^vue\.config\.(js|cjs|mjs|ts)$/i, kind: 'vue', framework: 'Vue CLI' },
  { pattern: /^vite\.config\.(js|cjs|mjs|ts|mts|cts)$/i, kind: 'vite', framework: 'Vite' },
]

/** Dependency names that identify a framework, most specific first. */
const DEPENDENCY_SIGNATURES: Array<{ name: string; kind: ProjectKind; framework: string }> = [
  { name: 'next', kind: 'next', framework: 'Next.js' },
  { name: 'astro', kind: 'astro', framework: 'Astro' },
  { name: 'nuxt', kind: 'vue', framework: 'Nuxt' },
  { name: '@sveltejs/kit', kind: 'svelte', framework: 'SvelteKit' },
  { name: 'svelte', kind: 'svelte', framework: 'Svelte' },
  { name: 'vue', kind: 'vue', framework: 'Vue' },
  { name: 'react', kind: 'react', framework: 'React' },
]

const DEFAULT_PORTS: Record<ProjectKind, number> = {
  html: 0,
  vite: 5173,
  react: 5173,
  next: 3000,
  astro: 4321,
  vue: 5173,
  svelte: 5173,
  node: 3000,
  unknown: 0,
}

/** Dev scripts tried in order; the first one present wins. */
const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview']

const ENTRY_CANDIDATES = ['index.html', 'public/index.html', 'src/index.html', 'dist/index.html']

async function readManifest(dir: string): Promise<{ manifest: Manifest | null; error: string | null }> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, 'package.json'), 'utf8')
  } catch {
    return { manifest: null, error: null }
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { manifest: null, error: 'package.json ne contient pas un objet JSON' }
    }
    return { manifest: parsed as Manifest, error: null }
  } catch (error: unknown) {
    return { manifest: null, error: `package.json illisible: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map(entry => entry.name)
  } catch {
    return []
  }
}

async function detectPackageManager(dir: string): Promise<PackageManager> {
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function runScript(manager: PackageManager, script: string): string {
  if (manager === 'pnpm') return `pnpm run ${script}`
  if (manager === 'yarn') return `yarn ${script}`
  return `npm run ${script}`
}

export function installCommand(manager: PackageManager): string {
  if (manager === 'pnpm') return 'pnpm install'
  if (manager === 'yarn') return 'yarn install'
  return 'npm install'
}

/** Records only strings, so a malformed manifest cannot inject objects downstream. */
function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

async function findEntryFile(dir: string): Promise<string | null> {
  for (const candidate of ENTRY_CANDIDATES) {
    if (await exists(path.join(dir, candidate))) return candidate
  }
  return null
}

/**
 * Classifies a single directory.
 *
 * Config files win over dependencies: a project can depend on `react` while
 * being served by Next.js, and the config file is the stronger signal.
 */
export async function describeDirectory(workspace: string, dir: string): Promise<PreviewTarget> {
  const relativeRoot = toRelative(workspace, dir)
  const { manifest, error: manifestError } = await readManifest(dir)
  const names = await listNames(dir)
  const packageManager = await detectPackageManager(dir)
  const scripts = stringRecord(manifest?.scripts)
  const dependencies = stringRecord(manifest?.dependencies)
  const devDependencies = stringRecord(manifest?.devDependencies)
  const allDependencies = { ...dependencies, ...devDependencies }
  const entryFile = await findEntryFile(dir)
  const reasons: string[] = []

  let kind: ProjectKind = 'unknown'
  let framework = 'inconnu'

  for (const signature of CONFIG_SIGNATURES) {
    const found = names.find(name => signature.pattern.test(name))
    if (!found) continue
    kind = signature.kind
    framework = signature.framework
    reasons.push(`${found} détecté`)
    break
  }

  if (kind === 'unknown' || kind === 'vite') {
    for (const signature of DEPENDENCY_SIGNATURES) {
      if (!allDependencies[signature.name]) continue
      reasons.push(`dépendance ${signature.name}`)
      if (kind === 'vite') {
        // Vite plus a UI library: keep Vite's tooling, refine the label.
        framework = `${signature.framework} + Vite`
        if (signature.kind === 'react') kind = 'react'
        break
      }
      kind = signature.kind
      framework = signature.framework
      break
    }
  }

  if (kind === 'unknown' && manifest && allDependencies['vite']) {
    kind = 'vite'
    framework = 'Vite'
    reasons.push('dépendance vite')
  }

  if (kind === 'unknown' && entryFile) {
    kind = 'html'
    framework = 'HTML/CSS/JS'
    reasons.push(`${entryFile} détecté`)
  }

  if (kind === 'unknown' && manifest) {
    kind = 'node'
    framework = 'Node.js'
    reasons.push('package.json sans framework web reconnu')
  }

  const devScript = DEV_SCRIPTS.find(name => typeof scripts[name] === 'string' && scripts[name].trim().length > 0) ?? null

  // A static entry file with no dev script is served by the built-in server:
  // spawning a package manager would fail with nothing to run.
  let servedBy: ServedBy = 'static'
  let command = ''
  if (devScript && kind !== 'html') {
    servedBy = 'command'
    command = runScript(packageManager, devScript)
    reasons.push(`script "${devScript}"`)
  } else if (devScript && kind === 'html' && !entryFile) {
    servedBy = 'command'
    command = runScript(packageManager, devScript)
  }

  const needsInstall = manifest !== null
    && Object.keys(allDependencies).length > 0
    && !(await exists(path.join(dir, 'node_modules')))

  let previewable = true
  let hint = ''
  if (servedBy === 'static' && !entryFile) {
    previewable = false
    hint = manifest
      ? 'Aucun fichier index.html et aucun script de développement (dev, start, serve, preview) dans package.json.'
      : 'Aucun fichier index.html et aucun package.json: rien à prévisualiser dans ce dossier.'
  }
  if (manifestError) {
    previewable = false
    hint = manifestError
  }

  return {
    root: dir,
    relativeRoot,
    kind,
    framework,
    servedBy,
    command,
    defaultPort: DEFAULT_PORTS[kind],
    entryFile,
    packageManager,
    needsInstall,
    scripts,
    dependencies,
    devDependencies,
    manifestName: typeof manifest?.name === 'string' ? manifest.name : null,
    manifestError,
    reasons,
    previewable,
    hint,
  }
}

/** Ranks a candidate: framework projects beat static pages, shallow beats deep. */
function score(target: PreviewTarget): number {
  if (!target.previewable) return -1
  const depth = target.relativeRoot === '.' ? 0 : target.relativeRoot.split('/').length
  const kindBonus = target.servedBy === 'command' ? 40 : 20
  const entryBonus = target.entryFile ? 10 : 0
  const rootBonus = depth === 0 ? 15 : 0
  return kindBonus + entryBonus + rootBonus - depth * 5
}

/**
 * Finds previewable directories: the workspace root first, then subdirectories
 * up to `maxDepth`. The agent commonly writes a site into `site/` or `web/`,
 * so a root-only scan would miss what it just created.
 */
export async function findPreviewTargets(workspace: string, maxDepth = 2): Promise<PreviewTarget[]> {
  const root = path.resolve(workspace)
  const found: PreviewTarget[] = []
  const seen = new Set<string>()

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= 24) return
    const key = path.resolve(dir)
    if (seen.has(key)) return
    seen.add(key)

    const described = await describeDirectory(root, dir)
    if (described.previewable) found.push(described)
    if (depth >= maxDepth) return

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue
      await visit(path.join(dir, entry.name), depth + 1)
    }
  }

  await visit(root, 0)
  return found.sort((a, b) => score(b) - score(a))
}

/**
 * Resolves the directory to preview.
 * An empty `relativePath` means "choose automatically".
 */
export async function detectPreviewTarget(workspace: string, relativePath: string): Promise<PreviewTarget> {
  const root = path.resolve(workspace)
  const requested = relativePath.trim()

  if (requested.length > 0 && requested !== '.') {
    const dir = await resolveInWorkspace(root, requested)
    return describeDirectory(root, dir)
  }

  const candidates = await findPreviewTargets(root)
  if (candidates.length > 0) return candidates[0]

  // Nothing previewable: report the root so the UI can explain why.
  return describeDirectory(root, root)
}
