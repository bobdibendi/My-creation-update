import fs from 'node:fs/promises'
import path from 'node:path'
import type { Tool } from '../types.js'
import { asRecord, objectSchema, optionalNumber, optionalString } from '../validate.js'
import { resolveInWorkspace, toRelative, walkWorkspace } from '../workspace.js'
import { runShellCommand } from './terminal.js'

interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const MANIFESTS = [
  'package.json',
  'tsconfig.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
  'Makefile',
  'Dockerfile',
  'docker-compose.yml',
]

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.json': 'JSON',
  '.css': 'CSS',
  '.scss': 'SCSS',
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
}

async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8')) as T
  } catch {
    return null
  }
}

async function readTextIfSmall(target: string, maxBytes: number): Promise<string | null> {
  try {
    const stats = await fs.stat(target)
    if (stats.size > maxBytes) return null
    return await fs.readFile(target, 'utf8')
  } catch {
    return null
  }
}

/** Returns the check commands that actually exist for this project. */
export async function detectCheckCommands(workspace: string): Promise<string[]> {
  const manifest = await readJson<PackageManifest>(path.join(workspace, 'package.json'))
  if (!manifest) return []
  const scripts = manifest.scripts ?? {}
  const ordered = ['typecheck', 'type-check', 'tsc', 'lint', 'build', 'test']
  const commands: string[] = []
  for (const name of ordered) {
    if (typeof scripts[name] === 'string' && scripts[name].trim().length > 0) {
      commands.push(`npm run ${name}`)
    }
  }
  return commands
}

function analyzeProject(): Tool {
  return {
    name: 'analyzeProject',
    description: 'Analyse la structure du workspace: langages, arborescence, manifestes, scripts npm et dépendances. À utiliser avant toute modification importante.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Dossier à analyser (défaut ".").' },
      maxDepth: { type: 'integer', description: 'Profondeur de l\'arborescence retournée (défaut 3, max 6).' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'analyzeProject')
      const startInput = optionalString(record, 'path', '.')
      const maxDepth = optionalNumber(record, 'maxDepth', 3, 1, 6)
      const start = await resolveInWorkspace(context.workspace, startInput)

      const { entries, truncated } = await walkWorkspace(context.workspace, start, {
        maxDepth: maxDepth - 1,
        maxEntries: 1500,
      })

      const languages = new Map<string, number>()
      let fileCount = 0
      let directoryCount = 0
      let totalBytes = 0

      for (const entry of entries) {
        if (entry.kind === 'directory') {
          directoryCount += 1
          continue
        }
        fileCount += 1
        totalBytes += entry.size
        const language = LANGUAGE_BY_EXTENSION[path.extname(entry.relativePath).toLowerCase()]
        if (language) languages.set(language, (languages.get(language) ?? 0) + 1)
      }

      const manifests: Array<{ path: string; summary: unknown }> = []
      for (const name of MANIFESTS) {
        const target = path.join(context.workspace, name)
        const content = await readTextIfSmall(target, 256 * 1024)
        if (content === null) continue

        if (name === 'package.json') {
          const parsed = JSON.parse(content) as PackageManifest
          manifests.push({
            path: name,
            summary: {
              name: parsed.name,
              version: parsed.version,
              type: parsed.type ?? 'commonjs',
              main: parsed.main,
              scripts: parsed.scripts ?? {},
              dependencies: Object.keys(parsed.dependencies ?? {}),
              devDependencies: Object.keys(parsed.devDependencies ?? {}),
            },
          })
        } else {
          manifests.push({ path: name, summary: content.slice(0, 1200) })
        }
      }

      const readme = await readTextIfSmall(path.join(context.workspace, 'README.md'), 64 * 1024)

      return {
        workspace: path.basename(context.workspace),
        root: toRelative(context.workspace, start),
        truncated,
        stats: { files: fileCount, directories: directoryCount, totalBytes },
        languages: Array.from(languages.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([language, files]) => ({ language, files })),
        tree: entries.map(entry => `${entry.kind === 'directory' ? '[d] ' : '[f] '}${entry.relativePath}`),
        manifests,
        checkCommands: await detectCheckCommands(context.workspace),
        readmeExcerpt: readme ? readme.slice(0, 1500) : null,
      }
    },
  }
}

function checkProject(): Tool {
  return {
    name: 'checkProject',
    description: 'Exécute les vérifications du projet (typecheck, lint, build, test selon les scripts npm disponibles) et renvoie les erreurs détectées. À utiliser pour diagnostiquer puis vérifier une correction.',
    mutates: true,
    parameters: objectSchema({
      command: { type: 'string', description: 'Commande de vérification précise. Si omis, les scripts npm détectés sont utilisés.' },
      timeoutSeconds: { type: 'integer', description: 'Délai maximal par commande en secondes (défaut 300, max 900).' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'checkProject')
      const explicit = optionalString(record, 'command', '')
      const timeoutMs = optionalNumber(record, 'timeoutSeconds', 300, 10, 900) * 1000

      const commands = explicit.length > 0 ? [explicit] : await detectCheckCommands(context.workspace)
      if (commands.length === 0) {
        return {
          ran: [],
          allPassed: true,
          note: 'Aucun script de vérification détecté (pas de package.json ou pas de scripts typecheck/lint/build/test).',
        }
      }

      const results: Array<{
        command: string
        exitCode: number | null
        success: boolean
        durationMs: number
        output: string
      }> = []

      for (const command of commands) {
        if (context.signal.aborted) throw new Error('Vérification annulée')
        context.onProgress(`Vérification: ${command}`)
        const outcome = await runShellCommand({
          command,
          cwd: context.workspace,
          timeoutMs,
          signal: context.signal,
        })
        const combined = `${outcome.stdout}\n${outcome.stderr}`.trim()
        results.push({
          command,
          exitCode: outcome.exitCode,
          success: outcome.success,
          durationMs: outcome.durationMs,
          output: combined.slice(-8000),
        })
        if (!outcome.success) break
      }

      return {
        ran: results,
        allPassed: results.every(result => result.success),
      }
    },
  }
}

export function createAnalysisTools(): Tool[] {
  return [analyzeProject(), checkProject()]
}
