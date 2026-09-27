import { useEffect, useMemo, useState } from 'react'
import {
  formatModelPrice,
  formatModelPriceShort,
  looksLikeImageModel,
  useModelCatalog,
  type ModelKind,
} from '@/lib/modelCatalog'
import { useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { IconCheck, IconChevronDown, IconRefresh, IconSearch } from './icons'
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

  // Цена выбранной модели — если провайдер её отдаёт (OpenRouter и подобные).
  const selectedPrice = value ? bucket.pricing[value] : undefined

  const trigger =
    variant === 'chip' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          selectedPrice ? `Сменить модель · ${formatModelPriceShort(selectedPrice)}` : 'Сменить модель'
        }
        className={cn(
          'inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 transition hover:bg-neutral-200/60 active:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:active:bg-neutral-800',
          className,
        )}
      >
        <span className="max-w-[9.5rem] truncate">{value || 'выбрать модель'}</span>
        {selectedPrice && (
          <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
            {formatModelPriceShort(selectedPrice)}
          </span>
        )}
        <IconChevronDown size={11} className="shrink-0" />
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-left transition hover:border-neutral-400 active:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-neutral-600 dark:active:bg-neutral-800',
          className,
        )}
      >
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-[13px]',
            value ? 'text-neutral-800 dark:text-neutral-100' : 'text-neutral-400',
          )}
        >
          {value || placeholder}
        </span>
        {selectedPrice && (
          <span className="shrink-0 text-[10.5px] text-neutral-400 dark:text-neutral-500">
            {formatModelPriceShort(selectedPrice)}
          </span>
        )}
        {bucket.loading && <IconRefresh size={15} className="shrink-0 animate-spin text-neutral-400" />}
        <IconChevronDown size={16} className="shrink-0 text-neutral-400" />
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
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {ids.length ? `Показано ${list.length} из ${ids.length}` : 'Список пуст'}
            </span>
            <button
              type="button"
              onClick={() => void reload()}
              disabled={bucket.loading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition active:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:active:bg-neutral-800"
            >
              <IconRefresh size={15} className={bucket.loading ? 'animate-spin' : undefined} />
              Обновить список
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-700 dark:bg-neutral-800/60">
          <IconSearch size={16} className="shrink-0 text-neutral-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по названию модели"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="text-[11px] text-neutral-400">
              Сбросить
            </button>
          )}
        </div>

        {!connected && (
          <p className="mt-3 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
            Сначала заполните Base URL и API key (вкладка «Подключение») — затем список моделей
            подтянется автоматически.
          </p>
        )}

        {bucket.error && (
          <p className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
            {bucket.error}
          </p>
        )}

        {kind === 'image' && ids.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 text-[11px] text-neutral-500 underline decoration-dotted underline-offset-2 transition hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            {showAll ? 'Показывать только «рисующие» модели' : 'Показать все модели подключения'}
          </button>
        )}

        <div className="mt-2" role="listbox" aria-label="Модели">
          {bucket.loading && !ids.length && (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-xl bg-neutral-100 dark:bg-neutral-800" />
              ))}
            </div>
          )}

          {!bucket.loading && !list.length && (
            <p className="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
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
              const price = bucket.pricing[id]
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => pick(id)}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition active:bg-neutral-100 dark:active:bg-neutral-800',
                      selected
                        ? 'border-neutral-300 bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800'
                        : 'border-transparent hover:border-neutral-200 dark:hover:border-neutral-700',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block break-all font-mono text-[12.5px] text-neutral-800 dark:text-neutral-100">
                        {id}
                      </span>
                      {price && (
                        <span className="mt-0.5 block text-[10.5px] text-neutral-400 dark:text-neutral-500">
                          {formatModelPrice(price)}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <IconCheck size={16} className="shrink-0 text-neutral-700 dark:text-neutral-200" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="mt-4 rounded-xl border border-dashed border-neutral-300 p-2.5 dark:border-neutral-700">
          <p className="px-0.5 pb-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            Нет нужной модели в списке? Введите её id вручную.
          </p>
          <div className="flex gap-2">
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder={kind === 'chat' ? 'gpt-4o-mini' : 'gpt-image-1'}
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 font-mono text-[13px] text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500"
            />
            <button
              type="button"
              disabled={!manual.trim()}
              onClick={() => pick(manual.trim())}
              className="rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition active:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:active:bg-neutral-800"
            >
              Использовать
            </button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
