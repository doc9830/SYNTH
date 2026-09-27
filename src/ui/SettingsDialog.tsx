import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { APP_NAME, APP_TAGLINE, APP_VERSION, RELEASES_URL } from '@/lib/appInfo'
import { estimateStorage } from '@/lib/db'
import { memoryStats, useMemory } from '@/lib/memory'
import { useModelCatalog } from '@/lib/modelCatalog'
import { isAndroidDevice } from '@/lib/nativeShell'
import {
  PROVIDER_PRESETS,
  looksLikeAnthropic,
  presetByBaseUrl,
  presetById,
  presetProtocol,
} from '@/lib/providerPresets'
import { getReadiness } from '@/lib/readiness'
import { PROTOCOL_LABELS, sanitizeContextWindow, useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { useUpdateStore } from '@/lib/updateStore'
import { cn } from '@/lib/utils'
import { useConversations } from '@/lib/conversations'
import { KEYLESS_ENGINE_LABELS } from '@/providers/search'
import type { KeylessEngine } from '@/types'
import { IconAlert, IconBug, IconCheck, IconDownload, IconRefresh, IconTrash, IconX } from './icons'
import { ModelSelect } from './ModelSelect'
import { Segmented } from './Segmented'
import { btnCls, inputCls } from './controls'

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>}
    </label>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-1 py-1.5 text-left"
    >
      <span>
        <span className="block text-sm text-neutral-800 dark:text-neutral-100">{label}</span>
        {hint && <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>}
      </span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition',
          checked ? 'bg-neutral-900 dark:bg-neutral-200' : 'bg-neutral-300 dark:bg-neutral-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
            checked ? 'left-4.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  )
}

const TABS = [
  { id: 'api', label: 'Подключение' },
  { id: 'search', label: 'Поиск' },
  { id: 'functions', label: 'Функции' },
  { id: 'ui', label: 'Интерфейс' },
  { id: 'data', label: 'Данные' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * На Android отправка идёт кнопкой со стрелкой, а Enter переносит строку —
 * настройка «Enter отправляет» там не действует, поэтому вместо переключателя
 * показываем пояснение.
 */
const ANDROID_KEYBOARD = isAndroidDevice()

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  onOpenDebug: () => void
}

export function SettingsDialog({ open, onClose, onOpenDebug }: SettingsDialogProps) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const updateSection = useSettings((s) => s.updateSection)
  const reset = useSettings((s) => s.reset)
  const deleteAll = useConversations((s) => s.deleteAll)

  const [tab, setTab] = useState<TabId>('api')
  const [checking, setChecking] = useState(false)
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null)
  const ensureModels = useModelCatalog((s) => s.ensure)
  const refreshModels = useModelCatalog((s) => s.refresh)
  const checkUpdates = useUpdateStore((s) => s.check)
  const updateChecking = useUpdateStore((s) => s.checking)

  const memoryEntries = useMemory((s) => s.entries)
  const memoryInfo = useMemo(() => memoryStats(memoryEntries), [memoryEntries])

  const readiness = useMemo(() => getReadiness(settings), [settings])

  // список моделей подтягиваем при открытии настроек — пользователю не нужно жать «Список»
  useEffect(() => {
    if (!open) return
    ensureModels('chat')
    ensureModels('image')
  }, [open, ensureModels])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open || tab !== 'data') return
    void estimateStorage().then(setStorage)
  }, [open, tab])

  if (!open) return null

  const checkConnection = async () => {
    setChecking(true)
    try {
      const list = await refreshModels('chat', { force: true })
      notify(
        list.length
          ? `Подключение работает. Доступно моделей: ${list.length}`
          : 'Подключение работает, но список моделей пуст',
        'success',
      )
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        onClick={(e) => e.stopPropagation()}
        className="flex h-[100dvh] w-full flex-col overflow-hidden rounded-none border-neutral-200 bg-white shadow-2xl sm:h-[86vh] sm:max-w-2xl sm:rounded-2xl sm:border dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] dark:border-neutral-800">
          <h3 className="text-base font-semibold text-neutral-800 dark:text-neutral-100">Настройки</h3>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded-xl p-2 text-neutral-500 transition hover:bg-neutral-100 active:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
            aria-label="Закрыть настройки"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-neutral-200 px-2 py-2 dark:border-neutral-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'min-h-9 shrink-0 rounded-xl px-3.5 py-2 text-sm transition active:opacity-80',
                tab === t.id
                  ? 'bg-neutral-900 font-medium text-white dark:bg-neutral-200 dark:text-neutral-900'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {tab === 'api' && readiness.issues.length > 0 && (
            <ul className="space-y-2">
              {readiness.issues.map((issue) => (
                <li
                  key={`${issue.scope}-${issue.message}`}
                  className={cn(
                    'flex gap-2 rounded-xl border px-3 py-2 text-xs',
                    issue.severity === 'error'
                      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100'
                      : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100',
                  )}
                >
                  <IconAlert size={15} />
                  <span>
                    <span className="block">{issue.message}</span>
                    <span className="mt-0.5 block opacity-80">{issue.fix}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {tab === 'api' && (
            <>
              <Field
                label="Режим подключения"
                hint="direct — браузер обращается к API провайдера напрямую (ключ хранится только в браузере). proxy — запросы идут через локальный backend, ключ лежит в .env на сервере."
              >
                <Segmented
                  value={settings.mode}
                  onChange={(mode) => update({ mode })}
                  options={[
                    { value: 'direct', label: 'direct (браузер → API)' },
                    { value: 'proxy', label: 'proxy (через backend)' },
                  ]}
                />
              </Field>

              <Field
                label="Тип подключения"
                hint="Как приложение общается с API. «OpenAI-совместимый» понимает большинство провайдеров, шлюзов и локальных серверов; «Anthropic (Claude)» — родной протокол Claude (Messages API, ключ x-api-key)."
              >
                <Segmented
                  value={settings.protocol}
                  onChange={(protocol) => {
                    update({ protocol })
                    // у протоколов разные списки моделей — тянем актуальный сразу
                    void refreshModels('chat', { force: true }).catch(() => undefined)
                  }}
                  options={[
                    { value: 'openai', label: PROTOCOL_LABELS.openai },
                    { value: 'anthropic', label: 'Anthropic (Claude)' },
                  ]}
                />
              </Field>

              {settings.protocol === 'anthropic' && settings.mode === 'proxy' && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
                  Claude работает в direct-режиме: наш backend говорит на OpenAI-протоколе. Переключите
                  режим подключения на direct.
                </div>
              )}

              <Field
                label="Провайдер"
                hint="Пресет подставит адрес API и тип подключения. SYNTH работает с любым OpenAI-совместимым провайдером — выберите «Другой / свой адрес», чтобы ввести Base URL вручную."
              >
                <select
                  value={settings.providerId}
                  onChange={(e) => {
                    const preset = presetById(e.target.value)
                    update({
                      providerId: e.target.value,
                      ...(preset && preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
                      // у пресета Claude — свой протокол, иначе снова OpenAI
                      ...(preset ? { protocol: presetProtocol(preset) } : {}),
                    })
                  }}
                  className={inputCls}
                >
                  {PROVIDER_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Base URL"
                hint={
                  settings.mode === 'proxy'
                    ? 'В proxy-режиме адрес задаётся на сервере (PROVIDER_BASE_URL в .env).'
                    : 'Адрес API вместе с версией — обычно оканчивается на /v1. Для Claude — https://api.anthropic.com/v1.'
                }
              >
                <input
                  value={settings.baseUrl}
                  disabled={settings.mode === 'proxy'}
                  onChange={(e) => {
                    const baseUrl = e.target.value
                    // Адрес Anthropic подключаем нужным протоколом автоматически:
                    // иначе Claude ответит 404 на /chat/completions.
                    if (looksLikeAnthropic(baseUrl)) {
                      update({
                        baseUrl,
                        protocol: 'anthropic',
                        providerId: presetByBaseUrl(baseUrl)?.id ?? 'custom',
                      })
                      return
                    }
                    update({ baseUrl })
                  }}
                  placeholder="https://api.openai.com/v1"
                  className={cn(inputCls, settings.mode === 'proxy' && 'opacity-60')}
                  spellCheck={false}
                />
              </Field>

              <Field
                label="API key"
                hint={
                  settings.mode === 'proxy'
                    ? 'Можно оставить пустым — backend возьмёт PROVIDER_API_KEY из .env. Если заполнить, ключ уйдёт на backend в заголовке x-provider-key.'
                    : 'Ключ хранится только в этом браузере (localStorage) и не попадает в Git.'
                }
              >
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => update({ apiKey: e.target.value })}
                    placeholder={settings.mode === 'proxy' ? 'необязательно' : 'sk-…'}
                    className={inputCls}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="button" onClick={checkConnection} disabled={checking} className={btnCls}>
                    {checking ? (
                      <IconRefresh size={15} className="animate-spin" />
                    ) : (
                      <IconCheck size={15} />
                    )}
                    Проверить
                  </button>
                </div>
              </Field>

              <Field
                label="Model"
                hint={
                  settings.protocol === 'anthropic'
                    ? 'Список берётся из GET /v1/models Anthropic (там только модели Claude). Нужной нет — введите id вручную, например claude-sonnet-4-5.'
                    : 'Список берётся из GET /v1/models настроенного подключения: выберите модель из списка или задайте id вручную.'
                }
              >
                <ModelSelect kind="chat" value={settings.model} onChange={(model) => update({ model })} />
              </Field>

              <div className="space-y-4 rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
                <div>
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    Генерация изображений
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    Модель получает инструмент generate_image и может нарисовать картинку прямо в чате.
                  </p>
                </div>

                <Toggle
                  label="Включить генерацию"
                  checked={settings.image.enabled}
                  onChange={(enabled) => updateSection('image', { enabled })}
                />

                {settings.image.enabled && (
                  <>
                    <Field
                      label="Подключение для картинок"
                      hint="Чат может работать через один провайдер, а картинки — через другой (частый случай: чат на OpenRouter, картинки на OpenAI)."
                    >
                      <Segmented
                        value={settings.image.mode}
                        onChange={(mode) => updateSection('image', { mode })}
                        options={[
                          { value: 'inherit', label: 'Как у чата' },
                          { value: 'direct', label: 'Свой API' },
                          { value: 'proxy', label: 'Через backend' },
                        ]}
                      />
                    </Field>

                    {settings.image.mode === 'direct' && (
                      <>
                        <Field
                          label="Base URL для картинок"
                          hint="Полный адрес API, например https://api.openai.com/v1. Хранится только на этом устройстве."
                        >
                          <input
                            value={settings.image.baseUrl}
                            onChange={(e) => updateSection('image', { baseUrl: e.target.value })}
                            placeholder="https://api.openai.com/v1"
                            className={inputCls}
                            spellCheck={false}
                          />
                        </Field>
                        <Field
                          label="API key для картинок"
                          hint="Используется только инструментом generate_image и не попадает в обычные чат-запросы."
                        >
                          <input
                            type="password"
                            value={settings.image.apiKey}
                            onChange={(e) => updateSection('image', { apiKey: e.target.value })}
                            placeholder="sk-…"
                            className={inputCls}
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </Field>
                      </>
                    )}

                    {settings.image.mode === 'proxy' && (
                      <p className="rounded-xl bg-neutral-100 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                        Запросы идут на backend (
                        <code className="rounded bg-white px-1 dark:bg-neutral-900">/api/image</code>
                        ), ключ провайдера задаётся на сервере (
                        <code className="rounded bg-white px-1 dark:bg-neutral-900">IMAGE_API_KEY</code>).
                      </p>
                    )}

                    <Field
                      label="Модель изображений"
                      hint="Список тот же, что и для чата — из GET /v1/models подключения. Если нужной модели нет, введите её id вручную в селекторе."
                    >
                      <ModelSelect
                        kind="image"
                        value={settings.image.model}
                        onChange={(model) => updateSection('image', { model })}
                      />
                    </Field>

                    <Field
                      label="Способ генерации"
                      hint="Images API — POST /v1/images/generations (gpt-image-1, dall-e-3, flux). Chat-based — модель рисует прямо в диалоге через /v1/chat/completions (Gemini Image, nano-banana)."
                    >
                      <select
                        value={settings.image.provider}
                        onChange={(e) =>
                          updateSection('image', {
                            provider: e.target.value as typeof settings.image.provider,
                          })
                        }
                        className={inputCls}
                      >
                        <option value="images-api">Images API (/v1/images/generations)</option>
                        <option value="chat-image">Chat-based (модель рисует в диалоге)</option>
                      </select>
                    </Field>

                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Размер">
                        <input
                          value={settings.image.size}
                          onChange={(e) => updateSection('image', { size: e.target.value })}
                          placeholder="1024x1024"
                          className={inputCls}
                          spellCheck={false}
                        />
                      </Field>
                      <Field label="Качество">
                        <Segmented
                          value={settings.image.quality}
                          onChange={(quality) => updateSection('image', { quality })}
                          options={[
                            { value: 'low', label: 'low' },
                            { value: 'medium', label: 'medium' },
                            { value: 'high', label: 'high' },
                          ]}
                        />
                      </Field>
                    </div>
                  </>
                )}
              </div>

              <Field label="System prompt" hint="Добавляется в начало каждого диалога. Можно оставить пустым.">
                <textarea
                  value={settings.systemPrompt}
                  onChange={(e) => update({ systemPrompt: e.target.value })}
                  rows={3}
                  placeholder="Например: отвечай кратко и по делу, используй markdown."
                  className={cn(inputCls, 'resize-y')}
                />
              </Field>

              <Field label={`Temperature: ${settings.temperature.toFixed(2)}`}>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => update({ temperature: Number(e.target.value) })}
                  className="w-full accent-neutral-900 dark:accent-neutral-300"
                />
              </Field>

              <Field label="Max tokens" hint="Пусто — параметр не отправляется, лимит определяет провайдер.">
                <input
                  type="number"
                  min={1}
                  value={settings.maxTokens ?? ''}
                  onChange={(e) =>
                    update({ maxTokens: e.target.value ? Number(e.target.value) : null })
                  }
                  placeholder="без ограничения"
                  className={inputCls}
                />
              </Field>

              <Field
                label="Размер контекста (токенов)"
                hint="Сколько токенов влезает в окно модели. Диалог длиннее окна обрезается: старые сообщения не отправляются, системный промпт и память сохраняются. 0 — не ограничивать. То же самое настраивается в шапке чата по тапу на «10/32k»."
              >
                <input
                  type="number"
                  min={0}
                  step={1024}
                  value={settings.contextWindow}
                  onChange={(e) => update({ contextWindow: sanitizeContextWindow(e.target.value) })}
                  placeholder="32768"
                  className={inputCls}
                />
              </Field>
            </>
          )}

          {tab === 'search' && (
            <>
              <Toggle
                label="Web search включён"
                hint="Модель получает инструмент web_search и сама решает, когда искать."
                checked={settings.search.enabled}
                onChange={(enabled) => updateSection('search', { enabled })}
              />
              <Field
                label="Провайдер"
                hint="По умолчанию — бесплатный поиск: без ключей и регистрации. Tavily, Brave и SearXNG оставлены как опция."
              >
                <select
                  value={settings.search.provider}
                  onChange={(e) =>
                    updateSection('search', {
                      provider: e.target.value as typeof settings.search.provider,
                    })
                  }
                  className={inputCls}
                >
                  <option value="keyless">Без API-ключа (Bing · DuckDuckGo · Wikipedia)</option>
                  <option value="tavily">Tavily (нужен API key)</option>
                  <option value="brave">Brave Search (нужен API key)</option>
                  <option value="searxng">SearXNG (self-hosted)</option>
                </select>
              </Field>

              {settings.search.provider === 'keyless' && (
                <>
                  <Field
                    label="Движок"
                    hint="«Авто» перебирает движки по порядку, пока не получит результат."
                  >
                    <select
                      value={settings.search.engine}
                      onChange={(e) =>
                        updateSection('search', { engine: e.target.value as KeylessEngine })
                      }
                      className={inputCls}
                    >
                      {(Object.keys(KEYLESS_ENGINE_LABELS) as KeylessEngine[]).map((id) => (
                        <option key={id} value={id}>
                          {KEYLESS_ENGINE_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="rounded-xl bg-neutral-100 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                    API key не нужен. Bing и DuckDuckGo не отдают CORS-заголовки браузеру, поэтому
                    поиск выполняет ваш backend (
                    <code className="rounded bg-white px-1 dark:bg-neutral-900">/api/search</code>) —
                    держите запущенным{' '}
                    <code className="rounded bg-white px-1 dark:bg-neutral-900">npm run dev:api</code>.
                  </p>
                </>
              )}

              {settings.search.provider === 'searxng' ? (
                <Field
                  label="Base URL SearXNG"
                  hint="Например, http://localhost:8080. Инстанс должен разрешать CORS или используйте proxy-режим."
                >
                  <input
                    value={settings.search.baseUrl}
                    onChange={(e) => updateSection('search', { baseUrl: e.target.value })}
                    placeholder="http://localhost:8080"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
              ) : settings.search.provider !== 'keyless' ? (
                <Field
                  label="API key поиска"
                  hint={
                    settings.mode === 'proxy'
                      ? 'Можно оставить пустым: backend возьмёт TAVILY_API_KEY / BRAVE_API_KEY из .env.'
                      : 'Хранится локально в браузере. Провайдер должен разрешать CORS-запросы.'
                  }
                >
                  <input
                    type="password"
                    value={settings.search.apiKey}
                    onChange={(e) => updateSection('search', { apiKey: e.target.value })}
                    placeholder={settings.mode === 'proxy' ? 'необязательно' : 'ключ провайдера'}
                    className={inputCls}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
              ) : null}

              {settings.mode === 'direct' && (
                <Field
                  label="Backend URL для поиска"
                  hint="Пусто = /api/search текущего сайта. Укажите http://localhost:8787, если фронтенд открыт не с backend-хоста (например, телефон в LAN)."
                >
                  <input
                    value={settings.search.backendUrl}
                    onChange={(e) => updateSection('search', { backendUrl: e.target.value })}
                    placeholder="/api/search"
                    className={inputCls}
                    spellCheck={false}
                  />
                </Field>
              )}

              <Field label={`Результатов на запрос: ${settings.search.maxResults}`}>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={settings.search.maxResults}
                  onChange={(e) => updateSection('search', { maxResults: Number(e.target.value) })}
                  className="w-full accent-neutral-900 dark:accent-neutral-300"
                />
              </Field>

              <hr className="my-1 border-neutral-200 dark:border-neutral-800" />

              <Toggle
                label="Читать присланные ссылки (read_url)"
                hint="Модель получает инструмент read_url: открывает присланную ссылку, забирает текст, заголовки, ссылки, картинки и дизайн, а также показывает скриншот страницы. Нужен backend, для скриншотов — Chrome/Chromium."
                checked={settings.search.readPages}
                onChange={(readPages) => updateSection('search', { readPages })}
              />

              {settings.search.readPages && (
                <p className="rounded-xl bg-neutral-100 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                  Пришлите ссылку прямо в чат — модель сама вызовет{' '}
                  <code className="rounded bg-white px-1 dark:bg-neutral-900">read_url</code> и вернёт
                  текст, заголовки, ссылки и скриншот страницы. Для проверки достаточно отправить
                  сообщение с адресом сайта.
                </p>
              )}
            </>
          )}

          {tab === 'functions' && (
            <>
              <p className="rounded-xl bg-neutral-100 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                Включать функции удобнее в композере — шестерёнка под полем ввода (справа от чипов),
                она же доступна в меню «⋮» в шапке чата. Здесь — подробные параметры инструментов и памяти.
              </p>

              <div className="space-y-1 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <Toggle
                  label="Калькулятор"
                  hint="Модель считает точно: арифметику выполняет код, а не «устный счёт»."
                  checked={settings.tools.calculator}
                  onChange={(calculator) => updateSection('tools', { calculator })}
                />
                <Toggle
                  label="Текущее время"
                  hint="Модель узнаёт дату и время устройства — сама она их не знает."
                  checked={settings.tools.currentTime}
                  onChange={(currentTime) => updateSection('tools', { currentTime })}
                />
                <Toggle
                  label="Поиск по прошлым чатам"
                  hint="Инструмент search_chats: модель ищет по сохранённым диалогам этого устройства."
                  checked={settings.tools.chatHistory}
                  onChange={(chatHistory) => updateSection('tools', { chatHistory })}
                />
              </div>

              <div className="space-y-4 rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
                <div>
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    Долговременная память
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    Короткие факты о вас — имя, город, стек, предпочтения — лежат в IndexedDB этого
                    устройства и подмешиваются в системный промпт. Наружу они не отправляются.
                  </p>
                </div>

                <Toggle
                  label="Память включена"
                  hint="Модель получает инструменты памяти (remember/forget) и видит уже сохранённые факты."
                  checked={settings.memory.enabled}
                  onChange={(enabled) => updateSection('memory', { enabled })}
                />

                {settings.memory.enabled && (
                  <>
                    <Toggle
                      label="Запоминать автоматически"
                      hint="После ответа приложение отдельным запросом вытаскивает новые факты и сохраняет их. Секреты (ключи, пароли) не сохраняются."
                      checked={settings.memory.autoExtract}
                      onChange={(autoExtract) => updateSection('memory', { autoExtract })}
                    />

                    <Field label={`Записей в один запрос: ${settings.memory.maxInjected}`}>
                      <input
                        type="range"
                        min={1}
                        max={40}
                        step={1}
                        value={settings.memory.maxInjected}
                        onChange={(e) =>
                          updateSection('memory', { maxInjected: Number(e.target.value) })
                        }
                        className="w-full accent-neutral-900 dark:accent-neutral-300"
                      />
                    </Field>

                    <Field
                      label={`Лимит символов в промпте: ${settings.memory.maxChars}`}
                      hint="Сколько знаков блока памяти максимум уходит в системный промпт."
                    >
                      <input
                        type="range"
                        min={200}
                        max={4000}
                        step={100}
                        value={settings.memory.maxChars}
                        onChange={(e) => updateSection('memory', { maxChars: Number(e.target.value) })}
                        className="w-full accent-neutral-900 dark:accent-neutral-300"
                      />
                    </Field>

                    <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      Сейчас сохранено записей: {memoryInfo.count}
                      {memoryInfo.pinned ? `, из них закреплено ${memoryInfo.pinned}` : ''} ·{' '}
                      {memoryInfo.chars} симв. Просмотр, экспорт и очистка — в меню «⋮» → «Память».
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          {tab === 'ui' && (
            <>
              <Field label="Тема">
                <Segmented
                  value={settings.ui.theme}
                  onChange={(theme) => updateSection('ui', { theme })}
                  options={[
                    { value: 'system', label: 'Как в системе' },
                    { value: 'light', label: 'Светлая' },
                    { value: 'dark', label: 'Тёмная' },
                  ]}
                />
              </Field>
              <Field label="Размер шрифта">
                <Segmented
                  value={settings.ui.fontSize}
                  onChange={(fontSize) => updateSection('ui', { fontSize })}
                  options={[
                    { value: 'sm', label: 'Меньше' },
                    { value: 'md', label: 'Обычный' },
                    { value: 'lg', label: 'Больше' },
                  ]}
                />
              </Field>
              <div className="space-y-1 rounded-xl border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <Toggle
                  label="Показывать reasoning"
                  hint="Блок «Размышления» над ответом, если модель его вернула."
                  checked={settings.ui.showReasoning}
                  onChange={(showReasoning) => updateSection('ui', { showReasoning })}
                />
                <Toggle
                  label="Показывать активность инструментов"
                  hint="Строки вида «🌐 Ищу в интернете…» с подробностями по клику."
                  checked={settings.ui.showToolActivity}
                  onChange={(showToolActivity) => updateSection('ui', { showToolActivity })}
                />
                {ANDROID_KEYBOARD ? (
                  <p className="px-1 py-1.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    В приложении на Android Enter переносит строку, а отправляет круглая кнопка со
                    стрелкой рядом с полем ввода.
                  </p>
                ) : (
                  <Toggle
                    label="Enter отправляет сообщение"
                    hint="Иначе отправка — Ctrl/Cmd+Enter, а Enter переносит строку."
                    checked={settings.ui.sendOnEnter}
                    onChange={(sendOnEnter) => updateSection('ui', { sendOnEnter })}
                  />
                )}
              </div>
            </>
          )}

          {tab === 'data' && (
            <>
              <div className="rounded-xl border border-neutral-200 px-3 py-3 dark:border-neutral-800">
                <p className="text-sm text-neutral-800 dark:text-neutral-100">Локальное хранилище</p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {storage
                    ? `Занято ${(storage.usage / 1024 / 1024).toFixed(1)} МБ из ${(storage.quota / 1024 / 1024).toFixed(0)} МБ.`
                    : 'Оценка недоступна в этом браузере.'}
                </p>
                <p className="mt-1 text-[11px] text-neutral-400">
                  История и сгенерированные изображения лежат в IndexedDB этого устройства и никуда не отправляются.
                </p>
              </div>

              <button type="button" onClick={onOpenDebug} className={cn(btnCls, 'w-full justify-center')}>
                <IconBug size={15} />
                Открыть Debug Console
              </button>

              <button
                type="button"
                className={cn(btnCls, 'w-full justify-center text-red-600 dark:text-red-400')}
                onClick={async () => {
                  if (!window.confirm('Удалить всю историю чатов? Действие необратимо.')) return
                  await deleteAll()
                  notify('История очищена', 'success')
                }}
              >
                <IconTrash size={15} />
                Удалить всю историю
              </button>

              <button
                type="button"
                className={cn(btnCls, 'w-full justify-center')}
                onClick={() => {
                  if (!window.confirm('Сбросить все настройки к значениям по умолчанию?')) return
                  reset()
                  notify('Настройки сброшены', 'success')
                }}
              >
                <IconRefresh size={15} />
                Сбросить настройки
              </button>

              <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-700">
                <div className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
                  О программе
                </div>
                <div className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {APP_NAME} v{APP_VERSION} · {APP_TAGLINE}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnCls}
                    disabled={updateChecking}
                    onClick={() => void checkUpdates({ manual: true })}
                  >
                    <IconRefresh size={15} className={updateChecking ? 'animate-spin' : undefined} />
                    Проверить обновления
                  </button>
                  <a className={btnCls} href={RELEASES_URL} target="_blank" rel="noreferrer">
                    <IconDownload size={15} />
                    Релизы на GitHub
                  </a>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
