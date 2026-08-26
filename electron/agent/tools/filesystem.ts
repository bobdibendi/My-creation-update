import fs from 'node:fs/promises'
import path from 'node:path'
import type { Tool, ToolContext } from '../types.js'
import { asRecord, objectSchema, optionalBoolean, optionalNumber, optionalString, requireString, requireText } from '../validate.js'
import { isBinaryPath, resolveInWorkspace, toRelative, walkWorkspace } from '../workspace.js'

const MAX_READ_BYTES = 512 * 1024
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024

async function statOrNull(target: string): Promise<import('node:fs').Stats | null> {
  try { return await fs.stat(target) } catch { return null }
}

function listDirectory(): Tool {
  return {
    name: 'listDirectory',
    description: 'Liste le contenu d\'un dossier du workspace. Utilise "." pour la racine. Passe recursive=true pour explorer les sous-dossiers.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin relatif au workspace. "." pour la racine.' },
      recursive: { type: 'boolean', description: 'Explorer les sous-dossiers (profondeur limitée).' },
      maxDepth: { type: 'integer', description: 'Profondeur maximale quand recursive=true (1 à 8, défaut 3).' },
    }, ['path']),
    async execute(args, context) {
      const record = asRecord(args, 'listDirectory')
      const input = optionalString(record, 'path', '.')
      const recursive = optionalBoolean(record, 'recursive', false)
      const maxDepth = optionalNumber(record, 'maxDepth', 3, 1, 8)
      const target = await resolveInWorkspace(context.workspace, input)

      const stats = await statOrNull(target)
      if (!stats) throw new Error(`Dossier introuvable: ${input}`)
      if (!stats.isDirectory()) throw new Error(`Ce chemin n'est pas un dossier: ${input}`)

      const { entries, truncated } = await walkWorkspace(context.workspace, target, {
        maxDepth: recursive ? maxDepth - 1 : 0,
        maxEntries: recursive ? 800 : 300,
      })

      return {
        path: toRelative(context.workspace, target),
        recursive,
        truncated,
        count: entries.length,
        entries: entries.map(entry => ({
          path: entry.relativePath,
          kind: entry.kind,
          ...(entry.kind === 'file' ? { size: entry.size } : {}),
        })),
      }
    },
  }
}

function readFile(): Tool {
  return {
    name: 'readFile',
    description: 'Lit un fichier texte du workspace. Renvoie le contenu numéroté par ligne pour faciliter les modifications.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin du fichier relatif au workspace.' },
      startLine: { type: 'integer', description: 'Première ligne à lire (1 par défaut).' },
      endLine: { type: 'integer', description: 'Dernière ligne à lire (fin du fichier par défaut).' },
    }, ['path']),
    async execute(args, context) {
      const record = asRecord(args, 'readFile')
      const input = requireString(record, 'path')
      const target = await resolveInWorkspace(context.workspace, input)

      const stats = await statOrNull(target)
      if (!stats) throw new Error(`Fichier introuvable: ${input}`)
      if (stats.isDirectory()) throw new Error(`Ce chemin est un dossier, utilise listDirectory: ${input}`)
      if (isBinaryPath(target)) throw new Error(`Fichier binaire non lisible en texte: ${input}`)
      if (stats.size > MAX_READ_BYTES) {
        throw new Error(`Fichier trop volumineux (${stats.size} octets). Lis une plage avec startLine/endLine.`)
      }

      const content = await fs.readFile(target, 'utf8')
      const lines = content.split('\n')
      const startLine = optionalNumber(record, 'startLine', 1, 1, Math.max(1, lines.length))
      const endLine = optionalNumber(record, 'endLine', lines.length, startLine, lines.length)
      const slice = lines.slice(startLine - 1, endLine)

      return {
        path: toRelative(context.workspace, target),
        totalLines: lines.length,
        startLine,
        endLine,
        content: slice.map((line, index) => `${startLine + index}\t${line}`).join('\n'),
      }
    },
  }
}

function writeFile(): Tool {
  return {
    name: 'writeFile',
    description: 'Crée ou remplace intégralement un fichier du workspace. Les dossiers parents sont créés automatiquement.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin du fichier relatif au workspace.' },
      content: { type: 'string', description: 'Contenu complet du fichier.' },
    }, ['path', 'content']),
    async execute(args, context) {
      const record = asRecord(args, 'writeFile')
      const input = requireString(record, 'path')
      const content = requireText(record, 'content')
      const target = await resolveInWorkspace(context.workspace, input)

      const stats = await statOrNull(target)
      if (stats?.isDirectory()) throw new Error(`Ce chemin est un dossier: ${input}`)

      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content, 'utf8')

      return {
        path: toRelative(context.workspace, target),
        created: stats === null,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
      }
    },
  }
}

function editFile(): Tool {
  return {
    name: 'editFile',
    description: 'Remplace une portion exacte de texte dans un fichier existant. Préférable à writeFile pour une modification ciblée.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin du fichier relatif au workspace.' },
      oldText: { type: 'string', description: 'Texte exact à remplacer (doit être unique sauf si replaceAll=true).' },
      newText: { type: 'string', description: 'Texte de remplacement.' },
      replaceAll: { type: 'boolean', description: 'Remplacer toutes les occurrences (défaut false).' },
    }, ['path', 'oldText', 'newText']),
    async execute(args, context) {
      const record = asRecord(args, 'editFile')
      const input = requireString(record, 'path')
      const oldText = requireText(record, 'oldText')
      const newText = requireText(record, 'newText')
      const replaceAll = optionalBoolean(record, 'replaceAll', false)
      if (oldText.length === 0) throw new Error('oldText ne peut pas être vide')
      if (oldText === newText) throw new Error('oldText et newText sont identiques')

      const target = await resolveInWorkspace(context.workspace, input)
      const stats = await statOrNull(target)
      if (!stats) throw new Error(`Fichier introuvable: ${input}`)
      if (stats.isDirectory()) throw new Error(`Ce chemin est un dossier: ${input}`)

      const content = await fs.readFile(target, 'utf8')
      const occurrences = content.split(oldText).length - 1
      if (occurrences === 0) throw new Error(`Texte introuvable dans ${input}. Relis le fichier avec readFile.`)
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`${occurrences} occurrences trouvées dans ${input}. Ajoute du contexte ou utilise replaceAll=true.`)
      }

      const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
      await fs.writeFile(target, updated, 'utf8')

      return {
        path: toRelative(context.workspace, target),
        replacements: replaceAll ? occurrences : 1,
        lines: updated.split('\n').length,
      }
    },
  }
}

function createDirectory(): Tool {
  return {
    name: 'createDirectory',
    description: 'Crée un dossier du workspace, y compris les dossiers parents manquants.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin du dossier relatif au workspace.' },
    }, ['path']),
    async execute(args, context) {
      const record = asRecord(args, 'createDirectory')
      const input = requireString(record, 'path')
      const target = await resolveInWorkspace(context.workspace, input)

      const stats = await statOrNull(target)
      if (stats && !stats.isDirectory()) throw new Error(`Un fichier existe déjà à ce chemin: ${input}`)

      await fs.mkdir(target, { recursive: true })
      return { path: toRelative(context.workspace, target), created: stats === null }
    },
  }
}

function deleteFile(): Tool {
  return {
    name: 'deleteFile',
    description: 'Supprime un fichier ou un dossier du workspace. Passe recursive=true pour un dossier non vide.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin à supprimer, relatif au workspace.' },
      recursive: { type: 'boolean', description: 'Autoriser la suppression récursive d\'un dossier.' },
    }, ['path']),
    async execute(args, context) {
      const record = asRecord(args, 'deleteFile')
      const input = requireString(record, 'path')
      const recursive = optionalBoolean(record, 'recursive', false)
      const target = await resolveInWorkspace(context.workspace, input)

      if (path.resolve(target) === path.resolve(context.workspace)) {
        throw new Error('Suppression de la racine du workspace refusée')
      }

      const stats = await statOrNull(target)
      if (!stats) throw new Error(`Chemin introuvable: ${input}`)
      if (stats.isDirectory() && !recursive) {
        const listing = await fs.readdir(target)
        if (listing.length > 0) throw new Error(`Dossier non vide (${listing.length} éléments). Utilise recursive=true.`)
      }

      await fs.rm(target, { recursive: stats.isDirectory(), force: false })
      return { path: toRelative(context.workspace, target), kind: stats.isDirectory() ? 'directory' : 'file', deleted: true }
    },
  }
}

function renameFile(): Tool {
  return {
    name: 'renameFile',
    description: 'Renomme un fichier ou un dossier sans changer son emplacement.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin actuel relatif au workspace.' },
      newName: { type: 'string', description: 'Nouveau nom, sans chemin.' },
    }, ['path', 'newName']),
    async execute(args, context) {
      const record = asRecord(args, 'renameFile')
      const input = requireString(record, 'path')
      const newName = requireString(record, 'newName')
      if (/[\\/]/.test(newName)) throw new Error('newName doit être un nom simple. Utilise moveFile pour déplacer.')

      const source = await resolveInWorkspace(context.workspace, input)
      const stats = await statOrNull(source)
      if (!stats) throw new Error(`Chemin introuvable: ${input}`)

      const destination = await resolveInWorkspace(context.workspace, path.join(path.dirname(input), newName))
      if (await statOrNull(destination)) throw new Error(`Un élément existe déjà: ${newName}`)

      await fs.rename(source, destination)
      return {
        from: toRelative(context.workspace, source),
        to: toRelative(context.workspace, destination),
        kind: stats.isDirectory() ? 'directory' : 'file',
      }
    },
  }
}

function moveFile(): Tool {
  return {
    name: 'moveFile',
    description: 'Déplace un fichier ou un dossier vers un autre emplacement du workspace.',
    mutates: true,
    parameters: objectSchema({
      from: { type: 'string', description: 'Chemin source relatif au workspace.' },
      to: { type: 'string', description: 'Chemin destination relatif au workspace.' },
    }, ['from', 'to']),
    async execute(args, context) {
      const record = asRecord(args, 'moveFile')
      const fromInput = requireString(record, 'from')
      const toInput = requireString(record, 'to')

      const source = await resolveInWorkspace(context.workspace, fromInput)
      const destination = await resolveInWorkspace(context.workspace, toInput)
      const sourceStats = await statOrNull(source)
      if (!sourceStats) throw new Error(`Source introuvable: ${fromInput}`)
      if (await statOrNull(destination)) throw new Error(`Destination déjà occupée: ${toInput}`)

      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.rename(source, destination)
      return {
        from: toRelative(context.workspace, source),
        to: toRelative(context.workspace, destination),
        kind: sourceStats.isDirectory() ? 'directory' : 'file',
      }
    },
  }
}

function pathExists(): Tool {
  return {
    name: 'pathExists',
    description: 'Vérifie si un chemin existe dans le workspace et indique s\'il s\'agit d\'un fichier ou d\'un dossier.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Chemin relatif au workspace.' },
    }, ['path']),
    async execute(args, context) {
      const record = asRecord(args, 'pathExists')
      const input = requireString(record, 'path')
      const target = await resolveInWorkspace(context.workspace, input)
      const stats = await statOrNull(target)
      return {
        path: toRelative(context.workspace, target),
        exists: stats !== null,
        kind: stats === null ? null : stats.isDirectory() ? 'directory' : 'file',
        size: stats && !stats.isDirectory() ? stats.size : undefined,
      }
    },
  }
}

function searchInFiles(): Tool {
  return {
    name: 'searchInFiles',
    description: 'Recherche un texte ou une expression régulière dans les fichiers du workspace et renvoie les lignes correspondantes.',
    mutates: false,
    parameters: objectSchema({
      query: { type: 'string', description: 'Texte ou expression régulière à rechercher.' },
      path: { type: 'string', description: 'Dossier de départ (défaut ".").' },
      regex: { type: 'boolean', description: 'Interpréter query comme expression régulière.' },
      caseSensitive: { type: 'boolean', description: 'Respecter la casse (défaut false).' },
      maxResults: { type: 'integer', description: 'Nombre maximal de correspondances (défaut 60, max 300).' },
    }, ['query']),
    async execute(args, context) {
      const record = asRecord(args, 'searchInFiles')
      const query = requireString(record, 'query')
      const startInput = optionalString(record, 'path', '.')
      const useRegex = optionalBoolean(record, 'regex', false)
      const caseSensitive = optionalBoolean(record, 'caseSensitive', false)
      const maxResults = optionalNumber(record, 'maxResults', 60, 1, 300)

      const start = await resolveInWorkspace(context.workspace, startInput)
      const flags = caseSensitive ? 'g' : 'gi'
      const pattern = useRegex
        ? new RegExp(query, flags)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

      const { entries } = await walkWorkspace(context.workspace, start, { maxDepth: 8, maxEntries: 4000 })
      const matches: Array<{ path: string; line: number; text: string }> = []
      let scanned = 0

      for (const entry of entries) {
        if (matches.length >= maxResults) break
        if (context.signal.aborted) throw new Error('Recherche annulée')
        if (entry.kind !== 'file' || isBinaryPath(entry.absolutePath) || entry.size > MAX_SEARCH_FILE_BYTES) continue

        let content: string
        try { content = await fs.readFile(entry.absolutePath, 'utf8') } catch { continue }
        scanned += 1
        if (content.includes('\u0000')) continue

        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          pattern.lastIndex = 0
          if (!pattern.test(lines[index])) continue
          matches.push({ path: entry.relativePath, line: index + 1, text: lines[index].trim().slice(0, 240) })
          if (matches.length >= maxResults) break
        }
      }

      return { query, scannedFiles: scanned, matchCount: matches.length, matches }
    },
  }
}

function findFiles(): Tool {
  return {
    name: 'findFiles',
    description: 'Trouve les fichiers du workspace dont le nom ou le chemin contient un motif.',
    mutates: false,
    parameters: objectSchema({
      pattern: { type: 'string', description: 'Fragment de nom ou motif glob simple (ex: "*.ts", "main").' },
      path: { type: 'string', description: 'Dossier de départ (défaut ".").' },
      maxResults: { type: 'integer', description: 'Nombre maximal de résultats (défaut 120, max 500).' },
    }, ['pattern']),
    async execute(args, context) {
      const record = asRecord(args, 'findFiles')
      const rawPattern = requireString(record, 'pattern')
      const startInput = optionalString(record, 'path', '.')
      const maxResults = optionalNumber(record, 'maxResults', 120, 1, 500)
      const start = await resolveInWorkspace(context.workspace, startInput)

      const escaped = rawPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      const globbed = escaped.includes('*') || escaped.includes('?')
        ? `^${escaped.split('*').join('[^/]*').split('?').join('.')}$`
        : escaped
      const matcher = new RegExp(globbed, 'i')

      const { entries, truncated } = await walkWorkspace(context.workspace, start, { maxDepth: 8, maxEntries: 5000 })
      const files = entries
        .filter(entry => entry.kind === 'file')
        .filter(entry => matcher.test(entry.relativePath) || matcher.test(path.basename(entry.relativePath)))
        .slice(0, maxResults)
        .map(entry => ({ path: entry.relativePath, size: entry.size }))

      return { pattern: rawPattern, count: files.length, truncated, files }
    },
  }
}

export function createFilesystemTools(): Tool[] {
  return [
    listDirectory(),
    readFile(),
    writeFile(),
    editFile(),
    createDirectory(),
    deleteFile(),
    renameFile(),
    moveFile(),
    pathExists(),
    searchInFiles(),
    findFiles(),
  ]
}

export type { ToolContext }
