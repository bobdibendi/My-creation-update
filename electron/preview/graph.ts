import path from 'node:path'
import { walkWorkspace } from '../agent/workspace.js'
import { languageOf } from './analyze.js'
import type { GraphNode, ProjectGraph } from './types.js'

/** Children kept per directory before collapsing the rest into a counter. */
const MAX_CHILDREN_PER_NODE = 12
const MAX_NODES = 400

interface MutableNode extends Omit<GraphNode, 'children'> {
  children: MutableNode[]
}

function createNode(id: string, label: string, kind: 'file' | 'directory', depth: number): MutableNode {
  return {
    id,
    label,
    kind,
    depth,
    children: [],
    hiddenChildren: 0,
    language: kind === 'file' ? languageOf(label) : '',
  }
}

/** Directories first, then alphabetical: matches the explorer ordering. */
function sortChildren(node: MutableNode): void {
  node.children.sort((a, b) =>
    Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.label.localeCompare(b.label))
  for (const child of node.children) sortChildren(child)
}

/** Caps the fan-out so a node_modules-sized directory cannot flood the view. */
function capChildren(node: MutableNode): number {
  let total = 1
  if (node.children.length > MAX_CHILDREN_PER_NODE) {
    node.hiddenChildren = node.children.length - MAX_CHILDREN_PER_NODE
    node.children = node.children.slice(0, MAX_CHILDREN_PER_NODE)
  }
  for (const child of node.children) total += capChildren(child)
  return total
}

function toGraphNode(node: MutableNode): GraphNode {
  return {
    id: node.id,
    label: node.label,
    kind: node.kind,
    depth: node.depth,
    hiddenChildren: node.hiddenChildren,
    language: node.language,
    children: node.children.map(toGraphNode),
  }
}

/**
 * Renders the tree the way `tree` does, with box-drawing characters.
 * Used verbatim in agent summaries, so it must stay plain text.
 */
export function renderAscii(root: GraphNode): string {
  const lines: string[] = [root.label]

  const walk = (node: GraphNode, prefix: string): void => {
    const visible = node.children
    for (let index = 0; index < visible.length; index += 1) {
      const child = visible[index]
      const last = index === visible.length - 1 && child.hiddenChildren === 0 && node.hiddenChildren === 0
      const connector = last ? '└── ' : '├── '
      const suffix = child.kind === 'directory' ? '/' : ''
      lines.push(`${prefix}${connector}${child.label}${suffix}`)
      walk(child, `${prefix}${last ? '    ' : '│   '}`)
    }
    if (node.hiddenChildren > 0) {
      lines.push(`${prefix}└── … ${node.hiddenChildren} autre(s)`)
    }
  }

  walk(root, '')
  return lines.join('\n')
}

export interface GraphOptions {
  workspace: string
  /** Subdirectory to graph; '.' or empty for the whole workspace. */
  relativeRoot?: string
  maxDepth?: number
}

/**
 * Builds the architecture tree shown by ProjectGraph and printed by the agent.
 * Ignored directories (node_modules, dist, .git…) are skipped by walkWorkspace.
 */
export async function buildProjectGraph(options: GraphOptions): Promise<ProjectGraph> {
  const workspace = path.resolve(options.workspace)
  const maxDepth = Math.min(8, Math.max(1, options.maxDepth ?? 4))
  const start = options.relativeRoot && options.relativeRoot.trim().length > 0 && options.relativeRoot !== '.'
    ? path.resolve(workspace, options.relativeRoot)
    : workspace

  const { entries, truncated } = await walkWorkspace(workspace, start, {
    maxDepth: maxDepth - 1,
    maxEntries: 4000,
  })

  const rootLabel = path.basename(start) || path.basename(workspace) || 'projet'
  const root = createNode('.', rootLabel, 'directory', 0)
  const index = new Map<string, MutableNode>([['.', root]])

  // Entries arrive parent-before-child from the walk, but a missing parent is
  // still possible when the walk is truncated mid-directory, so create the
  // chain on demand.
  const ensureDirectory = (relativePath: string, depth: number): MutableNode => {
    const existing = index.get(relativePath)
    if (existing) return existing
    const parentPath = path.posix.dirname(relativePath)
    const parent = parentPath === '.' || parentPath === relativePath
      ? root
      : ensureDirectory(parentPath, depth - 1)
    const node = createNode(relativePath, path.posix.basename(relativePath), 'directory', depth)
    parent.children.push(node)
    index.set(relativePath, node)
    return node
  }

  for (const entry of entries) {
    const relativePath = entry.relativePath
    const depth = relativePath.split('/').length
    if (entry.kind === 'directory') {
      ensureDirectory(relativePath, depth)
      continue
    }
    const parentPath = path.posix.dirname(relativePath)
    const parent = parentPath === '.' ? root : ensureDirectory(parentPath, depth - 1)
    const node = createNode(relativePath, path.posix.basename(relativePath), 'file', depth)
    parent.children.push(node)
    index.set(relativePath, node)
  }

  sortChildren(root)
  let nodeCount = capChildren(root)

  // A second pass trims depth if the capped tree is still too large for the UI.
  if (nodeCount > MAX_NODES) {
    const trim = (node: MutableNode, allowedDepth: number): void => {
      if (node.depth >= allowedDepth) {
        node.hiddenChildren += node.children.length
        node.children = []
        return
      }
      for (const child of node.children) trim(child, allowedDepth)
    }
    for (let allowed = maxDepth - 1; allowed >= 1 && nodeCount > MAX_NODES; allowed -= 1) {
      trim(root, allowed)
      nodeCount = capChildren(root)
    }
  }

  const graphRoot = toGraphNode(root)
  return {
    root: graphRoot,
    ascii: renderAscii(graphRoot),
    nodeCount,
    truncated: truncated || nodeCount > MAX_NODES,
  }
}
