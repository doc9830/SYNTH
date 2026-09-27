import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { IconChevronDown, IconSparkles } from './icons'

/**
 * Живые состояния генерации — как в ChatGPT / Claude / Gemini:
 *
 *  • StreamStatus   — тонкая строка активности («Думаю…», «Ищу в интернете…»,
 *                     «Пишу код…») с пульсирующей точкой и таймером;
 *  • ThinkingPanel  — блок размышлений модели: во время стрима раскрыт и
 *                     прокручивается вниз, после ответа сворачивается
 *                     в строку «Размышления модели · 12 с».
 */

/** «12 с» / «1 мин 5 с» — без десятых, в отличие от formatDuration. */
function formatElapsed(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total} с`
  return `${Math.floor(total / 60)} мин ${total % 60} с`
}

export function StreamStatus({
  label,
  icon,
  elapsedMs = 0,
  className,
}: {
  label: string
  icon?: string
  elapsedMs?: number
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-1.5 flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400',
        className,
      )}
    >
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neutral-400/50" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-neutral-500 dark:bg-neutral-400" />
      </span>
      {icon && <span aria-hidden="true">{icon}</span>}
      <span className="text-shimmer font-medium">{label}</span>
      {elapsedMs > 0 && <span className="text-xs text-neutral-400">{formatElapsed(elapsedMs)}</span>}
    </div>
  )
}

export function ThinkingPanel({
  text,
  streaming,
  label,
  elapsedMs,
  answerStarted = false,
  className,
}: {
  text: string
  /** true — мысль печатается прямо сейчас */
  streaming: boolean
  /** Подпись активной фазы, пока идёт стрим */
  label: string
  /** Итоговое время размышлений (для завершённого сообщения) */
  elapsedMs?: number
  /** Пошёл текст ответа — блок мыслей сворачивается, подпись фазы остаётся */
  answerStarted?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(streaming && !answerStarted)
  const [now, setNow] = useState(() => Date.now())
  const startedAtRef = useRef<number | null>(streaming ? Date.now() : null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Пока модель думает — блок раскрыт; начался ответ или стрим закончился — сворачиваем
  useEffect(() => {
    if (streaming) {
      startedAtRef.current = startedAtRef.current ?? Date.now()
      setOpen(!answerStarted)
      return
    }
    startedAtRef.current = null
    setOpen(false)
  }, [streaming, answerStarted])

  // тикаем таймером, пока модель думает
  useEffect(() => {
    if (!streaming) return
    const id = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [streaming])

  // автопрокрутка мыслей к последней строке
  useEffect(() => {
    if (!streaming || !open) return
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text, streaming, open])

  const live = streaming && startedAtRef.current !== null ? now - startedAtRef.current : 0
  const frozen = !streaming || answerStarted
  const seconds = frozen ? (elapsedMs ?? live) : live

  return (
    <div
      className={cn(
        'mb-2 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50/70 dark:border-neutral-700/70 dark:bg-neutral-900/40',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="relative flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-700 dark:text-neutral-200"
      >
        <IconSparkles size={15} />
        <span className="min-w-0 flex-1 truncate">
          {streaming ? (
            <span className="text-shimmer font-medium">{label}</span>
          ) : (
            <>
              Размышления модели
              {seconds > 0 ? ` · ${formatElapsed(seconds)}` : ''}
            </>
          )}
        </span>
        {streaming && seconds > 0 && (
          <span className="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
            {formatElapsed(seconds)}
          </span>
        )}
        <IconChevronDown size={14} className={cn('shrink-0 transition', open && 'rotate-180')} />
        {streaming && (
          <span className="thinking-sweep pointer-events-none absolute inset-x-0 bottom-0 h-px" />
        )}
      </button>

      {open && (
        <div
          ref={bodyRef}
          className="max-h-64 overflow-auto border-t border-neutral-200 px-3 py-2 text-sm whitespace-pre-wrap text-neutral-700 dark:border-neutral-700/70 dark:text-neutral-300"
        >
          {text}
        </div>
      )}
    </div>
  )
}
