import path from 'node:path'
import type { Tool } from '../types.js'
import { asRecord, objectSchema, optionalBoolean, optionalNumber, optionalString } from '../validate.js'
import { analyzeProject as buildAnalysis } from '../../preview/analyze.js'
import { buildProjectGraph } from '../../preview/graph.js'
import { PreviewManager } from '../../preview/manager.js'
import type { PreviewCapture, PreviewStatus, PreviewTarget } from '../../preview/types.js'

/**
 * The subset of the preview lifecycle the agent may drive.
 *
 * The application injects its own manager so a preview started by the agent
 * shows up in the Preview tab. Tests and headless runs get a standalone manager
 * from `defaultPreviewBridge`, so the tools always do real work.
 */
export interface PreviewToolBridge {
  detect(workspace: string, relativePath: string): Promise<PreviewTarget>
  candidates(workspace: string): Promise<PreviewTarget[]>
  start(input: { workspace: string; relativePath: string; install: boolean }): Promise<PreviewStatus>
  stop(): Promise<PreviewStatus>
  status(): PreviewStatus
  capture(input: { url?: string; workspace?: string; width?: number; height?: number }): Promise<PreviewCapture>
}

let fallbackManager: PreviewManager | null = null

/** Lazily created manager used when no application manager is supplied. */
export function defaultPreviewBridge(): PreviewToolBridge {
  if (!fallbackManager) fallbackManager = new PreviewManager({ emit: () => {} })
  return fallbackManager
}

/** Releases the fallback manager; used by tests and on shutdown. */
export async function disposeDefaultPreviewBridge(): Promise<void> {
  const manager = fallbackManager
  fallbackManager = null
  if (manager) await manager.dispose()
}

function summarizeTarget(target: PreviewTarget) {
  return {
    dossier: target.relativeRoot,
    type: target.kind,
    framework: target.framework,
    servi_par: target.servedBy === 'command' ? `commande: ${target.command}` : 'serveur statique intégré',
    fichier_entree: target.entryFile,
    dependances_a_installer: target.needsInstall,
    gestionnaire: target.packageManager,
    previsualisable: target.previewable,
    raisons: target.reasons,
    ...(target.previewable ? {} : { probleme: target.hint }),
  }
}

function summarizeStatus(status: PreviewStatus) {
  return {
    etat: status.state,
    url: status.url,
    commande: status.command,
    message: status.message,
    dossier: status.target?.relativeRoot ?? null,
    framework: status.target?.framework ?? null,
    journal: status.log.slice(-20),
  }
}

function detectPreview(bridge: PreviewToolBridge): Tool {
  return {
    name: 'detectPreview',
    description: 'Détecte les dossiers prévisualisables du workspace (HTML statique, Vite, React, Next.js, Astro, Vue, Svelte) sans rien démarrer. À utiliser pour savoir ce qui peut être affiché dans l\'onglet Aperçu.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Dossier à examiner, relatif au workspace. Omis = détection automatique.' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'detectPreview')
      const input = optionalString(record, 'path', '')

      if (input.length > 0) {
        return { cible: summarizeTarget(await bridge.detect(context.workspace, input)) }
      }

      const candidates = await bridge.candidates(context.workspace)
      const best = await bridge.detect(context.workspace, '')
      return {
        recommande: summarizeTarget(best),
        candidats: candidates.slice(0, 8).map(summarizeTarget),
      }
    },
  }
}

function startPreview(bridge: PreviewToolBridge): Tool {
  return {
    name: 'startPreview',
    description: 'Démarre l\'aperçu du projet et l\'affiche dans l\'onglet Aperçu de l\'éditeur. Sert un site statique via le serveur intégré, ou lance le script de développement (npm run dev) pour un projet Vite/React/Next/Astro/Vue/Svelte. Renvoie l\'URL locale. À utiliser après avoir créé ou modifié un site.',
    mutates: true,
    parameters: objectSchema({
      path: { type: 'string', description: 'Dossier à servir, relatif au workspace. Omis = détection automatique.' },
      install: { type: 'boolean', description: 'Installer les dépendances si node_modules est absent (défaut true).' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'startPreview')
      const input = optionalString(record, 'path', '')
      const install = optionalBoolean(record, 'install', true)

      context.onProgress('Démarrage de l\'aperçu')
      const status = await bridge.start({ workspace: context.workspace, relativePath: input, install })

      if (status.state !== 'running') {
        throw new Error(`L'aperçu n'a pas démarré: ${status.message}`)
      }
      context.onProgress(`Aperçu prêt: ${status.url}`)
      return summarizeStatus(status)
    },
  }
}

function stopPreview(bridge: PreviewToolBridge): Tool {
  return {
    name: 'stopPreview',
    description: 'Arrête l\'aperçu en cours et libère le serveur de développement.',
    mutates: false,
    parameters: objectSchema({}),
    async execute() {
      return summarizeStatus(await bridge.stop())
    },
  }
}

function previewStatus(bridge: PreviewToolBridge): Tool {
  return {
    name: 'previewStatus',
    description: 'Renvoie l\'état de l\'aperçu en cours: URL, commande, journal du serveur de développement.',
    mutates: false,
    parameters: objectSchema({}),
    async execute() {
      return summarizeStatus(bridge.status())
    },
  }
}

function capturePreviewTool(bridge: PreviewToolBridge): Tool {
  return {
    name: 'capturePreview',
    description: 'Prend une capture d\'écran de l\'aperçu en cours et l\'enregistre dans .preview/latest.png. L\'image est affichée dans l\'onglet Analyse. À utiliser après startPreview pour montrer visuellement le résultat.',
    mutates: true,
    parameters: objectSchema({
      url: { type: 'string', description: 'URL à capturer. Omis = URL de l\'aperçu en cours.' },
      width: { type: 'integer', description: 'Largeur de la fenêtre de capture (défaut 1280).' },
      height: { type: 'integer', description: 'Hauteur de la fenêtre de capture (défaut 800).' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'capturePreview')
      const url = optionalString(record, 'url', '')
      const width = optionalNumber(record, 'width', 1280, 320, 2560)
      const height = optionalNumber(record, 'height', 800, 240, 2560)

      context.onProgress('Capture de l\'aperçu')
      const capture = await bridge.capture({
        url: url.length > 0 ? url : undefined,
        workspace: context.workspace,
        width,
        height,
      })

      // The base64 payload is intentionally not returned: it would flood the
      // model's context for no benefit.
      return {
        fichier: capture.relativePath,
        url: capture.url,
        largeur: capture.width,
        hauteur: capture.height,
        octets: capture.bytes,
      }
    },
  }
}

function projectOverview(): Tool {
  return {
    name: 'projectOverview',
    description: 'Produit le rapport d\'analyse du projet: type, framework, nombre de fichiers, de composants et de lignes, dépendances, scripts npm, erreurs détectées, plus l\'arborescence du projet en texte. À utiliser pour répondre à une question sur la structure ou pour rédiger un résumé visuel.',
    mutates: false,
    parameters: objectSchema({
      path: { type: 'string', description: 'Sous-dossier à cartographier (défaut: tout le workspace).' },
      maxDepth: { type: 'integer', description: 'Profondeur de l\'arborescence renvoyée (défaut 4, max 8).' },
    }),
    async execute(args, context) {
      const record = asRecord(args ?? {}, 'projectOverview')
      const input = optionalString(record, 'path', '')
      const maxDepth = optionalNumber(record, 'maxDepth', 4, 1, 8)

      const analysis = await buildAnalysis({ workspace: context.workspace, previewPath: input })
      const graph = await buildProjectGraph({
        workspace: context.workspace,
        relativeRoot: input,
        maxDepth,
      })

      return {
        projet: analysis.name,
        type: analysis.typeLabel,
        framework: analysis.framework,
        etat: analysis.state,
        statistiques: {
          fichiers: analysis.stats.files,
          dossiers: analysis.stats.directories,
          lignes: analysis.stats.lines,
          composants: analysis.stats.components,
        },
        langages: analysis.languages.slice(0, 12),
        dependances: analysis.dependencies.slice(0, 40).map(entry =>
          `${entry.name}@${entry.version}${entry.dev ? ' (dev)' : ''}`),
        scripts_npm: analysis.scripts.map(entry => `${entry.name}: ${entry.command}`),
        commandes_de_verification: analysis.checkCommands,
        erreurs_detectees: analysis.issues.map(issue =>
          `[${issue.severity}] ${issue.file ? `${issue.file}: ` : ''}${issue.message}`),
        apercu: {
          previsualisable: analysis.preview.previewable,
          dossier: analysis.preview.relativeRoot,
          servi_par: analysis.preview.servedBy === 'command'
            ? `commande: ${analysis.preview.command}`
            : 'serveur statique intégré',
          ...(analysis.preview.previewable ? {} : { probleme: analysis.preview.hint }),
        },
        arborescence: graph.ascii,
        arborescence_tronquee: graph.truncated,
        racine: path.basename(context.workspace),
      }
    },
  }
}

export function createPreviewTools(bridge: PreviewToolBridge = defaultPreviewBridge()): Tool[] {
  return [
    detectPreview(bridge),
    startPreview(bridge),
    stopPreview(bridge),
    previewStatus(bridge),
    capturePreviewTool(bridge),
    projectOverview(),
  ]
}
