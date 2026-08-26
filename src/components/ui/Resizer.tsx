import { useCallback, useEffect, useRef, useState } from 'react'
import { cx } from './cx'

export type ResizeAxis = 'x' | 'y'

interface ResizerProps {
  /** `x` drags horizontally (a vertical bar), `y` drags vertically. */
  axis: ResizeAxis
  onResize: (delta: number) => void
  onDone?: () => void
  label: string
  /** Keyboard step in pixels. */
  step?: number
  className?: string
}

/**
 * Drag handle for panel sizing.
 *
 * Reports a delta rather than an absolute size so the owner keeps control of the
 * clamping rules, and pointer capture is used so the drag survives the cursor
 * leaving the 4px handle. Arrow keys resize too: a mouse-only splitter is not
 * operable by keyboard.
 */
export function Resizer({ axis, onResize, onDone, label, step = 16, className }: ResizerProps) {
  const [active, setActive] = useState(false)
  const lastRef = useRef(0)

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    lastRef.current = axis === 'x' ? event.clientX : event.clientY
    setActive(true)
  }, [axis])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return
    const current = axis === 'x' ? event.clientX : event.clientY
    const delta = current - lastRef.current
    if (delta === 0) return
    lastRef.current = current
    onResize(delta)
  }, [active, axis, onResize])

  const finish = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setActive(false)
    onDone?.()
  }, [active, onDone])

  useEffect(() => {
    if (!active) return
    // A grab cursor that only applies to the handle would be lost the moment the
    // pointer moves faster than the layout updates.
    const previous = document.body.style.cursor
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.classList.add('is-resizing')
    return () => {
      document.body.style.cursor = previous
      document.body.classList.remove('is-resizing')
    }
  }, [active, axis])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const keys = axis === 'x'
      ? { less: 'ArrowLeft', more: 'ArrowRight' }
      : { less: 'ArrowUp', more: 'ArrowDown' }
    if (event.key === keys.less) {
      event.preventDefault()
      onResize(-step)
    } else if (event.key === keys.more) {
      event.preventDefault()
      onResize(step)
    }
  }, [axis, onResize, step])

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      className={cx('ui-resizer', `ui-resizer--${axis}`, active && 'is-active', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onKeyDown={onKeyDown}
    >
      <span className="ui-resizer__grip" aria-hidden />
    </div>
  )
}
