import { useEffect } from 'react'
import { useDebug, type DebugKind } from '@/lib/debug'
import { cn, formatTime } from '@/lib/utils'
import { IconBug, IconRefresh, IconTrash, IconX } from './icons'

const KIND_LABEL: Record<DebugKind, string> = {
  request: 'REQUEST',
  response: 'RESPONSE',
  error: 'ERROR',
  tool: 'TOOL',
  info: 'INFO',
}

const KIND_CLASS: Record<DebugKind, string> = {
  // Диагностика не должна пестрить: все типы записей — спокойные серые бейджи.
  request: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  response: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200',
  tool: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
  info: 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
}

interface DebugConsoleProps {
  open: boolean
  onClose: () => void
}

/** Панель диагностики: последние запросы/ответы/ошибки (ключи замаскированы). */
export function DebugConsole({ open, onClose }: DebugConsoleProps) {
  const entries = useDebug((s) => s.entries)
  const clear = useDebug((s) => s.clear)
  const enabled = useDebug((s) => s.enabled)
  const setEnabled = useDebug((s) => s.setEnabled)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Debug Console"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-neutral-200 bg-white shadow-2xl sm:h-[80vh] sm:rounded-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center gap-2 border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <IconBug size={18} />
          <h3 className="flex-1 text-base font-semibold text-neutral-800 dark:text-neutral-100">Debug Console</h3>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={cn(
              'rounded-xl border px-2.5 py-1.5 text-xs transition',
              enabled
                ? 'border-neutral-400 bg-neutral-100 text-neutral-800 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100'
                : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
            )}
            title="Логирование запросов"
          >
            {enabled ? 'Логирование включено' : 'Логирование выключено'}
          </button>
          <button
            type="button"
            onClick={() => clear()}
            className="rounded-lg p-2 text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Очистить лог"
            aria-label="Очистить лог"
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label="Закрыть"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] text-neutral-400">
            <IconRefresh size={12} />
            API-ключи маскируются автоматически. Хранятся последние 40 записей.
          </p>

          {!entries.length && (
            <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
              Пока пусто — отправьте сообщение, и здесь появятся запросы к API.
            </p>
          )}

          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-950/40"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-md px-1.5 py-0.5 font-mono text-[10px] tracking-wide',
                      KIND_CLASS[entry.kind],
                    )}
                  >
                    {KIND_LABEL[entry.kind]}
                  </span>
                  <span className="flex-1 text-xs text-neutral-700 dark:text-neutral-200">{entry.title}</span>
                  <span className="text-[11px] text-neutral-400">{formatTime(entry.at)}</span>
                </div>
                {entry.lines.map((line, i) => (
                  <pre
                    key={i}
                    className="max-h-72 overflow-auto rounded-lg bg-neutral-900 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-neutral-100"
                  >
                    {line}
                  </pre>
                ))}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
