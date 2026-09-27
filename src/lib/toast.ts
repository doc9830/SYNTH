import { create } from 'zustand'
import { uid } from './utils'

export type ToastKind = 'info' | 'success' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  message: string
}

interface ToastState {
  items: Toast[]
  notify: (message: string, kind?: ToastKind) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set) => ({
  items: [],
  notify: (message, kind = 'info') => {
    const toast: Toast = { id: uid('toast'), kind, message }
    set((s) => ({ items: [...s.items, toast].slice(-3) }))
    window.setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== toast.id) }))
    }, kind === 'error' ? 9000 : 4500)
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

/** Уведомление вне React (из обработчиков и agent loop). */
export function notify(message: string, kind: ToastKind = 'info'): void {
  useToasts.getState().notify(message, kind)
}
