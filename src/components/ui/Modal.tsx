import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import { fade, modalIn } from '../../animations'
import { cx } from './cx'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Small line under the title. */
  subtitle?: string
  icon?: ReactNode
  /** Right side of the header, before the close button. */
  headerActions?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  children: ReactNode
  className?: string
  /** Set false for destructive flows that must not be dismissed by accident. */
  dismissable?: boolean
}

/**
 * Centred dialog with a blurred scrim.
 *
 * Focus is moved into the dialog on open and restored on close, and the page
 * behind is locked from scrolling. Escape and scrim clicks close it unless
 * `dismissable` is false.
 */
export function Modal({
  open, onClose, title, subtitle, icon, headerActions, footer,
  size = 'md', children, className, dismissable = true,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTimer = window.setTimeout(() => {
      const target = cardRef.current?.querySelector<HTMLElement>(
        'input,textarea,select,button,[href],[tabindex]:not([tabindex="-1"])',
      )
      ;(target ?? cardRef.current)?.focus()
    }, 30)

    return () => {
      window.clearTimeout(focusTimer)
      document.body.style.overflow = previousOverflow
      restoreRef.current?.focus?.()
    }
  }, [open])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && dismissable) {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    // Keep Tab inside the dialog.
    const focusable = cardRef.current?.querySelectorAll<HTMLElement>(
      'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
    )
    if (!focusable || focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    }
  }, [dismissable, onClose])

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="ui-scrim"
          variants={fade}
          initial="hidden"
          animate="visible"
          exit="exit"
          onMouseDown={event => {
            if (dismissable && event.target === event.currentTarget) onClose()
          }}
        >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-label={typeof title === 'string' ? title : undefined}
            tabIndex={-1}
            className={cx('ui-modal', `ui-modal--${size}`, className)}
            variants={modalIn}
            initial="hidden"
            animate="visible"
            exit="exit"
            onKeyDown={onKeyDown}
          >
            <header className="ui-modal__head">
              {icon && <span className="ui-modal__icon">{icon}</span>}
              <div className="ui-modal__titles">
                <h2 className="ui-modal__title">{title}</h2>
                {subtitle && <p className="ui-modal__subtitle">{subtitle}</p>}
              </div>
              {headerActions && <div className="ui-modal__head-actions">{headerActions}</div>}
              <IconButton label="Fermer" icon={<X size={15} />} onClick={onClose} />
            </header>

            <div className="ui-modal__body">{children}</div>

            {footer && <footer className="ui-modal__foot">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
