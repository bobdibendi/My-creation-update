import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { cx } from './cx'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  /** Renders a leading status dot. */
  dot?: boolean
  icon?: ReactNode
  size?: 'sm' | 'md'
  className?: string
  title?: string
}

export function Badge({
  children, tone = 'neutral', dot = false, icon, size = 'md', className, title,
}: BadgeProps) {
  return (
    <span
      className={cx('ui-badge', `ui-badge--${tone}`, `ui-badge--${size}`, className)}
      title={title}
    >
      {dot && <span className="ui-badge__dot" aria-hidden />}
      {icon && <span className="ui-badge__icon">{icon}</span>}
      {children}
    </span>
  )
}

interface KbdProps {
  children: ReactNode
  className?: string
}

export function Kbd({ children, className }: KbdProps) {
  return <kbd className={cx('ui-kbd', className)}>{children}</kbd>
}

interface SpinnerProps {
  size?: number
  className?: string
  label?: string
}

/**
 * Indeterminate spinner drawn as an SVG arc.
 *
 * Framer drives the rotation so a reduced-motion preference stops it, unlike a
 * CSS keyframe animation that would keep spinning.
 */
export function Spinner({ size = 14, className, label }: SpinnerProps) {
  return (
    <motion.span
      className={cx('ui-spinner', className)}
      style={{ width: size, height: size }}
      animate={{ rotate: 360 }}
      transition={{ duration: 0.85, repeat: Infinity, ease: 'linear' }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" width={size} height={size}>
        <circle className="ui-spinner__track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.5" />
        <circle
          className="ui-spinner__head"
          cx="12"
          cy="12"
          r="9"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="18 46"
        />
      </svg>
    </motion.span>
  )
}

interface StatusDotProps {
  tone: BadgeTone
  /** Adds an expanding halo; use for live states only. */
  pulse?: boolean
  size?: number
  className?: string
}

export function StatusDot({ tone, pulse = false, size = 7, className }: StatusDotProps) {
  return (
    <span
      className={cx('ui-statusdot', `ui-statusdot--${tone}`, pulse && 'is-pulsing', className)}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

interface ProgressProps {
  /** 0 to 1. Omit for an indeterminate bar. */
  value?: number
  label?: string
  tone?: BadgeTone
  className?: string
}

export function Progress({ value, label, tone = 'accent', className }: ProgressProps) {
  const determinate = typeof value === 'number'
  const percent = determinate ? Math.min(100, Math.max(0, value * 100)) : 0
  return (
    <div
      className={cx('ui-progress', `ui-progress--${tone}`, !determinate && 'is-indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(percent) : undefined}
    >
      <motion.span
        className="ui-progress__fill"
        initial={false}
        animate={determinate ? { width: `${percent}%` } : undefined}
        transition={{ duration: 0.3, ease: [0.22, 0.61, 0.36, 1] }}
      />
    </div>
  )
}
