import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Folder, FolderOpen, Network, Text } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { Segmented } from './ui'
import type { GraphNode, ProjectGraph as ProjectGraphData } from '../shared/types'

interface Props {
  graph: ProjectGraphData
}

/** Layout constants, in SVG user units. */
const ROW_HEIGHT = 26
const COLUMN_WIDTH = 172
const NODE_WIDTH = 152
const NODE_HEIGHT = 21
const PADDING = 14

interface PlacedNode {
  node: GraphNode
  x: number
  y: number
  parent: PlacedNode | null
}

/**
 * Assigns coordinates with a walk simplified for trees drawn left-to-right:
 * depth sets the column, document order sets the row.
 */
function layout(root: GraphNode, collapsed: Set<string>): PlacedNode[] {
  const placed: PlacedNode[] = []
  let row = 0

  const visit = (node: GraphNode, depth: number, parent: PlacedNode | null): void => {
    const current: PlacedNode = {
      node,
      x: PADDING + depth * COLUMN_WIDTH,
      y: PADDING + row * ROW_HEIGHT,
      parent,
    }
    placed.push(current)
    row += 1
    if (collapsed.has(node.id)) return
    for (const child of node.children) visit(child, depth + 1, current)
  }

  visit(root, 0, null)
  return placed
}

/** Elbow connector: out of the parent, down, then into the child. */
function connectorPath(parent: PlacedNode, child: PlacedNode): string {
  const startX = parent.x + 12
  const startY = parent.y + NODE_HEIGHT
  const endX = child.x
  const endY = child.y + NODE_HEIGHT / 2
  return `M ${startX} ${startY} V ${endY} H ${endX}`
}

/**
 * Architecture map as inline SVG.
 *
 * SVG is used instead of React Flow, Mermaid or D3: those add hundreds of
 * kilobytes for a tree layout that fits in this file, and Mermaid needs runtime
 * style injection that the app's CSP forbids.
 */
export function ProjectGraph({ graph }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'graph' | 'ascii'>('graph')

  const placed = useMemo(() => layout(graph.root, collapsed), [graph.root, collapsed])
  const width = useMemo(
    () => Math.max(...placed.map(item => item.x + NODE_WIDTH)) + PADDING,
    [placed],
  )
  const height = useMemo(
    () => Math.max(...placed.map(item => item.y + NODE_HEIGHT)) + PADDING,
    [placed],
  )

  const toggle = (node: GraphNode) => {
    if (node.children.length === 0) return
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(node.id)) next.delete(node.id)
      else next.add(node.id)
      return next
    })
  }

  return (
    <div className="graph">
      <div className="graph__head">
        <span className="graph__count">
          {graph.nodeCount} élément{graph.nodeCount > 1 ? 's' : ''}
          {graph.truncated ? ' (tronqué)' : ''}
        </span>
        <Segmented
          size="sm"
          ariaLabel="Mode d’affichage du graphe"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'graph', label: 'Graphique', icon: <Network size={12} /> },
            { value: 'ascii', label: 'Texte', icon: <Text size={12} /> },
          ]}
        />
      </div>

      {mode === 'ascii' ? (
        <pre className="graph__ascii">{graph.ascii}</pre>
      ) : (
        <div className="graph__canvas">
          <svg width={width} height={height} role="img" aria-label="Carte de l’architecture du projet">
            <g className="graph__edges">
              {placed.filter(item => item.parent).map(item => (
                <motion.path
                  key={`edge-${item.node.id}`}
                  d={connectorPath(item.parent as PlacedNode, item)}
                  fill="none"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.4, delay: item.node.depth * 0.04 }}
                />
              ))}
            </g>
            <g className="graph__nodes">
              {placed.map((item, index) => {
                const isDirectory = item.node.kind === 'directory'
                const isCollapsed = collapsed.has(item.node.id)
                const label = item.node.label + (isDirectory ? '/' : '')
                const extra = item.node.hiddenChildren > 0 ? ` +${item.node.hiddenChildren}` : ''
                return (
                  <motion.g
                    key={item.node.id}
                    transform={`translate(${item.x}, ${item.y})`}
                    className={`graph__node is-${item.node.kind}${isCollapsed ? ' is-collapsed' : ''}`}
                    onClick={() => toggle(item.node)}
                    initial={{ opacity: 0, x: item.x - 8 }}
                    animate={{ opacity: 1, x: item.x }}
                    transition={{ duration: 0.24, delay: Math.min(index * 0.012, 0.4) }}
                  >
                    <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={7} />
                    <foreignObject width={NODE_WIDTH} height={NODE_HEIGHT}>
                      <div className="graph__node-body">
                        {isDirectory
                          ? (isCollapsed ? <Folder size={11} /> : <FolderOpen size={11} />)
                          : <FileIcon name={item.node.label} size={11} />}
                        <span className="graph__node-label">{label}{extra}</span>
                      </div>
                    </foreignObject>
                  </motion.g>
                )
              })}
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}
