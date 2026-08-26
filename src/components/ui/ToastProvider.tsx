import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from 'lucide-react'
import { ToastContext, type ToastContextValue, type ToastOptions, type ToastRecord, type ToastTone } from './toast-context'
import { IconButton } from './Button'
import { toastIn } from '../../animations'
import { cx } from './cx'

const DEFAULT_DURATION = 4600
const MAX_VISIBLE = 4

const TONE_ICON: Record<ToastTone, ReactNode> = {
  neutral: <Info size={15} />,
  accent: <Info size={15} />,
  info: <Info size={15} />,
  success: <CheckCircle2 size={15} />,
  warning: <TriangleAlert size={15} />,
  danger: <XCircle size={15} />,
}

/**
 * Notification host.
 *
 * Timers are tracked in a ref keyed by id so a manual dismiss cancels its
 * pending auto-dismiss and cannot double-remove.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([])
  const timers = useRef(new Map<string, number>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts(previous => previous.filter(toast => toast.id !== id))
  }, [])

  const notify = useCallback((options: ToastOptions) => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const record: ToastRecord = {
      ...options,
      id,
      tone: options.tone ?? 'neutral',
      duration: options.duration ?? DEFAULT_DURATION,
      createdAt: Date.now(),
    }
    setToasts(previous => [...previous, record].slice(-MAX_VISIBLE))
    if (record.duration > 0) {
      timers.current.set(id, window.setTimeout(() => dismiss(id), record.duration))
    }
    return id
  }, [dismiss])

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
    timers.current.clear()
    setToasts([])
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, notify, dismiss, clear }),
    [toasts, notify, dismiss, clear],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts" role="region" aria-label="Notifications">
        <AnimatePresence initial={false}>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              layout
              className={cx('ui-toast', `ui-toast--${toast.tone}`)}
              variants={toastIn}
              initial="hidden"
              animate="visible"
              exit="exit"
              role={toast.tone === 'danger' ? 'alert' : 'status'}
            >
              <span className="ui-toast__icon">{toast.icon ?? TONE_ICON[toast.tone]}</span>
              <div className="ui-toast__body">
                <strong className="ui-toast__title">{toast.title}</strong>
                {toast.description && <span className="ui-toast__desc">{toast.description}</span>}
                {toast.action && (
                  <button
                    type="button"
                    className="ui-toast__action"
                    onClick={() => {
                      dismiss(toast.id)
                      toast.action?.onClick()
                    }}
                  >
                    {toast.action.label}
                  </button>
                )}
              </div>
              <IconButton
                label="Ignorer"
                size="xs"
                icon={<X size={13} />}
                onClick={() => dismiss(toast.id)}
              />
              {toast.duration > 0 && (
                <motion.span
                  className="ui-toast__timer"
                  initial={{ scaleX: 1 }}
                  animate={{ scaleX: 0 }}
                  transition={{ duration: toast.duration / 1000, ease: 'linear' }}
                />
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
