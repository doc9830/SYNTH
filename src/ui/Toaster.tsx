import { cn } from '@/lib/utils'
import { useToasts } from '@/lib/toast'
import { IconAlert, IconCheck, IconX } from './icons'

/** Плавающие уведомления (копирование, ошибки API, предупреждения). */
export function Toaster() {
  const items = useToasts((s) => s.items)
  const dismiss = useToasts((s) => s.dismiss)

  if (!items.length) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            'pointer-events-auto flex w-full max-w-lg items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg backdrop-blur',
            toast.kind === 'error'
              ? 'border-red-300 bg-red-50/95 text-red-900 dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-100'
              : toast.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50/95 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/90 dark:text-emerald-100'
                : 'border-slate-300 bg-white/95 text-slate-800 dark:border-slate-700 dark:bg-slate-900/95 dark:text-slate-100',
          )}
        >
          <span className="mt-0.5 shrink-0">
            {toast.kind === 'error' ? <IconAlert size={16} /> : <IconCheck size={16} />}
          </span>
          <span className="flex-1 whitespace-pre-wrap break-words">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
            aria-label="Закрыть уведомление"
          >
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
