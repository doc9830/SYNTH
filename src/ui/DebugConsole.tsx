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
  request: 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-200',
  response: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
  error: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200',
  tool: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200',
  info: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
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
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Debug Console"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-slate-200 bg-white shadow-2xl sm:h-[80vh] sm:rounded-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <IconBug size={18} />
          <h3 className="flex-1 text-base font-semibold text-slate-800 dark:text-slate-100">Debug Console</h3>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={cn(
              'rounded-xl border px-2.5 py-1.5 text-xs transition',
              enabled
                ? 'border-emerald-300 text-emerald-700 dark:border-emerald-900/60 dark:text-emerald-300'
                : 'border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400',
            )}
            title="Логирование запросов"
          >
            {enabled ? 'Логирование включено' : 'Логирование выключено'}
          </button>
          <button
            type="button"
            onClick={() => clear()}
            className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Очистить лог"
            aria-label="Очистить лог"
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Закрыть"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 flex items-center gap-1.5 text-[11px] text-slate-400">
            <IconRefresh size={12} />
            API-ключи маскируются автоматически. Хранятся последние 40 записей.
          </p>

          {!entries.length && (
            <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              Пока пусто — отправьте сообщение, и здесь появятся запросы к API.
            </p>
          )}

          <ul className="space-y-3">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-950/40"
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
                  <span className="flex-1 text-xs text-slate-700 dark:text-slate-200">{entry.title}</span>
                  <span className="text-[11px] text-slate-400">{formatTime(entry.at)}</span>
                </div>
                {entry.lines.map((line, i) => (
                  <pre
                    key={i}
                    className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-slate-100"
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
