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
    <div className="mt-2 rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 text-sm dark:border-neutral-700/70 dark:bg-neutral-900/50">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        <IconGlobe size={14} />
        {title}
        <span className="text-neutral-400">({sources.length})</span>
      </div>

      <ol className="space-y-1.5">
        {visible.map((s, i) => (
          <li key={`${s.url}-${i}`} className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-xs text-neutral-400">{i + 1}</span>
            <div className="min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="block truncate font-medium text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-500 dark:text-neutral-200 dark:decoration-neutral-600 dark:hover:decoration-neutral-400"
                title={s.title}
              >
                {s.title || s.url}
              </a>
              <div className="truncate text-xs text-neutral-500 dark:text-neutral-400">
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
          className="mt-2 flex items-center gap-1 text-xs font-medium text-neutral-600 hover:underline dark:text-neutral-300"
        >
          <IconChevronDown size={13} className={expanded ? 'rotate-180 transition' : 'transition'} />
          {expanded ? 'Свернуть' : `Показать все (${sources.length})`}
        </button>
      )}
    </div>
  )
}
