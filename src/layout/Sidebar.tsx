import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cx } from '../components/ui/cx'
import { riseIn } from '../animations'

interface SidebarProps {
  /** Heading text; rendered small and tracked out. */
  title: string
  /** Right side of the heading: icon buttons. */
  actions?: ReactNode
  /** Fixed block under the heading: a search field, a primary action. */
  toolbar?: ReactNode
  /** Scrolling content. */
  children: ReactNode
  /** Pinned to the bottom, outside the scroll area. */
  footer?: ReactNode
  className?: string
}

/**
 * Sidebar shell.
 *
 * The `.sidebar` class is asserted by `scripts/test-renderer.cjs`; keep it on
 * the root element. Sizing and collapsing are owned by `AppShell`, so this
 * component only lays out its own regions.
 */
export function Sidebar({ title, actions, toolbar, children, footer, className }: SidebarProps) {
  return (
    <aside className={cx('sidebar', className)} aria-label={title}>
      <div className="sidebar__head">
        <span className="sidebar__title">{title}</span>
        {actions && <div className="sidebar__actions">{actions}</div>}
      </div>
      {toolbar && <div className="sidebar__toolbar">{toolbar}</div>}
      <motion.div
        className="sidebar__body"
        variants={riseIn}
        initial="hidden"
        animate="visible"
      >
        {children}
      </motion.div>
      {footer && <div className="sidebar__foot">{footer}</div>}
    </aside>
  )
}

interface SidebarGroupProps {
  label: string
  /** Right side of the group heading. */
  aside?: ReactNode
  children: ReactNode
}

export function SidebarGroup({ label, aside, children }: SidebarGroupProps) {
  return (
    <div className="sidebar-group">
      <div className="sidebar-group__head">
        <span>{label}</span>
        {aside}
      </div>
      <div className="sidebar-group__body">{children}</div>
    </div>
  )
}
