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
  model: string
  /** Кэш списка моделей из GET /v1/models (селектор image-моделей) */
  modelList: string[]
  size: string
  quality: 'low' | 'medium' | 'high'
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
    model: '',
    modelList: [],
    size: '1024x1024',
    quality: 'low',
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
  updateSection: <K extends 'search' | 'image' | 'ui'>(
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
      version: 2,
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
        const image: ImageSettings = {
          ...DEFAULT_SETTINGS.image,
          ...(persistedImage ?? {}),
          provider: imageProvider,
        }

        const merged: Settings = {
          ...DEFAULT_SETTINGS,
          ...(p.settings ?? {}),
          search,
          image,
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
