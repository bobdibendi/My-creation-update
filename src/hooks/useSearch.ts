import { useCallback, useRef, useState } from 'react'

export interface SearchResult {
  path: string
  line: number
  text: string
}

const MAX_RESULTS = 200

export function useSearch() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const runIdRef = useRef(0)

  const runSearch = useCallback(async (folderPath: string | null) => {
    const bridge = window.electronAPI
    const needle = query.trim()
    if (!bridge || !folderPath || needle.length === 0) return

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setSearching(true)
    setResults([])

    const found: SearchResult[] = []
    const lowered = needle.toLowerCase()

    try {
      const nodes = await bridge.files.listRecursive(folderPath)
      for (const node of nodes) {
        if (runIdRef.current !== runId) return
        if (node.kind === 'directory') continue

        let content: string
        try { content = await bridge.files.read(node.path) } catch { continue }
        if (content.includes('\u0000')) continue

        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(lowered)) continue
          found.push({ path: node.path, line: index + 1, text: lines[index].trim() })
          if (found.length >= MAX_RESULTS) break
        }
        if (found.length >= MAX_RESULTS) break
      }
    } catch (error) {
      console.error(`[search] échec: ${(error as Error).message}`)
    }

    if (runIdRef.current !== runId) return
    setResults(found)
    setSearching(false)
  }, [query])

  return { query, setQuery, results, searching, runSearch }
}
