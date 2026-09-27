import { useEffect, useMemo, useState } from 'react'
import { looksLikeImageModel, useModelCatalog, type ModelKind } from '@/lib/modelCatalog'
import { useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { IconCheck, IconChevronDown, IconRefresh, IconSearch, IconSparkles } from './icons'
import { Sheet } from './Sheet'

/**
 * Селектор моделей: список приходит из GET /v1/models настроенного подключения,
 * кэшируется и доступен без ручного ввода. Один компонент на чат-модель
 * (крупный «field») и на быстрый переключатель в шапке («chip»).
 */
interface ModelSelectProps {
  kind: ModelKind
  value: string
  onChange: (value: string) => void
  variant?: 'field' | 'chip'
  placeholder?: string
  className?: string
}

export function ModelSelect({
  kind,
  value,
  onChange,
  variant = 'field',
  placeholder = 'Выбрать модель',
  className,
}: ModelSelectProps) {
  const bucket = useModelCatalog((s) => s[kind])
  const ensure = useModelCatalog((s) => s.ensure)
  const refresh = useModelCatalog((s) => s.refresh)
  const cached = useSettings((s) => (kind === 'chat' ? s.settings.modelList : s.settings.image.modelList))
  const connected = useSettings((s) => s.settings.mode === 'proxy' || Boolean(s.settings.apiKey.trim()))

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [showAll, setShowAll] = useState(false)

  // список подтягиваем сразу, как только появилось рабочее подключение
  useEffect(() => {
    if (connected) ensure(kind)
  }, [connected, ensure, kind])

  const ids = bucket.ids.length ? bucket.ids : cached
  const imageOnly = kind === 'image' && !showAll

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let items = ids
    if (imageOnly) items = items.filter((id) => looksLikeImageModel(id) || id === value)
    if (q) items = items.filter((id) => id.toLowerCase().includes(q))
    return items
  }, [ids, imageOnly, query, value])

  const pick = (model: string) => {
    onChange(model)
    setOpen(false)
    setQuery('')
    setManual('')
  }

  const reload = async () => {
    try {
      const models = await refresh(kind, { force: true })
      notify(
        models.length ? `Доступно моделей: ${models.length}` : 'API вернул пустой список моделей',
        models.length ? 'success' : 'info',
      )
    } catch {
      // текст ошибки показываем прямо в шторке, отдельный тост не нужен
    }
  }

  const trigger =
    variant === 'chip' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Сменить модель"
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-200 bg-white/60 px-2 py-0.5 text-[11px] text-slate-600 transition active:bg-slate-200/70 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300',
          className,
        )}
      >
        <IconSparkles size={11} />
        <span className="max-w-[9.5rem] truncate font-mono">{value || 'выбрать модель'}</span>
        <IconChevronDown size={11} className="shrink-0" />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-left transition hover:border-blue-400 active:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-blue-500/70 dark:active:bg-slate-800',
          className,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[13px]',
            value ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400',
          )}
        >
          {value || placeholder}
        </span>
        {bucket.loading && <IconRefresh size={15} className="shrink-0 animate-spin text-slate-400" />}
        <IconChevronDown size={16} className="shrink-0 text-slate-400" />
      </button>
    )

  return (
    <>
      {trigger}

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={kind === 'chat' ? 'Модель для чата' : 'Модель генерации изображений'}
        description={
          ids.length
            ? `Доступно из /v1/models: ${ids.length}`
            : 'Список моделей тянется из настроенного подключения'
        }
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500 dark:text-slate-400">
              {ids.length ? `Показано ${list.length} из ${ids.length}` : 'Список пуст'}
            </span>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={bucket.loading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700 transition active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
            >
              <IconRefresh size={15} className={bucket.loading ? 'animate-spin' : undefined} />
              Обновить список
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-800/60">
          <IconSearch size={16} className="shrink-0 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию модели"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-400 dark:text-slate-100"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="text-[11px] text-slate-400">
              Сбросить
            </button>
          )}
        </div>

        {!connected && (
          <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            Сначала заполните Base URL и API key (раздел API) — после этого список моделей подтянется автоматически.
          </p>
        )}

        {bucket.error && (
          <p className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
            {bucket.error}
          </p>
        )}

        {kind === 'image' && ids.length > 0 && (
          <label className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700">
            <span className="text-[11px] text-slate-600 dark:text-slate-300">
              Показывать все модели, а не только «рисующие»
            </span>
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-blue-600"
            />
          </label>
        )}

        <div className="mt-2" role="listbox" aria-label="Модели">
          {bucket.loading && !ids.length && (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
              ))}
            </div>
          )}

          {!bucket.loading && !list.length && (
            <p className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {ids.length
                ? 'Ничего не найдено — измените запрос или введите id вручную.'
                : bucket.error
                  ? 'Список не получен. Проверьте подключение и нажмите «Обновить список».'
                  : 'Список моделей пуст.'}
            </p>
          )}

          <ul className="space-y-1">
            {list.map((id) => {
              const selected = id === value
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(id)}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition active:bg-slate-100 dark:active:bg-slate-800',
                      selected
                        ? 'border-blue-500 bg-blue-50 dark:border-blue-500/70 dark:bg-blue-950/40'
                        : 'border-transparent hover:border-slate-200 dark:hover:border-slate-700',
                    )}
                  >
                    <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-slate-800 dark:text-slate-100">
                      {id}
                    </span>
                    {selected && <IconCheck size={16} className="shrink-0 text-blue-600 dark:text-blue-400" />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-700">
          <p className="px-0.5 pb-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            Нет нужной модели в списке? Введите её id вручную.
          </p>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder={kind === 'chat' ? 'gpt-4o-mini' : 'gpt-image-1'}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-[13px] text-slate-800 outline-none focus:border-blue-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              disabled={!manual.trim()}
              onClick={() => pick(manual.trim())}
              className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700 transition active:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
            >
              Использовать
            </button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
