import { useState } from 'react'
import { toolLabel } from '@/tools/registry'
import type { ToolCallRecord } from '@/types'
import { formatDuration } from '@/lib/utils'
import { IconAlert, IconCheck, IconChevronDown } from './icons'
import { SourcesList } from './SourcesList'

function StatusIcon({ status }: { status: ToolCallRecord['status'] }) {
  if (status === 'running') {
    return (
      <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
    )
  }
  if (status === 'error') return <IconAlert size={15} className="shrink-0 text-red-500" />
  return <IconCheck size={15} className="shrink-0 text-emerald-500" />
}

function ToolRow({ record }: { record: ToolCallRecord }) {
  const [open, setOpen] = useState(false)
  const label = toolLabel(record.name)
  const duration =
    record.finishedAt !== undefined
      ? formatDuration(Math.max(0, record.finishedAt - record.startedAt))
      : undefined

  const statusText =
    record.status === 'running'
      ? label.running
      : record.status === 'error'
        ? label.failed
        : label.done

  return (
    <div className="rounded-xl border border-slate-200 bg-white/60 dark:border-slate-700/70 dark:bg-slate-900/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        aria-expanded={open}
      >
        <StatusIcon status={record.status} />
        <span aria-hidden="true">{label.icon}</span>
        <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
          {statusText}
          {record.summary ? <span className="text-slate-500 dark:text-slate-400"> · {record.summary}</span> : null}
        </span>
        {duration && <span className="shrink-0 text-xs text-slate-400">{duration}</span>}
        <IconChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} />
      </button>

      {open && (
        <div className="space-y-2 border-t border-slate-200 px-3 py-2 dark:border-slate-700/70">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Аргументы
            </div>
            <pre className="max-h-52 overflow-auto rounded-lg bg-slate-100 p-2 font-mono text-[12px] text-slate-700 dark:bg-slate-950/60 dark:text-slate-200">
              {record.argsPretty || '{}'}
            </pre>
          </div>

          {record.status === 'error' && record.error && (
            <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-200">
              {record.error}
            </div>
          )}

          {record.resultText && (
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Что получила модель
              </div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-100 p-2 font-mono text-[12px] text-slate-700 dark:bg-slate-950/60 dark:text-slate-200">
                {record.resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Панель инструментов: пользователь видит ЧТО модель делает (поиск/картинки),
 * но без сырых tool_call'ов в основном тексте ответа.
 */
export function ToolActivity({ records }: { records: ToolCallRecord[] }) {
  if (!records.length) return null

  const sources = records.flatMap((r) => r.sources ?? [])
  const uniqueSources = sources.filter(
    (s, i, arr) => arr.findIndex((x) => x.url === s.url) === i,
  )

  return (
    <div className="mb-2 space-y-1.5">
      {records.map((r) => (
        <ToolRow key={r.id} record={r} />
      ))}
      {uniqueSources.length > 0 && <SourcesList sources={uniqueSources} />}
    </div>
  )
}
