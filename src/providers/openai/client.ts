import { ApiError, errorFromResponse, networkError } from './errors'
import { requestWithRetries, type RequestOptions } from './request'
import type { RetryPolicy } from './retry'
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

/** Подмены для проверок (свой fetch, мгновенная пауза, свой журнал). */
export type RequestDeps = Pick<RequestOptions, 'fetchImpl' | 'sleepImpl' | 'onRetry'>

async function ensureOk(res: Response, endpoint: string): Promise<void> {
  if (res.ok) return
  throw await errorFromResponse(res, endpoint)
}

export interface StreamCallOptions {
  signal: AbortSignal
  handlers?: StreamHandlers
  /** Повторы до старта потока: 429/5xx и обрыв сети (см. requestWithRetries) */
  policy?: RetryPolicy
  /** Молчание в потоке (мс), после которого ход обрывается; 0 — не следить */
  idleTimeoutMs?: number
  deps?: RequestDeps
}

/**
 * Основной вызов модели. Всегда стриминговый — так просит ТЗ
 * и так меньше шансов упасть по таймауту на длинных ответах.
 */
export async function streamChatCompletion(
  transport: OpenAiTransport,
  body: WireChatRequest,
  options: StreamCallOptions,
): Promise<AssistantTurn> {
  const res = await requestWithRetries(
    transport.chatUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...transport.headers,
      },
      body: JSON.stringify(body),
    },
    { ...options.deps, signal: options.signal, policy: options.policy },
  )

  return consumeChatStream(res, options.handlers, { idleTimeoutMs: options.idleTimeoutMs })
}

/** Нестримовый вызов — нужен для вспомогательных задач (например, chat-image моделей). */
export async function chatCompletion(
  transport: OpenAiTransport,
  body: WireChatRequest,
  options: {
    signal?: AbortSignal
    policy?: RetryPolicy
    deps?: RequestDeps
  } = {},
): Promise<AssistantTurn> {
  const res = await requestWithRetries(
    transport.chatUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...transport.headers },
      body: JSON.stringify({ ...body, stream: false }),
    },
    { ...options.deps, signal: options.signal, policy: options.policy },
  )

  const json = await res.json().catch(() => {
    throw new ApiError({ message: 'Ответ API не является JSON.', endpoint: transport.chatUrl })
  })
  return parseChatResponse(json)
}

/** Модель подключения: id + цена, если провайдер её отдаёт (например, OpenRouter). */
export interface ModelInfo {
  id: string
  pricing?: ModelPricing
}

/** Цена за 1М токенов в долларах (только то, что реально пришло от провайдера). */
export interface ModelPricing {
  prompt?: number
  completion?: number
}

/** Провайдеры отдают цену за токен строкой («0.000003») — переводим в $ за 1М. */
function toPerMillion(value: unknown): number | undefined {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(num) || num <= 0) return undefined
  return num * 1_000_000
}

/** GET /v1/models — модели подключения (id + необязательная цена). */
export async function fetchModels(
  transport: OpenAiTransport,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
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
  const json = (await res.json()) as {
    data?: Array<{ id?: string; pricing?: Record<string, unknown> }>
  }
  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const raw of json.data ?? []) {
    const id = typeof raw?.id === 'string' ? raw.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const prompt = toPerMillion(raw.pricing?.prompt)
    const completion = toPerMillion(raw.pricing?.completion)
    models.push(
      prompt === undefined && completion === undefined
        ? { id }
        : { id, pricing: { prompt, completion } },
    )
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/** GET /v1/models — только идентификаторы (списки, диагностика). */
export async function fetchModelIds(
  transport: OpenAiTransport,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await fetchModels(transport, signal)).map((m) => m.id)
}
