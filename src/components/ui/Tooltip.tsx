import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { transitions } from '../../animations'
import { cx } from './cx'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  /** Delay before showing, in milliseconds. */
  delay?: number
  /** Dimmed hint after the label, typically a keyboard shortcut. */
  shortcut?: string
  children: ReactNode
  disabled?: boolean
  className?: string
}

const GAP = 8

/**
 * Tooltip anchored to a wrapper around its children.
 *
 * The bubble is portalled with fixed coordinates measured from the wrapper:
 * every panel in this app clips its overflow, so an in-flow tooltip would be
 * cut off. Wrapping rather than cloning the child keeps the ref handling honest
 * and works with any content, including plain text.
 */
export function Tooltip({
  content, side = 'top', delay = 260, shortcut, children, disabled = false, className,
}: TooltipProps) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const id = useId()

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const place = useCallback(() => {
    const element = anchorRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const positions: Record<TooltipSide, { x: number; y: number }> = {
      top: { x: rect.left + rect.width / 2, y: rect.top - GAP },
      bottom: { x: rect.left + rect.width / 2, y: rect.bottom + GAP },
      left: { x: rect.left - GAP, y: rect.top + rect.height / 2 },
      right: { x: rect.right + GAP, y: rect.top + rect.height / 2 },
    }
    setPoint(positions[side])
  }, [side])

  const show = useCallback(() => {
    if (disabled) return
    clear()
    timerRef.current = window.setTimeout(place, delay)
  }, [disabled, clear, place, delay])

  const hide = useCallback(() => {
    clear()
    setPoint(null)
  }, [clear])

  const offsets: Record<TooltipSide, string> = {
    top: 'translate(-50%, -100%)',
    bottom: 'translate(-50%, 0)',
    left: 'translate(-100%, -50%)',
    right: 'translate(0, -50%)',
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={cx('ui-tooltip-anchor', className)}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
        aria-describedby={point ? id : undefined}
      >
        {children}
      </span>
      {createPortal(
        <AnimatePresence>
          {point && (
            <motion.div
              id={id}
              role="tooltip"
              className={cx('ui-tooltip', `ui-tooltip--${side}`)}
              style={{ left: point.x, top: point.y, transform: offsets[side] }}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={transitions.fast}
            >
              <span className="ui-tooltip__label">{content}</span>
              {shortcut && <span className="ui-tooltip__kbd">{shortcut}</span>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
