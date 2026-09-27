import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@/types'
import {
  CONTEXT_PRESETS,
  contextPercent,
  formatTokens,
  measureContext,
  type ContextUsage,
} from '@/lib/context'
import { sanitizeContextWindow, useSettings } from '@/lib/settings'
import { cn } from '@/lib/utils'
import { btnCls, inputCls } from './controls'
import { Sheet } from './Sheet'

/**
 * Заполнение контекста в шапке чата: «10/32k» и мини-прогрессбар.
 *
 * По тапу открывается шторка «Контекст»: видно, сколько токенов уйдёт в
 * следующий запрос, и настраивается размер окна модели. История длиннее окна
 * обрезается агентом (src/lib/agent.ts) — старые сообщения не отправляются,
 * системный промпт и память сохраняются.
 */

/** Замер не пересчитываем на каждый кадр стрима — раз в 400 мс достаточно. */
const MEASURE_THROTTLE_MS = 400

interface ContextMeterProps {
  messages: ChatMessage[]
}

export function ContextMeter({ messages }: ContextMeterProps) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<ContextUsage>(() => measureContext(settings, messages))
  const [draft, setDraft] = useState('')
  const measuredAt = useRef(0)

  useEffect(() => {
    const delay = MEASURE_THROTTLE_MS - (Date.now() - measuredAt.current)
    const measure = () => {
      measuredAt.current = Date.now()
      setUsage(measureContext(settings, messages))
    }
    if (delay <= 0) {
      measure()
      return
    }
    const timer = window.setTimeout(measure, delay)
    return () => window.clearTimeout(timer)
  }, [settings, messages])

  // при открытии шторки подставляем текущее окно в поле «своё значение»
  useEffect(() => {
    if (open) setDraft(settings.contextWindow ? String(settings.contextWindow) : '')
  }, [open, settings.contextWindow])

  const percent = contextPercent(usage.used, usage.limit)
  const limitLabel = usage.limit > 0 ? formatTokens(usage.limit) : '∞'

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Контекст: сколько токенов уходит в запрос и сколько влезает в окно модели"
        aria-label={`Контекст ${formatTokens(usage.used)} из ${limitLabel}`}
        className="-ml-1 flex shrink-0 items-center gap-1.5 rounded-lg px-1.5 py-0.5 transition hover:bg-neutral-200/70 active:bg-neutral-200 dark:hover:bg-neutral-800"
      >
        <span className="font-mono text-[11px] leading-none tabular-nums text-neutral-500 dark:text-neutral-400">
          {formatTokens(usage.used)}/{limitLabel}
        </span>
        {usage.limit > 0 && (
          <span className="h-1 w-8 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
            <span
              className={cn('block h-full rounded-full transition-all', barToneCls(percent))}
              style={{ width: `${percent}%` }}
            />
          </span>
        )}
      </button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Контекст"
        description="Сколько токенов уходит в запрос и сколько влезает в окно модели. Диалог длиннее окна обрезается — самые старые сообщения не отправляются."
      >
        <div className="space-y-5">
          <UsageCard usage={usage} count={messages.length} />

          <section>
            <h4 className="mb-1 px-1 text-[11px] font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
              Размер окна
            </h4>
            <div className="grid grid-cols-2 gap-2">
              {CONTEXT_PRESETS.map((preset) => (
                <PresetButton
                  key={preset}
                  label={formatTokens(preset)}
                  active={settings.contextWindow === preset}
                  onClick={() => update({ contextWindow: preset })}
                />
              ))}
              <PresetButton
                label="∞ без ограничения"
                active={settings.contextWindow === 0}
                onClick={() => update({ contextWindow: 0 })}
                className="col-span-2"
              />
            </div>
          </section>

          <section>
            <h4 className="mb-1 px-1 text-[11px] font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
              Своё значение
            </h4>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1024}
                step={1024}
                inputMode="numeric"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="например 200000"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() =>
                  update({ contextWindow: draft.trim() ? sanitizeContextWindow(draft) : 0 })
                }
                className={cn(btnCls, 'shrink-0')}
              >
                Применить
              </button>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              Ставьте реальное окно модели — оно указано в её описании у провайдера (8k, 32k,
              128k…). Приложение показывает заполнение и обрезает запрос, увеличить лимит модели
              оно не может.
            </p>
          </section>
        </div>
      </Sheet>
    </>
  )
}

/** Цвет полосы: спокойный до 80%, жёлтый до 95%, красный на переполнении. */
function barToneCls(percent: number): string {
  if (percent >= 95) return 'bg-red-500'
  if (percent >= 80) return 'bg-amber-500'
  return 'bg-neutral-500 dark:bg-neutral-300'
}

function PresetButton({
  label,
  active,
  onClick,
  className,
}: {
  label: string
  active: boolean
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-xl border px-3 py-2 text-sm transition',
        active
          ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
          : 'border-neutral-300 text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800',
        className,
      )}
    >
      {label}
    </button>
  )
}

/** Сводка: сколько уйдёт в запрос, сколько всего накопилось и что обрезано. */
function UsageCard({ usage, count }: { usage: ContextUsage; count: number }) {
  const percent = contextPercent(usage.used, usage.limit)
  const limitLabel = usage.limit > 0 ? formatTokens(usage.limit) : '∞'
  const reserve = usage.limit > 0 ? Math.max(0, usage.limit - usage.budget) : 0

  return (
    <div className="rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
          В запрос уйдёт ~{formatTokens(usage.used)}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-500 dark:text-neutral-400">
          {usage.limit > 0 ? `${percent}% окна` : 'без ограничения'}
        </span>
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
        <div
          className={cn('h-full rounded-full transition-all', barToneCls(percent))}
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="mt-2.5 space-y-1 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        <li>
          Окно: {limitLabel}
          {reserve > 0 ? ` · под ответ зарезервировано ${formatTokens(reserve)}` : ''}
        </li>
        <li>Сообщений в диалоге: {count}</li>
        {usage.droppedMessages > 0 && (
          <li className="text-amber-600 dark:text-amber-400">
            Обрезано по окну: {usage.droppedMessages} сообщ. (~{formatTokens(usage.droppedTokens)})
          </li>
        )}
        {usage.full > usage.used && <li>Весь диалог: ~{formatTokens(usage.full)}</li>}
        {usage.exact ? (
          <li>Провайдер в прошлом ответе: {usage.exact.toLocaleString('ru-RU')} токенов</li>
        ) : null}
        <li>Числа оценочные: считаем по символам, токенизатора провайдера у приложения нет.</li>
      </ul>
    </div>
  )
}
