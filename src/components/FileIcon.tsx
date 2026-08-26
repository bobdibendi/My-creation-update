import {
  File, FileCode2, FileJson, FileText, FileType, Folder, FolderOpen, Image, Settings2,
} from 'lucide-react'
import { cx } from './ui/cx'

interface Props {
  name: string
  size?: number
  className?: string
  /** Renders a folder glyph instead of deriving one from the extension. */
  directory?: boolean
  /** Only meaningful when `directory` is true. */
  open?: boolean
}

const GROUPS: Array<{ hue: string; icon: typeof FileCode2; extensions: string[] }> = [
  { hue: 'hue1', icon: FileCode2, extensions: ['ts', 'tsx', 'mts', 'cts'] },
  { hue: 'hue4', icon: FileCode2, extensions: ['js', 'jsx', 'mjs', 'cjs'] },
  { hue: 'hue4', icon: FileJson, extensions: ['json', 'jsonc', 'lock'] },
  { hue: 'hue3', icon: FileText, extensions: ['md', 'mdx', 'txt', 'log'] },
  { hue: 'hue2', icon: FileType, extensions: ['css', 'scss', 'sass', 'less'] },
  { hue: 'hue5', icon: FileCode2, extensions: ['html', 'htm', 'vue', 'svelte', 'astro'] },
  { hue: 'hue3', icon: Image, extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif'] },
  { hue: 'hue2', icon: Settings2, extensions: ['yml', 'yaml', 'toml', 'ini', 'env', 'conf'] },
]

const NAMED: Record<string, { hue: string; icon: typeof FileCode2 }> = {
  'package.json': { hue: 'hue4', icon: FileJson },
  'tsconfig.json': { hue: 'hue1', icon: Settings2 },
  dockerfile: { hue: 'hue1', icon: Settings2 },
  makefile: { hue: 'hue5', icon: Settings2 },
  '.gitignore': { hue: 'hue5', icon: Settings2 },
}

/** Maps a file name to a coloured glyph. Colours come from theme hue slots. */
export function FileIcon({ name, size = 13, className, directory = false, open = false }: Props) {
  if (directory) {
    const Icon = open ? FolderOpen : Folder
    return <Icon size={size} className={cx('fileicon', 'is-folder', className)} />
  }

  const lower = name.toLowerCase()
  const named = NAMED[lower]
  if (named) {
    const Icon = named.icon
    return <Icon size={size} className={cx('fileicon', `is-${named.hue}`, className)} />
  }

  const extension = lower.includes('.') ? lower.split('.').pop() ?? '' : ''
  const group = GROUPS.find(entry => entry.extensions.includes(extension))
  if (group) {
    const Icon = group.icon
    return <Icon size={size} className={cx('fileicon', `is-${group.hue}`, className)} />
  }

  return <File size={size} className={cx('fileicon', className)} />
}
