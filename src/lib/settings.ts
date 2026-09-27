import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { KeylessEngine } from '@/types'

export type ConnectionMode = 'direct' | 'proxy'
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
  /** id пресета провайдера (src/lib/providerPresets.ts); 'custom' — свой адрес */
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  /** Кэш списка моделей из GET /v1/models */
  modelList: string[]
  systemPrompt: string
  temperature: number
  /** null = не отправлять max_tokens */
  maxTokens: number | null
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
  providerId: 'custom',
  // Провайдер выбирает пользователь: приложение не привязано к конкретному API.
  baseUrl: '',
  apiKey: '',
  model: '',
  modelList: [],
  systemPrompt: '',
  temperature: 0.7,
  maxTokens: null,
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
