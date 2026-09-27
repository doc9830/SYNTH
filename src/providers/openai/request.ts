import { debugLog } from '@/lib/debug'
import { ApiError, errorFromResponse, networkError } from './errors'
import {
  describeRetry,
  isRetryableStatus,
  resolveRetryPolicy,
  retryDelayMs,
  sleep,
  type RetryPolicy,
  type SleepFn,
} from './retry'

/**
 * fetch с повторами: 429 и 5xx повторяются с экспоненциальной паузой, при
 * наличии заголовка Retry-After — ровно через указанное провайдером время.
 *
 * Повторы происходят ТОЛЬКО до получения успешного ответа. Как только пришёл
 * 200 и начался разбор потока, повторов нет: часть текста уже могла уехать
 * в чат, и «повторить» означало бы задвоить ответ. Обрыв уже начатого потока
 * закрывает отдельная защита — таймаут тишины (см. sse.ts).
 */
export interface RequestOptions {
  signal?: AbortSignal
  /** Сколько всего попыток и с какими паузами */
  policy?: RetryPolicy
  /** Подмена fetch — для проверок */
  fetchImpl?: typeof fetch
  /** Подмена паузы — для проверок (чтобы не ждать реальные секунды) */
  sleepImpl?: SleepFn
  /** Куда писать журнал повторов */
  onRetry?: (message: string) => void
}

export async function requestWithRetries(
  url: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const wait = options.sleepImpl ?? sleep
  const policy = resolveRetryPolicy(options.policy)
  const log = options.onRetry ?? ((message: string) => debugLog('info', message, []))
  const signal = options.signal ?? (init.signal as AbortSignal | undefined | null) ?? undefined

  let lastError: ApiError | undefined

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    let res: Response
    try {
      res = await fetchImpl(url, { ...init, signal })
    } catch (err) {
      const apiError = networkError(err, url)
      const aborted =
        signal?.aborted === true || (err instanceof Error && err.name === 'AbortError')
      if (aborted || attempt >= policy.maxAttempts - 1) throw apiError
      const delayMs = retryDelayMs({ attempt, policy })
      log(describeRetry({ attempt: attempt + 1, delayMs, reason: apiError.message }))
      await wait(delayMs, signal)
      lastError = apiError
      continue
    }

    if (res.ok) return res

    const apiError = await errorFromResponse(res, url)
    if (!isRetryableStatus(res.status) || attempt >= policy.maxAttempts - 1) throw apiError
    const delayMs = retryDelayMs({ attempt, retryAfterMs: apiError.retryAfterMs, policy })
    log(describeRetry({ attempt: attempt + 1, status: res.status, delayMs }))
    await wait(delayMs, signal)
    lastError = apiError
  }

  throw lastError ?? new ApiError({ message: 'Запрос не удался.', endpoint: url })
}
