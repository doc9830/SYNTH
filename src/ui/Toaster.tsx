import { cn } from '@/lib/utils'
import { useToasts } from '@/lib/toast'
import { IconAlert, IconCheck, IconX } from './icons'

/** Плавающие уведомления (копирование, ошибки API, предупреждения). */
export function Toaster() {
  const items = useToasts((s) => s.items)
  const dismiss = useToasts((s) => s.dismiss)

  if (!items.length) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[max(0.5rem,env(safe-area-inset-top))] z-50 flex flex-col items-center gap-2 px-4">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            'pointer-events-auto flex w-full max-w-lg items-start gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg backdrop-blur',
            toast.kind === 'error'
              ? 'border-red-300 bg-red-50/95 text-red-900 dark:border-red-900/60 dark:bg-red-950/90 dark:text-red-100'
              : 'border-neutral-300 bg-white/95 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/95 dark:text-neutral-100',
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
