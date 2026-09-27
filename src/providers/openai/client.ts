import { ApiError, errorFromResponse, networkError } from './errors'
import { consumeChatStream, parseChatResponse, type StreamHandlers } from './sse'
import type { AssistantTurn, WireChatRequest } from './types'

/**
 * Транспорт OpenAI-совместимого API: адреса endpoint'ов и заголовки.
 * Резолвится выше (src/api/transport.ts) в зависимости от режима direct/proxy —
 * сам провайдер не знает, идёт запрос напрямую или через наш backend.
 */
export interface OpenAiTransport {
  chatUrl: string
  modelsUrl: string
  imagesUrl: string
  headers: Record<string, string>
}

async function ensureOk(res: Response, endpoint: string): Promise<void> {
  if (res.ok) return
  throw await errorFromResponse(res, endpoint)
}

/**
 * Основной вызов модели. Всегда стриминговый — так просит ТЗ
 * и так меньше шансов упасть по таймауту на длинных ответах.
 */
export async function streamChatCompletion(
  transport: OpenAiTransport,
  body: WireChatRequest,
  options: { signal: AbortSignal; handlers?: StreamHandlers },
): Promise<AssistantTurn> {
  let res: Response
  try {
    res = await fetch(transport.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...transport.headers,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (err) {
    throw networkError(err, transport.chatUrl)
  }

  await ensureOk(res, transport.chatUrl)
  return consumeChatStream(res, options.handlers)
}

/** Нестримовый вызов — нужен для вспомогательных задач (например, chat-image моделей). */
export async function chatCompletion(
  transport: OpenAiTransport,
  body: WireChatRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AssistantTurn> {
  let res: Response
  try {
    res = await fetch(transport.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...transport.headers },
      body: JSON.stringify({ ...body, stream: false }),
      signal: options.signal,
    })
  } catch (err) {
    throw networkError(err, transport.chatUrl)
  }

  await ensureOk(res, transport.chatUrl)
  const json = await res.json().catch(() => {
    throw new ApiError({ message: 'Ответ API не является JSON.', endpoint: transport.chatUrl })
  })
  return parseChatResponse(json)
}

/** GET /v1/models — список доступных моделей (чтобы модель не была хардкодом). */
export async function fetchModelIds(
  transport: OpenAiTransport,
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

  await ensureOk(res, transport.modelsUrl)
  const json = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b))
}
