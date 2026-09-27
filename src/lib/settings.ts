import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KeylessEngine, VisionInputMode } from '@/types'

export type ConnectionMode = 'direct' | 'proxy'

/**
 * Тип подключения (протокол API):
 *  - openai    → OpenAI-совместимый: POST /v1/chat/completions, ключ в Bearer,
 *                инструменты через tool_calls. Так работает большинство провайдеров
 *                и шлюзов (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, прокси);
 *  - anthropic → Claude Messages API: POST /v1/messages, ключ в x-api-key,
 *                системный промпт отдельным полем, инструменты tool_use/tool_result.
 */
export type ConnectionProtocol = 'openai' | 'anthropic'
export type ThemeMode = 'system' | 'light' | 'dark'
export type FontSize = 'sm' | 'md' | 'lg'
export type SearchProviderId = 'keyless' | 'tavily' | 'brave' | 'searxng'
/**
 * Способ генерации изображений:
 *  - images-api  → POST /v1/images/generations (OpenAI Images API, gpt-image-1, dall-e-3, flux)
 *  - chat-image  → модель рисует через POST /v1/chat/completions (Gemini Image, nano-banana)
 */
export type ImageProviderId = 'images-api' | 'chat-image'

/**
 * Откуда брать подключение для генерации изображений:
 *  - inherit → как у чата (mode/baseUrl/apiKey основного подключения)
 *  - direct  → свой Base URL и ключ (частый случай: чат на OpenRouter, картинки на OpenAI)
 *  - proxy   → через наш backend (/api/image), ключ живёт на сервере
 */
export type ImageConnectionMode = 'inherit' | 'direct' | 'proxy'

export interface SearchSettings {
  enabled: boolean
  provider: SearchProviderId
  /** Движок бесплатного поиска (provider === 'keyless') */
  engine: KeylessEngine
  /** Инструмент read_url: читать присланные ссылки (текст страницы + скриншот) */
  readPages: boolean
  /** Ключ для Tavily / Brave (бесплатному поиску не нужен) */
  apiKey: string
  /** Для self-hosted SearXNG */
  baseUrl: string
  /**
   * URL backend-прокси для поиска. Пусто → /api/search текущего сайта.
   * Нужен, когда фронтенд открыт не с backend-хоста (телефон в LAN, статичный хостинг).
   */
  backendUrl: string
  maxResults: number
}

export interface ImageSettings {
  enabled: boolean
  /** images-api → /v1/images/generations, chat-image → /v1/chat/completions */
  provider: ImageProviderId
  /**
   * Своё подключение для картинок. Часто ключ и провайдер отличаются от чата
   * (например, чат через OpenRouter, а картинки — через OpenAI напрямую).
   * Пусто → берём основное подключение (mode/baseUrl/apiKey выше).
   */
  mode: ImageConnectionMode
  baseUrl: string
  apiKey: string
  model: string
  /** Кэш списка моделей из GET /v1/models (селектор image-моделей) */
  modelList: string[]
  size: string
  quality: 'low' | 'medium' | 'high'
}

/**
 * Дополнительные инструменты модели (кроме поиска/картинок).
 * Каждый — обычный tool call; выключенные не попадают в запрос.
 */
export interface ExtraToolsSettings {
  /** Калькулятор: точная арифметика вместо «устного счёта» модели */
  calculator: boolean
  /** Текущая дата/время — модель их часто не знает */
  currentTime: boolean
  /** Поиск по прошлым чатам приложения */
  chatHistory: boolean
}

/**
 * Долговременная память: короткие факты о пользователе, которые живут
 * между чатами и подмешиваются в системный промпт.
 */
export interface MemorySettings {
  /** Подмешивать память в контекст и давать модели инструменты памяти */
  enabled: boolean
  /** После ответа тихо извлекать новые факты отдельным запросом к модели */
  autoExtract: boolean
  /** Сколько записей максимум подмешивать в один запрос */
  maxInjected: number
  /** Лимит символов блока памяти в системном промпте */
  maxChars: number
}

export interface InterfaceSettings {
  theme: ThemeMode
  fontSize: FontSize
  showReasoning: boolean
  showToolActivity: boolean
  sendOnEnter: boolean
}

export interface Settings {
  mode: ConnectionMode
  /**
   * Тип подключения: как общаться с API. Протокол OpenAI понимает почти любой
   * провайдер, «Anthropic» нужен для Claude и его релеев — там совсем другой
   * формат запросов (см. src/providers/anthropic).
   */
  protocol: ConnectionProtocol
  /** id пресета провайдера (src/lib/providerPresets.ts); 'custom' — свой адрес */
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  /** Кэш списка моделей из GET /v1/models */
  modelList: string[]
  /**
   * Принимает ли выбранная модель изображения на вход. `auto` — догадка по id
   * модели (см. getModelCapabilities), `on` / `off` — ручное переопределение:
   * у шлюзов и локальных серверов id бывают нестандартными, и эвристика
   * ошибается (например, `deepseek-v4.1-flash` умеет vision).
   */
  visionInput: VisionInputMode
  systemPrompt: string
  temperature: number
  /** null = не отправлять max_tokens */
  maxTokens: number | null
  /**
   * Размер окна контекста в токенах: диалог длиннее окна обрезается,
   * старые сообщения не уходят в запрос. 0 — без ограничения.
   * Виден в шапке чата как «10/32k» и настраивается по тапу на него.
   */
  contextWindow: number
  /** Онбординг пройден (или осознанно пропущен) — чтобы не открывать его каждый запуск */
  setupDone: boolean
  search: SearchSettings
  image: ImageSettings
  tools: ExtraToolsSettings
  memory: MemorySettings
  ui: InterfaceSettings
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'direct',
  // Тип подключения по умолчанию — OpenAI-совместимый: его понимает
  // большинство провайдеров, шлюзов и локальных серверов.
  protocol: 'openai',
  providerId: 'custom',
  // Провайдер выбирает пользователь: приложение не привязано к конкретному API.
  baseUrl: '',
  apiKey: '',
  model: '',
  modelList: [],
  // изображения на вход: по умолчанию решаем по id модели (эвристика)
  visionInput: 'auto',
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: null,
  // 32k — компромисс: влезает почти любой провайдер, длинные чаты режутся не сразу.
  // Реальное окно модели пользователь ставит по тапу на «10/32k» в шапке чата.
  contextWindow: 32768,
  setupDone: false,
  search: {
    enabled: true,
    // Бесплатный поиск без ключей — работает из коробки через локальный backend
    provider: 'keyless',
    engine: 'auto',
    // чтение конкретных ссылок (read_url): текст страницы + скриншот через backend
    readPages: true,
    apiKey: '',
    baseUrl: '',
    backendUrl: '',
    maxResults: 5,
  },
  image: {
    // Картинки — опциональная функция: включается при выборе image-модели
    enabled: false,
    provider: 'images-api',
    // своё подключение: 'inherit' → работает от основного
    mode: 'inherit' as ImageConnectionMode,
    baseUrl: '',
    apiKey: '',
    model: '',
    modelList: [],
    size: '1024x1024',
    quality: 'low',
  },
  tools: {
    calculator: true,
    currentTime: true,
    chatHistory: true,
  },
  memory: {
    // Долговременная память: локальная, выключена пока пользователь не согласится
    enabled: false,
    autoExtract: true,
    maxInjected: 12,
    maxChars: 1200,
  },
  ui: {
    theme: 'system',
    fontSize: 'md',
    showReasoning: true,
    showToolActivity: true,
    sendOnEnter: true,
  },
}

/**
 * Приводит значение «размер окна контекста» к числу токенов.
 *  - отсутствует / не число → значение по умолчанию (старые сохранения);
 *  - 0 или отрицательное → 0 = без ограничения (историю не режем);
 *  - иначе → округлённое число токенов.
 */
export function sanitizeContextWindow(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_SETTINGS.contextWindow
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.contextWindow
  if (n <= 0) return 0
  return Math.round(n)
}

/**
 * Приводит тип подключения к известному значению.
 * Незнакомое (или отсутствующее в старых сохранениях) → OpenAI-совместимый.
 */
export function sanitizeProtocol(value: unknown): ConnectionProtocol {
  return value === 'anthropic' ? 'anthropic' : 'openai'
}

/** Человекочитаемое имя типа подключения — для настроек и диагностики. */
export const PROTOCOL_LABELS: Record<ConnectionProtocol, string> = {
  openai: 'OpenAI-совместимый',
  anthropic: 'Anthropic (Claude)',
}

/**
 * Приводит режим «изображения на вход» к известному значению.
 * Незнакомое (или отсутствующее в старых сохранениях) → auto (эвристика).
 */
export function sanitizeVisionInput(value: unknown): VisionInputMode {
  return value === 'on' || value === 'off' ? value : 'auto'
}

/** Подписи для переключателя «Изображения на вход». */
export const VISION_INPUT_LABELS: Record<VisionInputMode, string> = {
  auto: 'Авто',
  on: 'Да',
  off: 'Нет',
}

interface SettingsState {
  settings: Settings
  update: (patch: Partial<Settings>) => void
  updateSection: <K extends 'search' | 'image' | 'tools' | 'memory' | 'ui'>(
    section: K,
    patch: Partial<Settings[K]>,
  ) => void
  reset: () => void
}

const STORAGE_KEY = 'ds-chat.settings.v1'

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      update: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
      updateSection: (section, patch) =>
        set((s) => ({
          settings: {
            ...s.settings,
            [section]: { ...s.settings[section], ...patch },
          },
        })),
      reset: () => set({ settings: DEFAULT_SETTINGS }),
    }),
    {
      name: STORAGE_KEY,
      version: 3,
      // принимаем сохранённое как есть, недостающие поля добирает merge() —
      // так пользователь не теряет ключ и настройки при обновлении приложения
      migrate: (persisted) => persisted as Partial<SettingsState>,
      // мержим с дефолтами, чтобы новые поля не ломали старые сохранения
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>
        const persistedSearch = p.settings?.search
        const search: SearchSettings = {
          ...DEFAULT_SETTINGS.search,
          ...(persistedSearch ?? {}),
        }
        // Разовая миграция: Tavily/Brave без ключа в direct-режиме работать не может —
        // переводим такие сохранения на бесплатный поиск без API-ключа.
        if (
          (search.provider === 'tavily' || search.provider === 'brave') &&
          !search.apiKey.trim() &&
          (p.settings?.mode ?? DEFAULT_SETTINGS.mode) === 'direct'
        ) {
          search.provider = 'keyless'
        }
        // Миграция провайдера изображений: старые ключи ruapi-* → нейтральные.
        const persistedImage = p.settings?.image
        const legacyProvider = String(persistedImage?.provider ?? '')
        const imageProvider: ImageProviderId =
          legacyProvider === 'ruapi-chat-image'
            ? 'chat-image'
            : legacyProvider === 'ruapi-images'
              ? 'images-api'
              : legacyProvider === 'chat-image' || legacyProvider === 'images-api'
                ? legacyProvider
                : DEFAULT_SETTINGS.image.provider
        const legacyImageMode = persistedImage?.mode
        const imageMode: ImageConnectionMode =
          legacyImageMode === 'direct' || legacyImageMode === 'proxy' ? legacyImageMode : 'inherit'
        const image: ImageSettings = {
          ...DEFAULT_SETTINGS.image,
          ...(persistedImage ?? {}),
          provider: imageProvider,
          mode: imageMode,
          // старые сохранения: своего подключения для картинок ещё не было
          baseUrl: String(persistedImage?.baseUrl ?? ''),
          apiKey: String(persistedImage?.apiKey ?? ''),
        }

        const persistedTools = p.settings?.tools
        const tools: ExtraToolsSettings = {
          ...DEFAULT_SETTINGS.tools,
          ...(persistedTools ?? {}),
        }

        const persistedMemory = p.settings?.memory
        const memory: MemorySettings = {
          ...DEFAULT_SETTINGS.memory,
          ...(persistedMemory ?? {}),
        }

        const merged: Settings = {
          ...DEFAULT_SETTINGS,
          ...(p.settings ?? {}),
          search,
          image,
          tools,
          memory,
          ui: { ...DEFAULT_SETTINGS.ui, ...(p.settings?.ui ?? {}) },
          // старые сохранения поля не знают → подставляем окно по умолчанию
          contextWindow: sanitizeContextWindow(p.settings?.contextWindow),
          // «изображения на вход» появилось в 1.4.1: у старых сохранений — авто
          visionInput: sanitizeVisionInput(p.settings?.visionInput),
          // Тип подключения: если пользователь уже вписал адрес Anthropic,
          // поднимаем протокол до нужного — иначе Claude не заработает.
          protocol:
            p.settings?.protocol === undefined &&
            /api\.anthropic\.com/i.test(String(p.settings?.baseUrl ?? ''))
              ? 'anthropic'
              : sanitizeProtocol(p.settings?.protocol),
        }
        // Уже настроенные пользователи онбординг видеть не должны.
        if (p.settings?.setupDone === undefined) {
          merged.setupDone = Boolean(merged.baseUrl.trim() && merged.model.trim())
        }
        return { ...current, ...p, settings: merged }
      },
    },
  ),
)

/** Доступ к настройкам вне React-компонентов (agent loop, tools). */
export function getSettings(): Settings {
  return useSettings.getState().settings
}

export function settingsSnapshot(): Settings {
  return structuredClone(getSettings())
}

/**
 * Достаточно ли настроек, чтобы отправлять сообщения модели
 * (минимальный чек-лист онбординга: base URL + API key + модель).
 */
export function isConfigured(settings: Settings): boolean {
  if (!settings.model.trim()) return false
  if (settings.mode === 'proxy') return true
  return Boolean(settings.baseUrl.trim() && settings.apiKey.trim())
}
