import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

export type ToastTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  /** Milliseconds before auto-dismiss. 0 keeps it until dismissed. */
  duration?: number
  icon?: ReactNode
  action?: ToastAction
}

export interface ToastRecord extends ToastOptions {
  id: string
  tone: ToastTone
  duration: number
  createdAt: number
}

export interface ToastContextValue {
  toasts: ToastRecord[]
  /** Returns the id so a caller can dismiss it early. */
  notify: (options: ToastOptions) => string
  dismiss: (id: string) => void
  clear: () => void
}

export const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast doit être utilisé dans ToastProvider')
  return value
}
