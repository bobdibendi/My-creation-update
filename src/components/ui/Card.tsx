import type { ReactNode } from 'react'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { cx } from './cx'
import { riseIn } from '../../animations'

interface CardProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
  /** Adds hover lift and a pointer cursor. */
  interactive?: boolean
  /** Applies the translucent glass fill instead of a solid surface. */
  glass?: boolean
  /** Raises the elevation shadow. */
  raised?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  children?: ReactNode
}

export function Card({
  interactive = false, glass = false, raised = false, padding = 'md',
  className, children, ...rest
}: CardProps) {
  return (
    <motion.div
      variants={riseIn}
      initial="hidden"
      animate="visible"
      whileHover={interactive ? { y: -3 } : undefined}
      whileTap={interactive ? { y: -1, scale: 0.995 } : undefined}
      className={cx(
        'ui-card',
        `ui-card--pad-${padding}`,
        interactive && 'is-interactive',
        glass && 'is-glass',
        raised && 'is-raised',
        className,
      )}
      {...rest}
    >
      {children}
    </motion.div>
  )
}

interface SectionProps {
  title: string
  /** Right-aligned slot in the header: counters, buttons, badges. */
  actions?: ReactNode
  description?: string
  children: ReactNode
  className?: string
}

/** Titled block used across Settings and Analysis. */
export function Section({ title, actions, description, children, className }: SectionProps) {
  return (
    <section className={cx('ui-section', className)}>
      <header className="ui-section__head">
        <div>
          <h3 className="ui-section__title">{title}</h3>
          {description && <p className="ui-section__desc">{description}</p>}
        </div>
        {actions && <div className="ui-section__actions">{actions}</div>}
      </header>
      <div className="ui-section__body">{children}</div>
    </section>
  )
}

interface EmptyStateProps {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
  compact?: boolean
}

export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <motion.div
      className={cx('ui-empty', compact && 'is-compact')}
      variants={riseIn}
      initial="hidden"
      animate="visible"
    >
      <span className="ui-empty__icon" aria-hidden>{icon}</span>
      <strong className="ui-empty__title">{title}</strong>
      {description && <span className="ui-empty__desc">{description}</span>}
      {action && <div className="ui-empty__action">{action}</div>}
    </motion.div>
  )
}
