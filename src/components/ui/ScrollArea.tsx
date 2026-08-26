import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { cx } from './cx'

interface ScrollAreaProps {
  children: ReactNode
  className?: string
  /** Pins scroll to the bottom while the user has not scrolled away. */
  stickToBottom?: boolean
  /**
   * Bump this whenever content grows and the view should re-pin. A single
   * number keeps the effect's dependency list static.
   */
  revision?: number
  onScroll?: (event: UIEvent<HTMLDivElement>) => void
}

const BOTTOM_SLACK = 48

/**
 * Scroll container with themed scrollbars and optional bottom pinning.
 *
 * The pin is dropped as soon as the user scrolls up: yanking a reader back down
 * mid-stream is the single most irritating chat behaviour.
 */
export function ScrollArea({
  children, className, stickToBottom = false, revision = 0, onScroll,
}: ScrollAreaProps) {
  const ref = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const [shadow, setShadow] = useState(false)

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    pinnedRef.current = distance <= BOTTOM_SLACK
    setShadow(element.scrollTop > 4)
    onScroll?.(event)
  }, [onScroll])

  useEffect(() => {
    if (!stickToBottom || !pinnedRef.current) return
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [stickToBottom, revision])

  return (
    <div
      ref={ref}
      className={cx('ui-scroll', shadow && 'has-top-shadow', className)}
      onScroll={handleScroll}
    >
      {children}
    </div>
  )
}
