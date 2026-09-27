/**
 * Политика повторов для сетевых запросов к провайдеру.
 *
 * Модуль намеренно «чистый»: без fetch, без ApiError и без DOM. Политику
 * используют и запрос чата, и проверки, поэтому её легко протестировать
 * отдельно: формула задержки, разбор Retry-After, пауза с отменой.
 *
 * Что повторяем: 429 (лимит) и 5xx (сбой на стороне провайдера/шлюза), а также
 * обрыв сети ДО того, как пришёл ответ. Что НЕ повторяем: 4xx кроме 429 —
 * там ответ не изменится, и всё, что случилось уже во время стрима: токены
 * могли прийти, повтор задвоил бы текст.
 */

/** Статусы, на которых повтор имеет смысл. */
export const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504] as const

/** Повторяем ли этот HTTP-статус. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== 'number') return false
  return (RETRYABLE_STATUSES as readonly number[]).includes(status)
}

export interface RetryPolicy {
  /** Сколько всего попыток (1 — без повторов) */
  maxAttempts?: number
  /** База экспоненциальной паузы, мс */
  baseDelayMs?: number
  /** Потолок паузы, мс */
  maxDelayMs?: number
}

export interface RequiredRetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

/** Значения по умолчанию: три попытки, 0.7 с → 1.4 с + джиттер. */
export const DEFAULT_RETRY_POLICY: RequiredRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 700,
  maxDelayMs: 8000,
}

/** Пользовательская политика поверх значений по умолчанию. */
export function resolveRetryPolicy(policy: RetryPolicy | undefined): RequiredRetryPolicy {
  const attempts = Number(policy?.maxAttempts)
  return {
    maxAttempts:
      Number.isFinite(attempts) && attempts >= 1
        ? Math.min(Math.round(attempts), 10)
        : DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: normalizeMs(policy?.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs),
    maxDelayMs: normalizeMs(policy?.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs),
  }
}

function normalizeMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback
}

/** Больше 30 с ждать «до следующей попытки» смысла нет — пользователь уже ушёл. */
export const MAX_RETRY_AFTER_MS = 30_000

/**
 * Заголовок Retry-After: секунды («2») или HTTP-дата («Wed, 21 Oct 2015 07:28:00 GMT»).
 * Возвращает миллисекунды ожидания либо undefined, если заголовка нет/он непонятен.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = (value ?? '').trim()
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.max(at - now, 0)
}

/**
 * Пауза перед повтором: приоритет у Retry-After (так просил сам провайдер),
 * иначе — экспонента с джиттером, чтобы несколько клиентов не били одновременно.
 */
export function retryDelayMs(input: {
  attempt: number
  retryAfterMs?: number
  policy?: RetryPolicy
  /** Подмена генератора случайных чисел — для проверок */
  random?: () => number
}): number {
  const policy = resolveRetryPolicy(input.policy)
  const random = input.random ?? Math.random
  if (input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs)) {
    return Math.min(Math.max(Math.round(input.retryAfterMs), 250), MAX_RETRY_AFTER_MS)
  }
  const exponential = policy.baseDelayMs * 2 ** Math.max(input.attempt, 0)
  const jitter = Math.round(random() * policy.baseDelayMs * 0.35)
  return Math.min(exponential + jitter, policy.maxDelayMs)
}

/** Пауза с поддержкой отмены (кнопка «Стоп» прерывает и ожидание повтора). */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

function abortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('Генерация остановлена.', 'AbortError')
  }
  const err = new Error('Генерация остановлена.')
  err.name = 'AbortError'
  return err
}

export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(ms, 0))
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** Строка для журнала отладки: что и почему повторяем. */
export function describeRetry(input: {
  attempt: number
  status?: number
  delayMs: number
  reason?: string
}): string {
  const what = input.status ? `HTTP ${input.status}` : (input.reason ?? 'сбой сети')
  return `Повтор ${input.attempt}: ${what} — ждём ${(input.delayMs / 1000).toFixed(1)} с`
}
