import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, Circle, Copy, SplitSquareHorizontal, X } from 'lucide-react'
import { FileIcon } from './FileIcon'
import { ContextMenu, Tooltip, copyText, type MenuEntry } from './ui'
import { transitions } from '../animations'
import { cx } from './ui/cx'
import type { Tab } from '../shared/types'
import type * as monacoType from 'monaco-editor'
import * as monacoModule from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import { useTheme } from '../theme'

// Use the bundled Monaco instead of the CDN so the app works offline and under CSP.
loader.config({ monaco: monacoModule })

interface Props {
  tabs: Tab[]
  activePath: string
  onSelectTab: (path: string) => void
  onCloseTab: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseAll: () => void
  onChangeContent: (path: string, value: string | undefined) => void
  onSave: () => void
}

const MONACO_THEME_DARK = 'cursor-clone-dark'
const MONACO_THEME_LIGHT = 'cursor-clone-light'

/** Monaco keeps a global theme registry, so define ours once per module load. */
let themesDefined = false

function defineThemes(monaco: typeof monacoType): void {
  if (themesDefined) return
  themesDefined = true

  const read = (name: string, fallback: string): string => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value.length > 0 ? value : fallback
  }
  // Monaco rejects rgba() in most colour slots, so only hex tokens are read.
  const hex = (name: string, fallback: string): string => {
    const value = read(name, fallback)
    return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback
  }

  monaco.editor.defineTheme(MONACO_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6B7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'C4B5FD' },
      { token: 'string', foreground: '9DE0AE' },
      { token: 'number', foreground: 'FCD34D' },
      { token: 'type', foreground: '8AB4F8' },
      { token: 'function', foreground: 'D4B483' },
    ],
    colors: {
      'editor.background': hex('--c-surface', '#141417'),
      'editor.foreground': hex('--c-text', '#FFFFFF'),
      'editorLineNumber.foreground': hex('--c-text-faint', '#6B7280'),
      'editorLineNumber.activeForeground': hex('--c-accent', '#D4B483'),
      'editorCursor.foreground': hex('--c-accent', '#D4B483'),
      'editor.selectionBackground': '#2A2A34',
      'editor.lineHighlightBackground': '#1B1B20',
      'editorIndentGuide.background1': '#1F1F26',
      'editorGutter.background': hex('--c-surface', '#141417'),
      'editorWidget.background': hex('--c-surface-2', '#1B1B20'),
      'editorWidget.border': '#26262F',
      'scrollbarSlider.background': '#26262F80',
      'scrollbarSlider.hoverBackground': '#33333Faa',
      'minimap.background': hex('--c-bg', '#0D0D0F'),
    },
  })

  monaco.editor.defineTheme(MONACO_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: [{ token: 'comment', foreground: '8A8F98', fontStyle: 'italic' }],
    colors: {
      'editor.background': hex('--c-surface', '#FFFFFF'),
      'editor.foreground': hex('--c-text', '#1A1A1C'),
      'editorCursor.foreground': hex('--c-accent', '#A9772F'),
      'editor.lineHighlightBackground': '#F4F1EB',
    },
  })
}

// ─── Monaco host ─────────────────────────────────────
const models = new Map<string, monacoType.editor.ITextModel>()

function uriFor(monaco: typeof monacoType, filePath: string): monacoType.Uri {
  if (filePath.startsWith('untitled:')) return monaco.Uri.parse(filePath)
  const normalized = filePath.replace(/\\/g, '/')
  return monaco.Uri.parse(`file:///${normalized.replace(/^\/+/, '')}`)
}

function MonacoEditor({
  activeTab, onChangeContent, onSave,
}: {
  activeTab: Tab | undefined
  onChangeContent: (path: string, value: string | undefined) => void
  onSave: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof monacoType | null>(null)
  const activePathRef = useRef('')
  const onChangeRef = useRef(onChangeContent)
  const onSaveRef = useRef(onSave)
  onChangeRef.current = onChangeContent
  onSaveRef.current = onSave

  const { theme, monoFont } = useTheme()
  // Read through a ref inside the creation effect: depending on `theme` there
  // would recreate the editor on every appearance change, losing the cursor
  // position and the undo stack. The effect below re-applies the theme instead.
  const themeModeRef = useRef(theme.mode)
  themeModeRef.current = theme.mode

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return
    const monaco = monacoModule
    monacoRef.current = monaco
    defineThemes(monaco)

    const editor = monaco.editor.create(containerRef.current, {
      theme: themeModeRef.current === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME_DARK,
      minimap: { enabled: true, scale: 1, renderCharacters: false },
      fontSize: 12.5,
      fontLigatures: true,
      lineHeight: 1.65,
      padding: { top: 16, bottom: 16 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      autoIndent: 'full',
      formatOnPaste: true,
      wordWrap: 'off',
      tabSize: 2,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerBorder: false,
      stickyScroll: { enabled: true },
    })
    editorRef.current = editor

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current())
    editor.onDidChangeModelContent(() => {
      const path = activePathRef.current
      const model = editor.getModel()
      if (!path || !model) return
      onChangeRef.current(path, model.getValue())
    })

    return () => {
      editor.dispose()
      editorRef.current = null
      for (const model of models.values()) model.dispose()
      models.clear()
    }
  }, [])

  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco) return
    monaco.editor.setTheme(theme.mode === 'light' ? MONACO_THEME_LIGHT : MONACO_THEME_DARK)
  }, [theme.mode, theme.id])

  useEffect(() => {
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
    if (family.length > 0) editorRef.current?.updateOptions({ fontFamily: family })
  }, [monoFont])

  // Swap models when the active tab changes, and mirror external writes.
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return

    if (!activeTab) {
      activePathRef.current = ''
      editor.setModel(null)
      return
    }

    activePathRef.current = activeTab.path
    let model = models.get(activeTab.path)
    if (!model || model.isDisposed()) {
      const uri = uriFor(monaco, activeTab.path)
      model = monaco.editor.getModel(uri)
        ?? monaco.editor.createModel(activeTab.content, activeTab.language, uri)
      models.set(activeTab.path, model)
    }
    if (model.getValue() !== activeTab.content) model.setValue(activeTab.content)
    if (model.getLanguageId() !== activeTab.language) monaco.editor.setModelLanguage(model, activeTab.language)
    if (editor.getModel() !== model) editor.setModel(model)
  }, [activeTab?.path, activeTab?.language, activeTab?.content, activeTab])

  return <div ref={containerRef} className="editor__monaco" />
}

// ─── Tabs ────────────────────────────────────────────
export function EditorTabs({
  tabs, activePath, onSelectTab, onCloseTab, onCloseOthers, onCloseAll,
  onChangeContent, onSave,
}: Props) {
  const activeTab = useMemo(() => tabs.find(tab => tab.path === activePath), [tabs, activePath])
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null)

  // Release Monaco models for tabs that no longer exist.
  useEffect(() => {
    const open = new Set(tabs.map(tab => tab.path))
    for (const [path, model] of models) {
      if (open.has(path)) continue
      model.dispose()
      models.delete(path)
    }
  }, [tabs])

  const menuEntries = useCallback((tab: Tab): MenuEntry[] => [
    { id: 'close', label: 'Fermer', hint: 'Ctrl+W', onSelect: () => onCloseTab(tab.path) },
    {
      id: 'close-others',
      label: 'Fermer les autres',
      icon: <SplitSquareHorizontal size={13} />,
      disabled: tabs.length < 2,
      onSelect: () => onCloseOthers(tab.path),
    },
    { id: 'close-all', label: 'Tout fermer', onSelect: onCloseAll },
    { id: 'sep', separator: true },
    {
      id: 'copy-path',
      label: 'Copier le chemin',
      icon: <Copy size={13} />,
      disabled: tab.untitled,
      onSelect: () => { void copyText(tab.path) },
    },
  ], [tabs.length, onCloseTab, onCloseOthers, onCloseAll])

  const crumbs = activeTab
    ? (activeTab.untitled ? [activeTab.name] : activeTab.path.split(/[\\/]/).filter(Boolean))
    : []

  return (
    <section className="editor">
      <div className="tabsbar" role="tablist" aria-label="Fichiers ouverts">
        <AnimatePresence initial={false}>
          {tabs.map(tab => {
            const active = tab.path === activePath
            return (
              <motion.div
                key={tab.path}
                role="tab"
                aria-selected={active}
                className={cx('tab', active && 'is-active', tab.dirty && 'is-dirty')}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={transitions.fast}
                onClick={() => onSelectTab(tab.path)}
                onAuxClick={event => { if (event.button === 1) onCloseTab(tab.path) }}
                onContextMenu={event => {
                  event.preventDefault()
                  setMenu({ x: event.clientX, y: event.clientY, tab })
                }}
                title={tab.untitled ? tab.name : tab.path}
              >
                <FileIcon name={tab.name} size={12} />
                <span className="tab__label">{tab.name}</span>
                <button
                  type="button"
                  className="tab__close"
                  aria-label={`Fermer ${tab.name}`}
                  onClick={event => { event.stopPropagation(); onCloseTab(tab.path) }}
                >
                  {tab.dirty ? <Circle size={8} className="tab__dot" /> : <X size={11} />}
                </button>
                {active && (
                  <motion.span
                    layoutId="tab-underline"
                    className="tab__underline"
                    transition={{ type: 'spring', stiffness: 500, damping: 36 }}
                  />
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {activeTab && (
        <div className="breadcrumbs">
          {crumbs.map((segment, index) => (
            <span key={`${segment}-${index}`} className="breadcrumbs__seg">
              {index > 0 && <ChevronRight size={10} aria-hidden />}
              <span className={index === crumbs.length - 1 ? 'is-current' : undefined}>{segment}</span>
            </span>
          ))}
          <span className="breadcrumbs__fill" />
          <Tooltip content="Langage détecté" side="left">
            <span className="breadcrumbs__lang">{activeTab.language}</span>
          </Tooltip>
        </div>
      )}

      <div className="editor__host">
        <MonacoEditor activeTab={activeTab} onChangeContent={onChangeContent} onSave={onSave} />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.tab.name}
          entries={menuEntries(menu.tab)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
}
