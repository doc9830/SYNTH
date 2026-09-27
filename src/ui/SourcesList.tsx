import { useMemo, useState } from 'react'
import type { SearchResult } from '@/types'
import { IconChevronDown, IconGlobe } from './icons'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Список источников веб-поиска (свёрнут в 4 строки по умолчанию). */
export function SourcesList({ sources, title = 'Источники' }: { sources: SearchResult[]; title?: string }) {
  const [expanded, setExpanded] = useState(false)
  const visible = useMemo(
    () => (expanded ? sources : sources.slice(0, 4)),
    [expanded, sources],
  )

  if (!sources.length) return null

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm dark:border-slate-700/70 dark:bg-slate-900/50">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        <IconGlobe size={14} />
        {title}
        <span className="text-slate-400">({sources.length})</span>
      </div>

      <ol className="space-y-1.5">
        {visible.map((s, i) => (
          <li key={`${s.url}-${i}`} className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-xs text-slate-400">{i + 1}</span>
            <div className="min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block truncate font-medium text-blue-700 hover:underline dark:text-blue-400"
                title={s.title}
              >
                {s.title || s.url}
              </a>
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {hostOf(s.url)}
                {s.snippet ? ` — ${s.snippet.slice(0, 140)}${s.snippet.length > 140 ? '…' : ''}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ol>

      {sources.length > 4 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
        >
          <IconChevronDown size={13} className={expanded ? 'rotate-180 transition' : 'transition'} />
          {expanded ? 'Свернуть' : `Показать все (${sources.length})`}
        </button>
      )}
    </div>
  )
}
