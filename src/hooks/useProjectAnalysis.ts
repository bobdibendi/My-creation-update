import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectAnalysis, ProjectGraph } from '../shared/types'

/**
 * Loads the project report and architecture graph.
 *
 * Both are recomputed on demand and whenever the agent reports writes, since a
 * stale file count is worse than no count at all.
 */
export function useProjectAnalysis(workspace: string | null, enabled: boolean) {
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null)
  const [graph, setGraph] = useState<ProjectGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const runIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const bridge = window.electronAPI
    if (!bridge || !workspace) {
      setAnalysis(null)
      setGraph(null)
      return
    }

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setLoading(true)
    setError('')
    try {
      const [report, tree] = await Promise.all([
        bridge.project.analyze(workspace),
        bridge.project.graph(workspace, '', 4),
      ])
      // Drop the result if a newer refresh started meanwhile.
      if (runIdRef.current !== runId) return
      setAnalysis(report)
      setGraph(tree)
    } catch (failure) {
      if (runIdRef.current !== runId) return
      setError((failure as Error).message)
    } finally {
      if (runIdRef.current === runId) setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    if (!enabled) return
    void refresh()
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled) return
    const handler = () => { void refresh() }
    document.addEventListener('workspace-files-changed', handler)
    return () => document.removeEventListener('workspace-files-changed', handler)
  }, [enabled, refresh])

  return { analysis, graph, loading, error, refresh }
}
