import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, WrapText } from 'lucide-react'
import { parseMarkdown, type InlineNode, type MarkdownBlock } from './markdown-parser'
import { Tooltip } from './Tooltip'
import { cx } from './cx'

/** Copies text and reports whether the clipboard accepted it. */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

function renderInline(nodes: InlineNode[], keyPrefix = ''): ReactNode {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.value}</Fragment>
      case 'code':
        return <code key={key} className="md-inline-code">{node.value}</code>
      case 'strong':
        return <strong key={key}>{renderInline(node.children, `${key}-`)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.children, `${key}-`)}</em>
      case 'strike':
        return <s key={key}>{renderInline(node.children, `${key}-`)}</s>
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            className="md-link"
            target="_blank"
            rel="noreferrer noopener"
          >
            {renderInline(node.children, `${key}-`)}
          </a>
        )
    }
  })
}

interface CodeBlockViewProps {
  language: string
  value: string
  /** Streaming: the closing fence has not arrived yet. */
  open: boolean
}

const LANGUAGE_LABEL: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JSX',
  javascript: 'JavaScript',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  py: 'Python',
  python: 'Python',
  sh: 'Shell',
  bash: 'Bash',
  zsh: 'Shell',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  rust: 'Rust',
  go: 'Go',
  text: 'Texte',
}

const WRAP_THRESHOLD = 12

function CodeBlockView({ language, value, open }: CodeBlockViewProps) {
  const [copied, setCopied] = useState(false)
  const [wrap, setWrap] = useState(false)
  const lines = useMemo(() => value.split('\n'), [value])
  const label = LANGUAGE_LABEL[language.toLowerCase()] ?? language

  const copy = useCallback(async () => {
    if (!(await copyText(value))) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [value])

  return (
    <div className={cx('md-code', open && 'is-streaming')}>
      <div className="md-code__head">
        <span className="md-code__lang">{label}</span>
        <span className="md-code__meta">{lines.length} ligne{lines.length > 1 ? 's' : ''}</span>
        <span className="md-code__actions">
          {lines.length > WRAP_THRESHOLD && (
            <Tooltip content={wrap ? 'Ne pas retourner à la ligne' : 'Retour à la ligne'}>
              <button
                type="button"
                className={cx('md-code__btn', wrap && 'is-active')}
                onClick={() => setWrap(current => !current)}
                aria-label="Basculer le retour à la ligne"
              >
                <WrapText size={12} />
              </button>
            </Tooltip>
          )}
          <Tooltip content={copied ? 'Copié' : 'Copier le bloc'}>
            <button
              type="button"
              className={cx('md-code__btn', copied && 'is-done')}
              onClick={() => void copy()}
              aria-label="Copier le bloc de code"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </Tooltip>
        </span>
      </div>
      <pre className={cx('md-code__pre', wrap && 'is-wrapped')}>
        <code>{value}</code>
      </pre>
      {open && <span className="md-code__stream-bar" aria-hidden />}
    </div>
  )
}

function renderBlock(block: MarkdownBlock, key: string): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key} className="md-p">{renderInline(block.inline, `${key}-`)}</p>
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[block.level - 1]
      return <Tag key={key} className={`md-h md-h${block.level}`}>{renderInline(block.inline, `${key}-`)}</Tag>
    }
    case 'code':
      return <CodeBlockView key={key} language={block.language} value={block.value} open={block.open} />
    case 'list':
      return block.ordered ? (
        <ol key={key} className="md-list md-list--ordered">
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, `${key}-${index}-`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {block.items.map((item, index) => (
            <li key={index}>{renderInline(item, `${key}-${index}-`)}</li>
          ))}
        </ul>
      )
    case 'quote':
      return <blockquote key={key} className="md-quote">{renderInline(block.inline, `${key}-`)}</blockquote>
    case 'rule':
      return <hr key={key} className="md-rule" />
    case 'table':
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th key={index}>{renderInline(cell, `${key}-h${index}-`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderInline(cell, `${key}-r${rowIndex}c${cellIndex}-`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

interface MarkdownProps {
  content: string
  className?: string
  /** Appends the blinking caret used during streaming. */
  streaming?: boolean
}

export function Markdown({ content, className, streaming = false }: MarkdownProps) {
  const blocks = useMemo(() => parseMarkdown(content), [content])

  return (
    <div className={cx('md', className)}>
      {blocks.map((block, index) => renderBlock(block, `b${index}`))}
      {streaming && (
        <motion.span
          className="md-caret"
          aria-hidden
          animate={{ opacity: [1, 0.15, 1] }}
          transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </div>
  )
}

export { copyText }
