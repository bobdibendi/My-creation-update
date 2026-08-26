import fs from 'node:fs/promises'
import path from 'node:path'

/** Directories that never contribute useful context and would explode traversals. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.vite',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.avif',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pyc', '.class', '.o', '.a', '.lib', '.pdb',
])

export function isBinaryPath(target: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(target).toLowerCase())
}

/** Normalizes a model-provided path to a POSIX-style workspace-relative path. */
export function toRelative(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute)
  return relative.length === 0 ? '.' : relative.split(path.sep).join('/')
}

/**
 * Resolves a model-provided path inside the workspace.
 * Rejects traversal (`../`), absolute paths outside the root, and symlink escapes.
 */
export async function resolveInWorkspace(workspace: string, input: string): Promise<string> {
  const root = path.resolve(workspace)
  const cleaned = input.trim().replace(/^[/\\]+/, '')
  const candidate = cleaned.length === 0 ? root : path.resolve(root, cleaned)

  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Chemin hors du workspace: ${input}`)
  }

  // Walk up to the nearest existing ancestor and compare real paths so that a
  // symlinked directory cannot be used to escape the root.
  const realRoot = await fs.realpath(root)
  let probe = candidate
  while (true) {
    try {
      const real = await fs.realpath(probe)
      const realRelative = path.relative(realRoot, real)
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error(`Chemin hors du workspace: ${input}`)
      }
      return candidate
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = path.dirname(probe)
      if (parent === probe) return candidate
      probe = parent
    }
  }
}

export interface WalkEntry {
  relativePath: string
  absolutePath: string
  kind: 'file' | 'directory'
  size: number
}

export interface WalkOptions {
  maxDepth: number
  maxEntries: number
  includeHidden?: boolean
}

/** Breadth-limited recursive walk that skips ignored and hidden directories. */
export async function walkWorkspace(
  root: string,
  start: string,
  options: WalkOptions,
): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const entries: WalkEntry[] = []
  let truncated = false

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > options.maxDepth) return
    let listing
    try {
      listing = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    listing.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))

    for (const item of listing) {
      if (entries.length >= options.maxEntries) {
        truncated = true
        return
      }
      if (IGNORED_DIRECTORIES.has(item.name)) continue
      if (!options.includeHidden && item.name.startsWith('.')) continue

      const absolutePath = path.join(dir, item.name)
      const isDirectory = item.isDirectory()
      let size = 0
      if (!isDirectory) {
        try { size = (await fs.stat(absolutePath)).size } catch { size = 0 }
      }
      entries.push({
        relativePath: toRelative(root, absolutePath),
        absolutePath,
        kind: isDirectory ? 'directory' : 'file',
        size,
      })
      if (isDirectory) await visit(absolutePath, depth + 1)
    }
  }

  await visit(start, 0)
  return { entries, truncated }
}
