import { useEffect, useState } from 'react'
import { useModelCatalog } from '@/lib/modelCatalog'
import { PROVIDER_PRESETS, presetById, presetByBaseUrl } from '@/lib/providerPresets'
import { useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { IconAlert, IconCheck, IconRefresh } from './icons'
import { ModelSelect } from './ModelSelect'
import { Sheet } from './Sheet'

/**
 * Мастер первого запуска: два шага — подключение (Base URL + API key) и модели.
 * Универсально: подходит любому OpenAI-совместимому провайдеру, пресеты лишь
 * подставляют адрес. Ключ и настройки остаются на устройстве.
 */

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100'

const primaryBtn =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-sky-500 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-50'

const ghostBtn =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-600 transition hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'

interface SetupDialogProps {
  open: boolean
  onClose: () => void
  /** Первый запуск: добавляем «Настрою позже» */
  firstRun?: boolean
}

export function SetupDialog({ open, onClose, firstRun = false }: SetupDialogProps) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const updateSection = useSettings((s) => s.updateSection)
  const refreshModels = useModelCatalog((s) => s.refresh)

  const [step, setStep] = useState<0 | 1>(0)
  const [providerId, setProviderId] = useState(settings.providerId)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState(settings.apiKey)
  const [model, setModel] = useState(settings.model)
  const [imageEnabled, setImageEnabled] = useState(settings.image.enabled)
  const [imageModel, setImageModel] = useState(settings.image.model)
  const [showKey, setShowKey] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // При открытии берём актуальные значения; зависимости намеренно только [open],
  // иначе ввод пользователя затирался бы на каждом обновлении настроек.
  useEffect(() => {
    if (!open) return
    setStep(0)
    setError(null)
    setProviderId(settings.providerId)
    setBaseUrl(settings.baseUrl)
    setApiKey(settings.apiKey)
    setModel(settings.model)
    setImageEnabled(settings.image.enabled)
    setImageModel(settings.image.model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const preset = presetById(providerId) ?? presetByBaseUrl(baseUrl)

  /** Шаг 1: сохраняем доступ и сразу проверяем его запросом /v1/models. */
  const connect = async () => {
    if (settings.mode !== 'proxy' && !baseUrl.trim()) {
      setError('Укажите адрес API (Base URL) — например, https://api.openai.com/v1')
      return
    }
    if (settings.mode !== 'proxy' && !apiKey.trim()) {
      setError('Вставьте API key провайдера.')
      return
    }
    setChecking(true)
    setError(null)
    update({ providerId, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })
    try {
      const ids = await refreshModels('chat', { force: true })
      if (!model.trim() && ids.length) setModel(ids[0])
      setStep(1)
      notify(
        ids.length
          ? `Подключение работает: доступно моделей — ${ids.length}`
          : 'Подключение работает, но список моделей пуст — введите id модели вручную',
        ids.length ? 'success' : 'info',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  /** Шаг 2: фиксируем модели и закрываем мастер. */
  const finish = () => {
    if (!model.trim()) {
      setError('Выберите модель для чата.')
      return
    }
    update({ model: model.trim(), setupDone: true })
    updateSection('image', {
      enabled: imageEnabled && Boolean(imageModel.trim()),
      model: imageModel.trim(),
    })
    notify('Готово — можно общаться', 'success')
    onClose()
  }

  /** «Настрою позже»: не открываем мастер при каждом запуске. */
  const skip = () => {
    update({ setupDone: true })
    onClose()
  }

  const title = step === 0 ? 'Подключение к API' : 'Выбор моделей'
  const description =
    step === 0
      ? 'Шаг 1 из 2 — адрес API и ключ. Ключ хранится только на этом устройстве.'
      : 'Шаг 2 из 2 — модель для чата и, при желании, модель для картинок.'

  const footer =
    step === 0 ? (
      <div className="flex flex-col gap-2">
        <button type="button" className={primaryBtn} onClick={() => void connect()} disabled={checking}>
          {checking ? <IconRefresh size={16} className="animate-spin" /> : <IconCheck size={16} />}
          {checking ? 'Проверяю подключение…' : 'Проверить и продолжить'}
        </button>
        {firstRun ? (
          <button type="button" className={ghostBtn} onClick={skip}>
            Настрою позже
          </button>
        ) : (
          <button type="button" className={ghostBtn} onClick={onClose}>
            Закрыть
          </button>
        )}
      </div>
    ) : (
      <div className="flex gap-2">
        <button
          type="button"
          className={ghostBtn}
          onClick={() => {
            setError(null)
            setStep(0)
          }}
        >
          Назад
        </button>
        <button type="button" className={cn(primaryBtn, 'flex-1')} onClick={finish} disabled={!model.trim()}>
          <IconCheck size={16} />
          Готово
        </button>
      </div>
    )

  return (
    <Sheet open={open} onClose={onClose} title={title} description={description} footer={footer}>
      {step === 0 && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              Провайдер
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PROVIDER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setProviderId(p.id)
                    if (p.baseUrl) setBaseUrl(p.baseUrl)
                  }}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs transition',
                    providerId === p.id
                      ? 'border-violet-400 bg-violet-50 text-violet-700 dark:border-violet-500/60 dark:bg-violet-950/40 dark:text-violet-200'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {settings.mode === 'proxy' ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              Включён proxy-режим: адрес API и ключ задаются на сервере (PROVIDER_BASE_URL и
              PROVIDER_API_KEY в .env). Убедитесь, что backend запущен, и нажмите «Проверить и
              продолжить».
            </div>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Base URL
                </span>
                <input
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    setProviderId(presetByBaseUrl(e.target.value)?.id ?? 'custom')
                  }}
                  placeholder="https://api.openai.com/v1"
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="url"
                />
                <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
                  Адрес OpenAI-совместимого API — обычно оканчивается на /v1.
                </span>
              </label>

              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  API key
                </span>
                <div className="flex gap-2">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-…"
                    className={inputCls}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button type="button" className={ghostBtn} onClick={() => setShowKey((v) => !v)}>
                    {showKey ? 'Скрыть' : 'Показать'}
                  </button>
                </div>
                <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
                  Ключ уходит только в выбранный вами API и хранится локально.
                  {preset?.keyUrl ? (
                    <>
                      {' '}
                      Где взять:{' '}
                      <a
                        href={preset.keyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        {preset.label}
                      </a>
                    </>
                  ) : null}
                </span>
              </label>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
              Модель для чата
            </div>
            <ModelSelect
              kind="chat"
              value={model}
              onChange={setModel}
              placeholder={preset?.modelHint ?? 'Выбрать модель'}
            />
            <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
              Список получен из GET /v1/models. Нужной модели нет? Введите её id вручную в
              селекторе.
            </span>
          </div>

          <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={imageEnabled}
                onChange={(e) => setImageEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-violet-600"
              />
              <span>
                <span className="block text-sm text-slate-700 dark:text-slate-200">
                  Генерация изображений
                </span>
                <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                  Необязательно: не нужна — оставьте выключенной и нажмите «Готово».
                </span>
              </span>
            </label>
            {imageEnabled && (
              <div className="mt-3">
                <ModelSelect
                  kind="image"
                  value={imageModel}
                  onChange={setImageModel}
                  placeholder="gpt-image-1"
                />
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
              <IconAlert size={15} className="mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </div>
          )}
        </div>
      )}
    </Sheet>
  )
}
