import { forwardRef, type ReactNode } from 'react'
import { motion, type HTMLMotionProps } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { cx } from './cx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'outline'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

/**
 * Props extend `HTMLMotionProps` rather than `ButtonHTMLAttributes`: React's
 * `onDrag` and Framer's `onDrag` have incompatible signatures, so mixing the two
 * bases makes the spread untypable.
 */
interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Renders a spinner and blocks activation. */
  loading?: boolean
  /** Stretches to the container width. */
  block?: boolean
  /** Leading icon slot. */
  icon?: ReactNode
  /** Trailing slot, typically a chevron or a shortcut hint. */
  trailing?: ReactNode
  children?: ReactNode
}

/**
 * The single button primitive.
 *
 * Motion lives on the element itself rather than in CSS so hover, press and
 * disabled states cannot desynchronise, and `MotionConfig` can neutralise them
 * all at once when reduced motion is requested.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary', size = 'md', loading = false, block = false,
    icon, trailing, children, className, disabled, type = 'button', ...rest
  },
  ref,
) {
  const inert = disabled || loading

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={inert}
      aria-busy={loading || undefined}
      className={cx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', className)}
      whileHover={inert ? undefined : { y: -1 }}
      whileTap={inert ? undefined : { y: 0, scale: 0.975 }}
      {...rest}
    >
      {loading
        ? <Loader2 className="ui-btn__spinner" aria-hidden />
        : icon && <span className="ui-btn__icon">{icon}</span>}
      {children !== undefined && <span className="ui-btn__label">{children}</span>}
      {trailing && <span className="ui-btn__trailing">{trailing}</span>}
    </motion.button>
  )
})

interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  /** Required: icon-only controls must still be announced. */
  label: string
  icon: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  active?: boolean
  loading?: boolean
}

/** Square, icon-only button. `label` feeds both the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label, icon, variant = 'ghost', size = 'md', active = false, loading = false,
    className, disabled, type = 'button', ...rest
  },
  ref,
) {
  const inert = disabled || loading
  return (
    <motion.button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      disabled={inert}
      className={cx('ui-iconbtn', `ui-iconbtn--${variant}`, `ui-iconbtn--${size}`, active && 'is-active', className)}
      whileHover={inert ? undefined : { scale: 1.06 }}
      whileTap={inert ? undefined : { scale: 0.92 }}
      {...rest}
    >
      {loading ? <Loader2 className="ui-btn__spinner" aria-hidden /> : icon}
    </motion.button>
  )
})
