/**
 * Minimal Markdown parser for chat messages.
 *
 * A dependency was avoided on purpose: `react-markdown` plus `remark` pulls in
 * ~150 kB for a subset the assistant actually emits, and any HTML-passthrough
 * renderer would need sanitising under a CSP that already forbids inline script.
 * This parser never produces raw HTML — the caller maps the returned tree to
 * React elements, so injection is structurally impossible.
 */

export interface InlineText {
  kind: 'text'
  value: string
}
export interface InlineCode {
  kind: 'code'
  value: string
}
export interface InlineStrong {
  kind: 'strong'
  children: InlineNode[]
}
export interface InlineEm {
  kind: 'em'
  children: InlineNode[]
}
export interface InlineStrike {
  kind: 'strike'
  children: InlineNode[]
}
export interface InlineLink {
  kind: 'link'
  href: string
  children: InlineNode[]
}

export type InlineNode =
  | InlineText
  | InlineCode
  | InlineStrong
  | InlineEm
  | InlineStrike
  | InlineLink

export interface ParagraphBlock {
  kind: 'paragraph'
  inline: InlineNode[]
}
export interface HeadingBlock {
  kind: 'heading'
  level: 1 | 2 | 3 | 4
  inline: InlineNode[]
}
export interface CodeBlock {
  kind: 'code'
  language: string
  value: string
  /** True while the closing fence has not been received yet. */
  open: boolean
}
export interface ListBlock {
  kind: 'list'
  ordered: boolean
  items: InlineNode[][]
}
export interface QuoteBlock {
  kind: 'quote'
  inline: InlineNode[]
}
export interface RuleBlock {
  kind: 'rule'
}
export interface TableBlock {
  kind: 'table'
  head: InlineNode[][]
  rows: InlineNode[][][]
}

export type MarkdownBlock =
  | ParagraphBlock
  | HeadingBlock
  | CodeBlock
  | ListBlock
  | QuoteBlock
  | RuleBlock
  | TableBlock

const INLINE_PATTERN = new RegExp(
  [
    '`([^`]+)`', // 1: code
    '\\*\\*([^*]+)\\*\\*', // 2: strong
    '__([^_]+)__', // 3: strong
    '\\*([^*\\n]+)\\*', // 4: em
    '_([^_\\n]+)_', // 5: em
    '~~([^~]+)~~', // 6: strike
    '\\[([^\\]]+)\\]\\(([^)\\s]+)\\)', // 7,8: link
    '(https?://[^\\s<>()]+)', // 9: bare url
  ].join('|'),
  'g',
)

/** Only http(s) survives; anything else becomes plain text. */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  INLINE_PATTERN.lastIndex = 0

  const pushText = (value: string) => {
    if (value.length === 0) return
    const last = nodes[nodes.length - 1]
    if (last && last.kind === 'text') last.value += value
    else nodes.push({ kind: 'text', value })
  }

  while ((match = INLINE_PATTERN.exec(source)) !== null) {
    if (match.index > cursor) pushText(source.slice(cursor, match.index))
    cursor = match.index + match[0].length

    if (match[1] !== undefined) nodes.push({ kind: 'code', value: match[1] })
    else if (match[2] !== undefined) nodes.push({ kind: 'strong', children: parseInline(match[2]) })
    else if (match[3] !== undefined) nodes.push({ kind: 'strong', children: parseInline(match[3]) })
    else if (match[4] !== undefined) nodes.push({ kind: 'em', children: parseInline(match[4]) })
    else if (match[5] !== undefined) nodes.push({ kind: 'em', children: parseInline(match[5]) })
    else if (match[6] !== undefined) nodes.push({ kind: 'strike', children: parseInline(match[6]) })
    else if (match[7] !== undefined && match[8] !== undefined) {
      const href = safeHref(match[8])
      if (href) nodes.push({ kind: 'link', href, children: parseInline(match[7]) })
      else pushText(match[0])
    } else if (match[9] !== undefined) {
      const href = safeHref(match[9])
      if (href) nodes.push({ kind: 'link', href, children: [{ kind: 'text', value: match[9] }] })
      else pushText(match[0])
    }
  }

  if (cursor < source.length) pushText(source.slice(cursor))
  return nodes
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim())
}

function isDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
}

/**
 * Splits a message into blocks.
 *
 * Tolerant by design: an unterminated fence produces an `open` code block so a
 * streaming response renders as code from the first fence instead of flashing
 * raw backticks when the closing fence finally arrives.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length === 0) return
    blocks.push({ kind: 'paragraph', inline: parseInline(buffer.join('\n')) })
    buffer.length = 0
  }

  const paragraph: string[] = []

  while (index < lines.length) {
    const line = lines[index]

    const fence = /^\s*```([a-zA-Z0-9_+#.-]*)\s*$/.exec(line)
    if (fence) {
      flushParagraph(paragraph)
      const body: string[] = []
      index += 1
      let closed = false
      while (index < lines.length) {
        if (/^\s*```\s*$/.test(lines[index])) {
          closed = true
          index += 1
          break
        }
        body.push(lines[index])
        index += 1
      }
      blocks.push({
        kind: 'code',
        language: fence[1] || 'text',
        value: body.join('\n'),
        open: !closed,
      })
      continue
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph(paragraph)
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph(paragraph)
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3 | 4,
        inline: parseInline(heading[2].trim()),
      })
      index += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph)
      const quoted: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', inline: parseInline(quoted.join('\n')) })
      continue
    }

    // Table: a header row followed by a divider row.
    if (line.includes('|') && index + 1 < lines.length && isDivider(lines[index + 1])) {
      flushParagraph(paragraph)
      const head = splitRow(line).map(parseInline)
      index += 2
      const rows: InlineNode[][][] = []
      while (index < lines.length && lines[index].includes('|') && lines[index].trim().length > 0) {
        rows.push(splitRow(lines[index]).map(parseInline))
        index += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph(paragraph)
      const ordered = Boolean(numbered)
      const items: InlineNode[][] = []
      while (index < lines.length) {
        const current = lines[index]
        const nextBullet = /^\s*[-*+]\s+(.*)$/.exec(current)
        const nextNumbered = /^\s*\d+[.)]\s+(.*)$/.exec(current)
        const matched = ordered ? nextNumbered : nextBullet
        if (!matched) {
          // A plain indented line continues the previous item.
          if (items.length > 0 && /^\s{2,}\S/.test(current)) {
            const tail = items[items.length - 1]
            tail.push({ kind: 'text', value: ` ${current.trim()}` })
            index += 1
            continue
          }
          break
        }
        items.push(parseInline(matched[1]))
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph(paragraph)
      index += 1
      continue
    }

    paragraph.push(line)
    index += 1
  }

  flushParagraph(paragraph)
  return blocks
}
