import type { Settings } from '@/lib/settings'
import type { OpenAiTransport } from '@/providers/openai'
import { anthropicHeaders } from '@/providers/anthropic/headers'
import type { AnthropicTransport } from '@/providers/anthropic/client'

/**
 * Транспорт запросов: direct (браузер → API провайдера) или proxy
 * (браузер → наш backend → API провайдера).
 * В proxy-режиме API key живёт только на сервере и в bundle не попадает.
 * Для генерации изображений можно задать своё подключение (chat и картинки
 * часто живут на разных провайдерах и ключах).
 *
 * Тип подключения (settings.protocol) задаёт протокол: OpenAI-совместимый
 * (/chat/completions) или Anthropic Messages API (/messages). Во втором случае
 * адреса и заголовки отличаются, а всё остальное приложение этого не замечает.
 */

/** Какие запросы обслуживаем: чат (включая список моделей) или картинки. */
export type TransportKind = 'chat' | 'image'

export interface ResolvedTransport {
  /** Куда слать chat/completions (в Anthropic-режиме — /messages) */
  chatUrl: string
  /** Куда слать images/generations (пусто, если протокол их не умеет) */
  imagesUrl: string
  /** Где брать список моделей */
  modelsUrl: string
  /** Заголовки (в direct-режиме содержат API key) */
  headers: Record<string, string>
  /** Какой транспорт используем — для диагностики */
  mode: 'direct' | 'proxy'
}

/** Anthropic работает только напрямую: backend отдаёт OpenAI-протокол. */
const ANTHROPIC_PROXY_ERROR =
  'Тип подключения «Anthropic (Claude)» работает в direct-режиме: наш backend говорит на OpenAI-протоколе. Выключите proxy-режим или выберите тип «OpenAI-совместимый» (Claude доступен и через прокси-шлюзы).'

/** Anthropic не генерирует изображения: нужен отдельный ключ для картинок. */
const ANTHROPIC_IMAGE_ERROR =
  'Claude не умеет рисовать: его API не поддерживает генерацию изображений. Укажите отдельное подключение для картинок (Настройки → Подключение → Генерация изображений → «Свой API») — например, OpenAI или Gemini.'

function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/** Своё подключение для картинок; null → работать от основного. */
function ownImageTransport(settings: Settings): ResolvedTransport | null {
  const image = settings.image
  const key = image.apiKey.trim()
  if (image.mode === 'proxy') {
    return {
      chatUrl: '/api/chat',
      imagesUrl: '/api/image',
      modelsUrl: '/api/models',
      headers: key ? { 'x-provider-key': key } : {},
      mode: 'proxy',
    }
  }
  if (image.mode !== 'direct') return null
  const base = image.baseUrl.trim()
  if (!base) return null
  return {
    chatUrl: joinBase(base, '/chat/completions'),
    imagesUrl: joinBase(base, '/images/generations'),
    modelsUrl: joinBase(base, '/models'),
    // без ключа direct-запрос к чужому провайдеру смысла не имеет — уходим на основное подключение
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    mode: 'direct',
  }
}

export function resolveTransport(settings: Settings, kind: TransportKind = 'chat'): ResolvedTransport {
  if (kind === 'image') {
    const own = ownImageTransport(settings)
    if (own) return own
  }

  if (settings.protocol === 'anthropic') {
    if (kind === 'image') throw new Error(ANTHROPIC_IMAGE_ERROR)
    if (settings.mode === 'proxy') throw new Error(ANTHROPIC_PROXY_ERROR)
    const base = settings.baseUrl.trim()
    if (!base) {
      throw new Error('Не задан Base URL. Для Claude это https://api.anthropic.com/v1.')
    }
    if (!settings.apiKey.trim()) {
      throw new Error('Не задан API key Anthropic (начинается на sk-ant-…).')
    }
    return {
      chatUrl: joinBase(base, '/messages'),
      imagesUrl: '',
      // у Anthropic страница моделей по умолчанию — 20 штук
      modelsUrl: `${joinBase(base, '/models')}?limit=100`,
      headers: anthropicHeaders(settings.apiKey),
      mode: 'direct',
    }
  }

  if (settings.mode === 'proxy') {
    return {
      chatUrl: '/api/chat',
      imagesUrl: '/api/image',
      modelsUrl: '/api/models',
      // в proxy-режиме ключ (если задан в UI) уходит на наш backend, но может и не задаваться
      headers: settings.apiKey ? { 'x-provider-key': settings.apiKey.trim() } : {},
      mode: 'proxy',
    }
  }

  const base = settings.baseUrl.trim()
  if (!base) {
    throw new Error('Не задан Base URL. Укажите его в Настройки → Подключение.')
  }
  if (!settings.apiKey.trim()) {
    throw new Error(
      'Не задан API key. Укажите ключ провайдера в настройках подключения или включите proxy-режим (тогда ключ хранится на сервере).',
    )
  }

  return {
    chatUrl: joinBase(base, '/chat/completions'),
    imagesUrl: joinBase(base, '/images/generations'),
    modelsUrl: joinBase(base, '/models'),
    headers: { Authorization: `Bearer ${settings.apiKey.trim()}` },
    mode: 'direct',
  }
}

/** OpenAiTransport — представление транспорта для OpenAI-совместимого API. */
export function toOpenAiTransport(resolved: ResolvedTransport): OpenAiTransport {
  return {
    chatUrl: resolved.chatUrl,
    imagesUrl: resolved.imagesUrl,
    modelsUrl: resolved.modelsUrl,
    headers: resolved.headers,
  }
}

/** AnthropicTransport — то же самое для Claude Messages API. */
export function toAnthropicTransport(resolved: ResolvedTransport): AnthropicTransport {
  return {
    messagesUrl: resolved.chatUrl,
    modelsUrl: resolved.modelsUrl,
    headers: resolved.headers,
  }
}
