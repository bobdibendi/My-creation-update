import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, Trash2, X } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { IconButton, Tooltip } from './ui'
import { cx } from './ui/cx'
import { useTheme } from '../theme'

interface Props {
  /** The shell is spawned on first activation so a hidden tab costs nothing. */
  active: boolean
  workspace: string | null
}

interface Session {
  key: string
  label: string
}

interface Handle {
  terminal: XTerm
  fit: FitAddon
  id: string | null
  disposeData: (() => void) | null
  disposeExit: (() => void) | null
  exited: boolean
}

/** Reads a hex custom property, falling back when the theme uses rgba(). */
function readColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : fallback
}

function TerminalInstance({
  sessionKey, workspace, visible, onExit,
}: {
  sessionKey: string
  workspace: string | null
  visible: boolean
  onExit: (key: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<Handle | null>(null)
  const { theme } = useTheme()

  useEffect(() => {
    if (!containerRef.current || handleRef.current) return

    const terminal = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 12,
      lineHeight: 1.35,
      fontFamily: readColorFont(),
      convertEol: true,
      scrollback: 5000,
      allowTransparency: true,
      theme: {
        background: readColor('--c-bg', '#0D0D0F'),
        foreground: readColor('--c-text-dim', '#9CA3AF'),
        cursor: readColor('--c-accent', '#D4B483'),
        selectionBackground: readColor('--c-surface-3', '#22222A'),
        black: readColor('--c-surface', '#141417'),
        red: readColor('--c-danger', '#F87171'),
        green: readColor('--c-success', '#4ADE80'),
        yellow: readColor('--c-warning', '#FBBF24'),
        blue: readColor('--c-hue1', '#8AB4F8'),
        magenta: readColor('--c-hue2', '#C4B5FD'),
        cyan: readColor('--c-hue3', '#5EEAD4'),
        white: readColor('--c-text', '#FFFFFF'),
      },
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()

    const handle: Handle = {
      terminal, fit, id: null, disposeData: null, disposeExit: null, exited: false,
    }
    handleRef.current = handle

    const bridge = window.electronAPI
    if (bridge) {
      void bridge.terminal.create(workspace).then(id => {
        if (handleRef.current !== handle) {
          void bridge.terminal.kill(id)
          return
        }
        handle.id = id
        handle.disposeData = bridge.terminal.onData(payload => {
          if (payload.id === id) terminal.write(payload.data)
        })
        handle.disposeExit = bridge.terminal.onExit(payload => {
          if (payload.id !== id) return
          handle.id = null
          handle.exited = true
          terminal.writeln('\r\n\x1b[2m[processus terminé]\x1b[0m')
          onExit(sessionKey)
        })
        terminal.onData(data => {
          if (handle.id) void bridge.terminal.write(handle.id, data)
        })
        terminal.onResize(({ cols, rows }) => {
          if (handle.id) void bridge.terminal.resize(handle.id, cols, rows)
        })
      }).catch((error: unknown) => {
        terminal.writeln(`Terminal indisponible: ${(error as Error).message}`)
      })
    } else {
      terminal.writeln('Terminal indisponible en dehors d\'Electron.')
    }

    const observer = new ResizeObserver(() => {
      try { fit.fit() } catch { /* container hidden */ }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      handle.disposeData?.()
      handle.disposeExit?.()
      if (handle.id) void window.electronAPI?.terminal.kill(handle.id)
      terminal.dispose()
      handleRef.current = null
    }
  }, [sessionKey, workspace, onExit])

  // Repaint on theme change instead of recreating the shell.
  useEffect(() => {
    const terminal = handleRef.current?.terminal
    if (!terminal) return
    terminal.options.theme = {
      background: readColor('--c-bg', '#0D0D0F'),
      foreground: readColor('--c-text-dim', '#9CA3AF'),
      cursor: readColor('--c-accent', '#D4B483'),
      selectionBackground: readColor('--c-surface-3', '#22222A'),
    }
  }, [theme.id])

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => {
      try { handleRef.current?.fit.fit() } catch { /* not laid out yet */ }
    }, 60)
    return () => window.clearTimeout(timer)
  }, [visible])

  useEffect(() => {
    const handler = () => {
      try { handleRef.current?.fit.fit() } catch { /* ignore */ }
    }
    window.addEventListener('resize', handler)
    document.addEventListener('dock-resized', handler)
    return () => {
      window.removeEventListener('resize', handler)
      document.removeEventListener('dock-resized', handler)
    }
  }, [])

  return (
    <div
      className={cx('terminal__surface', visible && 'is-visible')}
      ref={containerRef}
      aria-hidden={!visible}
    />
  )
}

function readColorFont(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()
  return value.length > 0 ? value : "'Cascadia Code',Consolas,monospace"
}

/**
 * Terminal panel with multiple shells.
 *
 * Every session stays mounted while it exists: unmounting would kill the child
 * process, so switching tabs only toggles visibility.
 */
export function TerminalView({ active, workspace }: Props) {
  const [sessions, setSessions] = useState<Session[]>([{ key: 'term-1', label: 'Shell 1' }])
  const [activeKey, setActiveKey] = useState('term-1')
  const [exited, setExited] = useState<Set<string>>(new Set())
  const counter = useRef(1)

  const addSession = useCallback(() => {
    counter.current += 1
    const key = `term-${counter.current}`
    setSessions(previous => [...previous, { key, label: `Shell ${counter.current}` }])
    setActiveKey(key)
  }, [])

  const closeSession = useCallback((key: string) => {
    setSessions(previous => {
      const next = previous.filter(session => session.key !== key)
      if (next.length === 0) {
        counter.current += 1
        const fresh = { key: `term-${counter.current}`, label: `Shell ${counter.current}` }
        setActiveKey(fresh.key)
        return [fresh]
      }
      setActiveKey(current => (current === key ? next[next.length - 1].key : current))
      return next
    })
  }, [])

  const markExited = useCallback((key: string) => {
    setExited(previous => new Set(previous).add(key))
  }, [])

  if (!active) return null

  return (
    <div className="terminal">
      <div className="terminal__tabs" role="tablist" aria-label="Sessions du terminal">
        {sessions.map(session => (
          <button
            key={session.key}
            type="button"
            role="tab"
            aria-selected={session.key === activeKey}
            className={cx(
              'terminal__tab',
              session.key === activeKey && 'is-active',
              exited.has(session.key) && 'is-exited',
            )}
            onClick={() => setActiveKey(session.key)}
          >
            <span>{session.label}</span>
            <span
              className="terminal__tab-close"
              role="presentation"
              onClick={event => { event.stopPropagation(); closeSession(session.key) }}
            >
              <X size={10} />
            </span>
            {session.key === activeKey && (
              <motion.span
                layoutId="terminal-tab-underline"
                className="terminal__tab-underline"
                transition={{ type: 'spring', stiffness: 480, damping: 34 }}
              />
            )}
          </button>
        ))}
        <Tooltip content="Nouveau shell" side="top">
          <IconButton label="Nouveau shell" size="xs" icon={<Plus size={12} />} onClick={addSession} />
        </Tooltip>
        <span className="terminal__tabs-fill" />
        <Tooltip content="Fermer ce shell" side="top">
          <IconButton
            label="Fermer ce shell"
            size="xs"
            icon={<Trash2 size={12} />}
            onClick={() => closeSession(activeKey)}
          />
        </Tooltip>
      </div>

      <div className="terminal__body">
        {sessions.map(session => (
          <TerminalInstance
            key={session.key}
            sessionKey={session.key}
            workspace={workspace}
            visible={session.key === activeKey}
            onExit={markExited}
          />
        ))}
      </div>
    </div>
  )
}
