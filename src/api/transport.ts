import type { Settings } from '@/lib/settings'
import type { OpenAiTransport } from '@/providers/openai'

/**
 * Транспорт запросов: direct (браузер → API провайдера) или proxy
 * (браузер → наш backend → API провайдера).
 * В proxy-режиме API key живёт только на сервере и в bundle не попадает.
 */

export interface ResolvedTransport {
  /** Куда слать chat/completions */
  chatUrl: string
  /** Куда слать images/generations */
  imagesUrl: string
  /** Где брать список моделей */
  modelsUrl: string
  /** Заголовки (в direct-режиме содержат API key) */
  headers: Record<string, string>
  /** Какой транспорт используем — для диагностики */
  mode: 'direct' | 'proxy'
}

function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export function resolveTransport(settings: Settings): ResolvedTransport {
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
    throw new Error('Не задан Base URL. Укажите его в Settings → API.')
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
