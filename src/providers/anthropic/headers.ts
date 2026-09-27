/**
 * Константы и заголовки Anthropic Messages API.
 *
 * Отдельный модуль без зависимостей: его импортирует сборка транспорта
 * (src/api/transport.ts), а сам клиент провайдера подгружается лениво —
 * так код Claude не попадает в основной бандл без надобности.
 */

/** Обязательный заголовок версии API. */
export const ANTHROPIC_VERSION = '2023-06-01'

/**
 * Разрешает браузерные (CORS) запросы к api.anthropic.com.
 * Без него WebView/браузер не сможет обратиться к API напрямую.
 */
export const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access'

/**
 * Anthropic не работает без max_tokens (в отличие от OpenAI),
 * поэтому при пустом значении в настройках подставляем этот лимит.
 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192

/**
 * Заголовки Claude: ключ уходит в x-api-key, а не в Authorization,
 * плюс обязательная версия API и разрешение браузерного доступа.
 */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey.trim(),
    'anthropic-version': ANTHROPIC_VERSION,
    [ANTHROPIC_BROWSER_HEADER]: 'true',
  }
}
