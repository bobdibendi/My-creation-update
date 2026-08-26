import { useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { FileSearch, Loader2, Search } from 'lucide-react'
import type { SearchResult } from '../hooks/useSearch'
import { FileIcon } from './FileIcon'
import { Sidebar } from '../layout'
import { Badge, EmptyState, IconButton, Skeleton, Tooltip } from './ui'
import { listItem, staggerContainer } from '../animations'

interface Props {
  folderPath: string | null
  query: string
  results: SearchResult[]
  searching: boolean
  onQueryChange: (value: string) => void
  onRun: () => void
  onOpenResult: (result: SearchResult) => void
}

/**
 * Full-text search across the opened folder.
 *
 * `.search-panel input` is a test contract used by `scripts/screenshot.cjs`;
 * keep both the class and a plain `<input>` inside it.
 */
export function SearchPanel({
  folderPath, query, results, searching, onQueryChange, onRun, onOpenResult,
}: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, SearchResult[]>()
    for (const result of results) {
      const list = map.get(result.path) ?? []
      list.push(result)
      map.set(result.path, list)
    }
    return [...map.entries()]
  }, [results])

  const submit = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onRun()
  }, [onRun])

  return (
    <Sidebar
      title="Recherche"
      className="search-panel"
      actions={
        results.length > 0 ? <Badge size="sm">{results.length}</Badge> : undefined
      }
      toolbar={
        <div className="search-panel__field">
          <Search size={12} />
          <input
            value={query}
            placeholder="Rechercher dans les fichiers"
            aria-label="Rechercher dans les fichiers"
            spellCheck={false}
            onChange={event => onQueryChange(event.target.value)}
            onKeyDown={submit}
          />
          <Tooltip content="Lancer la recherche" side="bottom">
            <IconButton
              label="Lancer la recherche"
              size="xs"
              icon={searching ? <Loader2 size={12} className="is-spinning" /> : <Search size={12} />}
              onClick={onRun}
              disabled={searching || !folderPath}
            />
          </Tooltip>
        </div>
      }
    >
      {!folderPath && (
        <EmptyState
          icon={<FileSearch size={22} />}
          title="Aucun dossier ouvert"
          description="Ouvre un dossier pour lancer une recherche."
          compact
        />
      )}

      {folderPath && searching && results.length === 0 && (
        <div className="search-panel__loading">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} height={11} width={`${90 - index * 8}%`} />
          ))}
        </div>
      )}

      {folderPath && !searching && query.trim().length > 0 && results.length === 0 && (
        <EmptyState
          icon={<FileSearch size={22} />}
          title="Aucun résultat"
          description={`Rien ne correspond à « ${query.trim()} ».`}
          compact
        />
      )}

      <motion.div variants={staggerContainer(0.02)} initial="hidden" animate="visible">
        {grouped.map(([path, hits]) => (
          <div className="search-panel__group" key={path}>
            <div className="search-panel__group-head" title={path}>
              <FileIcon name={path.split(/[\\/]/).pop() ?? path} size={12} />
              <span>{path.split(/[\\/]/).pop()}</span>
              <em>{hits.length}</em>
            </div>
            {hits.slice(0, 20).map((result, index) => (
              <motion.button
                key={`${result.path}:${result.line}:${index}`}
                type="button"
                className="search-panel__hit"
                variants={listItem}
                onClick={() => onOpenResult(result)}
                title={`${result.path}:${result.line}`}
              >
                <span className="search-panel__line">{result.line}</span>
                <span className="search-panel__text">{result.text.slice(0, 120)}</span>
              </motion.button>
            ))}
            {hits.length > 20 && (
              <span className="search-panel__more">+{hits.length - 20} autres</span>
            )}
          </div>
        ))}
      </motion.div>
    </Sidebar>
  )
}
