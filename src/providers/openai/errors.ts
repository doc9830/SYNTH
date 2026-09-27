/**
 * Ошибки OpenAI-совместимых API в человекочитаемом виде.
 * Коды разобраны по типовым ответам провайдеров: 401 / 402 / 403 / 404 / 429 / 5xx.
 */

export interface ApiErrorInit {
  message: string
  status?: number
  endpoint?: string
  hint?: string
  details?: string
  code?: string
}

export class ApiError extends Error {
  readonly status?: number
  readonly endpoint?: string
  readonly hint?: string
  readonly details?: string
  readonly code?: string

  constructor(init: ApiErrorInit) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.endpoint = init.endpoint
    this.hint = init.hint
    this.details = init.details
    this.code = init.code
  }
}

const STATUS_MESSAGES: Record<number, { message: string; hint: string }> = {
  400: {
    message: 'Неверный запрос к API.',
    hint: 'Проверьте параметры запроса: модель, tools и историю сообщений.',
  },
  401: {
    message: 'API key не принят (401 Unauthorized).',
    hint: 'Проверьте, что ключ действующий (обычно начинается на sk-), скопирован без лишних пробелов и активен в личном кабинете провайдера. В proxy-режиме проверьте ключ в .env на сервере.',
  },
  402: {
    message: 'На балансе провайдера закончились средства (402).',
    hint: 'Пополните баланс в личном кабинете провайдера или подключите другой API key.',
  },
  403: {
    message: 'Доступ запрещён (403).',
    hint: 'Проверьте права API-ключа и лимиты расхода в личном кабинете провайдера.',
  },
  404: {
    message: 'Не найдено: модель или endpoint (404).',
    hint: 'Проверьте имя модели (должно точно совпадать с каталогом провайдера) и Base URL: для OpenAI-протокола он обычно оканчивается на /v1.',
  },
  413: {
    message: 'Запрос слишком большой (413).',
    hint: 'Уменьшите изображения перед отправкой или сократите историю.',
  },
  415: {
    message: 'Неподдерживаемый тип файла (415).',
    hint: 'Поддерживаются jpeg, png, webp, gif.',
  },
  422: {
    message: 'Параметры запроса не приняты (422).',
    hint: 'Проверьте schema инструментов и формат сообщений.',
  },
  429: {
    message: 'Слишком много запросов (429 Too Many Requests).',
    hint: 'Подождите несколько секунд — сработал rate limit. Повторите отправку.',
  },
  500: {
    message: 'Ошибка на стороне провайдера (500).',
    hint: 'Повторите запрос через несколько секунд.',
  },
  502: {
    message: 'Апстрим-провайдер недоступен (502).',
    hint: 'Повторите запрос — это временный сбой на стороне провайдера модели.',
  },
  503: {
    message: 'Сервис временно недоступен (503).',
    hint: 'Повторите запрос через несколько секунд.',
  },
  504: {
    message: 'Таймаут на стороне шлюза (504).',
    hint: 'Повторите запрос; для длинных ответов отключите лишние tools.',
  },
}

/**
 * Сообщение провайдера о том, что картинку в запросе он не принимает.
 * Отдельная подсказка нужна, потому что решение «модель понимает изображения»
 * принимает эвристика приложения (см. getModelCapabilities) — а она может
 * ошибаться на нестандартных id моделей у шлюзов.
 */
const IMAGE_REJECTED_RE =
  /(image_url|image input|image content|vision|multi-?modal|content.*image|image.*not support|изображени|картинк|нескольких типов)/i

/** Подсказка, когда провайдер отклонил запрос из-за изображения. */
export const IMAGE_REJECTED_HINT =
  'Похоже, модель не принимает изображения на вход. Уберите вложение, выберите vision-модель или в Настройки → Подключение → «Изображения на вход» поставьте «Нет», чтобы приложение больше не отправляло картинки.'

function extractMessage(body: unknown): { message?: string; code?: string } {
  if (!body || typeof body !== 'object') return {}
  const obj = body as Record<string, unknown>
  const err = obj.error
  if (typeof err === 'string') return { message: err }
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    return {
      message: typeof e.message === 'string' ? e.message : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
    }
  }
  if (typeof obj.message === 'string') return { message: obj.message }
  if (typeof obj.detail === 'string') return { message: obj.detail }
  return {}
}

/** Преобразует неуспешный HTTP-ответ в ApiError. */
export async function errorFromResponse(res: Response, endpoint: string): Promise<ApiError> {
  let body: unknown
  const text = await res.text().catch(() => '')
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  const { message: upstream, code } = extractMessage(body)
  const known = STATUS_MESSAGES[res.status]
  const parts: string[] = []
  if (upstream) parts.push(upstream)
  // Провайдер ругается на картинку — подсказываем, что делать, вместо
  // общего «проверьте параметры запроса».
  const imageRejected = Boolean(upstream && IMAGE_REJECTED_RE.test(upstream))

  return new ApiError({
    message: parts.length
      ? `${parts.join(' ')} (HTTP ${res.status})`
      : known?.message ?? `Запрос не удался (HTTP ${res.status})`,
    status: res.status,
    endpoint,
    hint: imageRejected ? IMAGE_REJECTED_HINT : known?.hint,
    code,
    details: typeof text === 'string' ? text.slice(0, 2000) : undefined,
  })
}

export function networkError(err: unknown, endpoint: string): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof DOMException && err.name === 'AbortError') {
    return new ApiError({ message: 'Генерация остановлена.', endpoint })
  }
  const message = err instanceof Error ? err.message : String(err)
  const isCors = /failed to fetch|networkerror|load failed/i.test(message)
  return new ApiError({
    message: isCors
      ? 'Не удалось соединиться с API (сеть или CORS).'
      : `Ошибка сети: ${message}`,
    endpoint,
    hint: isCors
      ? 'Проверьте интернет и Base URL. В direct-режиме браузер обращается к API напрямую — если соединение блокируется (CORS), включите proxy-режим или используйте Android-приложение.'
      : undefined,
    details: message,
  })
}

/** Текст ошибки для сообщения в чате. */
export function formatApiError(err: ApiError): string {
  const lines = [err.message]
  if (err.hint) lines.push(err.hint)
  return lines.join('\n\n')
}
