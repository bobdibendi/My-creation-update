import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { transitions } from '../../animations'
import { cx } from './cx'

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  /** Right-aligned hint, typically a shortcut. */
  hint?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export interface MenuSeparator {
  id: string
  separator: true
}

export type MenuEntry = MenuItem | MenuSeparator

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'separator' in entry
}

interface ContextMenuProps {
  /** Viewport coordinates of the invocation point. */
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
  /** Optional heading, usually the target's name. */
  label?: string
}

const MARGIN = 8

/**
 * Floating menu at an arbitrary point.
 *
 * The position is clamped after mount using the measured size, so a menu opened
 * near the right or bottom edge flips back into view instead of being clipped.
 */
export function ContextMenu({ x, y, entries, onClose, label }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const maxX = window.innerWidth - rect.width - MARGIN
    const maxY = window.innerHeight - rect.height - MARGIN
    setPosition({
      x: Math.max(MARGIN, Math.min(x, maxX)),
      y: Math.max(MARGIN, Math.min(y, maxY)),
    })
    setReady(true)
  }, [x, y, entries.length])

  useEffect(() => {
    // Defer subscription by a frame: the click that opened the menu is still
    // propagating and would close it immediately.
    const attach = window.setTimeout(() => {
      window.addEventListener('mousedown', onClose)
      window.addEventListener('contextmenu', onClose)
      window.addEventListener('resize', onClose)
      window.addEventListener('blur', onClose)
    }, 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(attach)
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('contextmenu', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <motion.div
      ref={menuRef}
      role="menu"
      className="ui-menu ui-menu--floating"
      style={{ left: position.x, top: position.y, visibility: ready ? 'visible' : 'hidden' }}
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={transitions.fast}
      onMouseDown={event => event.stopPropagation()}
    >
      {label && <div className="ui-menu__label">{label}</div>}
      {entries.map(entry => (
        isSeparator(entry) ? (
          <div key={entry.id} className="ui-menu__sep" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={cx('ui-menu__item', entry.danger && 'is-danger')}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.icon && <span className="ui-menu__icon">{entry.icon}</span>}
            <span className="ui-menu__text">{entry.label}</span>
            {entry.hint && <span className="ui-menu__hint">{entry.hint}</span>}
          </button>
        )
      ))}
    </motion.div>,
    document.body,
  )
}

interface DropdownProps {
  open: boolean
  onClose: () => void
  /** The control that toggles the menu. Must stay mounted. */
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  /** Menu width; defaults to fitting the content. */
  width?: number
  className?: string
}

/**
 * Menu anchored under its trigger.
 *
 * Kept in flow (absolutely positioned) rather than portalled: dropdowns here
 * live in headers that do not clip, and staying in the DOM subtree lets a single
 * outside-click check on the wrapper handle dismissal.
 */
export function Dropdown({
  open, onClose, trigger, children, align = 'start', width, className,
}: DropdownProps) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const attach = window.setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(attach)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div ref={wrapRef} className={cx('ui-dropdown', className)}>
      {trigger}
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            className={cx('ui-menu', 'ui-menu--anchored', `is-${align}`)}
            style={width ? { width } : undefined}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={transitions.fast}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

interface MenuGroupProps {
  label: string
  /** Right side of the group heading: a status chip, a count. */
  aside?: ReactNode
  children: ReactNode
}

export function MenuGroup({ label, aside, children }: MenuGroupProps) {
  return (
    <div className="ui-menu__group">
      <div className="ui-menu__group-head">
        <span>{label}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

interface MenuButtonProps {
  onClick: () => void
  icon?: ReactNode
  children: ReactNode
  hint?: ReactNode
  selected?: boolean
  danger?: boolean
  disabled?: boolean
}

export function MenuButton({
  onClick, icon, children, hint, selected = false, danger = false, disabled = false,
}: MenuButtonProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-current={selected || undefined}
      className={cx('ui-menu__item', selected && 'is-selected', danger && 'is-danger')}
      onClick={onClick}
    >
      {icon && <span className="ui-menu__icon">{icon}</span>}
      <span className="ui-menu__text">{children}</span>
      {hint && <span className="ui-menu__hint">{hint}</span>}
    </button>
  )
}
