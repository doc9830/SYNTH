import { ApiError, errorFromResponse, networkError } from '@/providers/openai/errors'
import type { StreamHandlers } from '@/providers/openai/sse'
import type { AssistantTurn, WireChatRequest } from '@/providers/openai/types'
import { consumeAnthropicStream } from './stream'
import { fromAnthropicResponse, toAnthropicRequest } from './translate'
import type { AnthropicResponse } from './types'

/**
 * Транспорт Anthropic Messages API: адреса эндпоинтов и заголовки.
 *
 * Как и OpenAI-путь, клиент не знает про режим direct/proxy — адреса
 * и заголовки собирает src/api/transport.ts. Из-за этого Claude можно
 * подключить как «свой адрес» (шлюз, прокси, корпоративный релей).
 * Заголовки (x-api-key, anthropic-version) — в headers.ts.
 */
export interface AnthropicTransport {
  /** POST /v1/messages */
  messagesUrl: string
  /** GET /v1/models */
  modelsUrl: string
  headers: Record<string, string>
}

/**
 * Основной вызов модели. Всегда стриминговый — как и в OpenAI-ветке:
 * так меньше шансов упасть по таймауту на длинных ответах.
 */
export async function streamAnthropicMessages(
  transport: AnthropicTransport,
  body: WireChatRequest,
  options: { signal: AbortSignal; handlers?: StreamHandlers },
): Promise<AssistantTurn> {
  const payload = toAnthropicRequest({ ...body, stream: true })

  let res: Response
  try {
    res = await fetch(transport.messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...transport.headers,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    })
  } catch (err) {
    throw networkError(err, transport.messagesUrl)
  }

  if (!res.ok) throw await errorFromResponse(res, transport.messagesUrl)
  if (!res.body) {
    throw new ApiError({
      message: 'Anthropic вернул пустой поток ответа.',
      endpoint: transport.messagesUrl,
    })
  }

  return consumeAnthropicStream(res.body, options.handlers)
}

/** Нестримовый вызов — служебные задачи интерфейса (память, проверки). */
export async function anthropicMessages(
  transport: AnthropicTransport,
  body: WireChatRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AssistantTurn> {
  const payload = toAnthropicRequest({ ...body, stream: false })

  let res: Response
  try {
    res = await fetch(transport.messagesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...transport.headers },
      body: JSON.stringify(payload),
      signal: options.signal,
    })
  } catch (err) {
    throw networkError(err, transport.messagesUrl)
  }

  if (!res.ok) throw await errorFromResponse(res, transport.messagesUrl)
  const json = await res.json().catch(() => {
    throw new ApiError({
      message: 'Ответ Anthropic не является JSON.',
      endpoint: transport.messagesUrl,
    })
  })
  return fromAnthropicResponse(json as AnthropicResponse)
}

/** GET /v1/models — идентификаторы моделей подключения (Claude и релеи). */
export async function fetchAnthropicModels(
  transport: AnthropicTransport,
  signal?: AbortSignal,
): Promise<string[]> {
  let res: Response
  try {
    res = await fetch(transport.modelsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json', ...transport.headers },
      signal,
    })
  } catch (err) {
    throw networkError(err, transport.modelsUrl)
  }

  if (!res.ok) throw await errorFromResponse(res, transport.modelsUrl)
  const json = (await res.json()) as { data?: Array<{ id?: string }> }
  const seen = new Set<string>()
  const ids: string[] = []
  for (const raw of json.data ?? []) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids.sort((a, b) => a.localeCompare(b))
}
