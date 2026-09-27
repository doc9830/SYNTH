import { CapacitorHttp } from '@capacitor/core'

/**
 * Нативный HTTP-мост для Android/iOS-сборки.
 *
 * Зачем: в мобильном приложении нет backend-прокси, а браузерные запросы
 * к чужим сервисам (Bing, DuckDuckGo, произвольные сайты) блокируются
 * политикой CORS. Мост отправляет такие запросы через нативный сетевой слой
 * Capacitor (OkHttp на Android), где CORS не действует.
 *
 * Стриминг (SSE, /chat/completions) остаётся на обычном fetch: нативный слой
 * буферизует ответ целиком и сломал бы потоковую выдачу.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
}

const STREAM_ACCEPT = 'text/event-stream'

let installed = false

/** true, если доступен нативный сетевой слой (APK/IPA). */
export function nativeHttpAvailable(): boolean {
  return Boolean((globalThis as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.())
}

/** Запрос должен идти через нативный слой? */
function needsNative(url: string, headers: Record<string, string>): boolean {
  if (!/^https?:/i.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url, globalThis.location?.href ?? 'https://localhost/')
  } catch {
    return false
  }
  // свои же эндпоинты (/api/*) и локальный backend — обычным fetch
  if (parsed.origin === globalThis.location?.origin) return false
  const accept = Object.entries(headers).find(([k]) => k.toLowerCase() === 'accept')?.[1] ?? ''
  // потоковую выдачу нативный слой не умеет — оставляем WebView
  if (accept.toLowerCase().includes(STREAM_ACCEPT)) return false
  return true
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k] = v))
  else if (Array.isArray(headers)) for (const [k, v] of headers) out[k] = v
  else Object.assign(out, headers)
  return out
}

function toBodyData(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  }
  return body
}

/** Один запрос через нативный слой с преобразованием в стандартный Response. */
async function nativeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: BodyInit | null | undefined,
): Promise<Response> {
  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data: toBodyData(body),
    responseType: 'text',
    connectTimeout: 20000,
    readTimeout: 40000,
  })

  const raw = res.data
  const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)
  const out = new Headers()
  for (const [k, v] of Object.entries(res.headers ?? {})) out.set(k, String(v))
  return new Response(text, { status: res.status, headers: out })
}

/**
 * Устанавливает мост поверх window.fetch. Идемпотентно, на веб-сборке — no-op.
 * Любая ошибка нативного пути приводит к обычному fetch: хуже не будет.
 */
export function installNativeHttpBridge(): void {
  if (installed || !nativeHttpAvailable()) return
  installed = true

  const original = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    let method = 'GET'
    let headers: Record<string, string> = {}
    let body: BodyInit | null | undefined = init?.body

    if (typeof input === 'string' || input instanceof URL) {
      url = String(input)
      method = (init?.method ?? 'GET').toUpperCase()
      headers = normalizeHeaders(init?.headers)
    } else {
      url = input.url
      method = (init?.method ?? input.method ?? 'GET').toUpperCase()
      headers = { ...normalizeHeaders(input.headers), ...normalizeHeaders(init?.headers) }
      if (body === undefined && input.body) body = input.body
    }

    if (!needsNative(url, headers)) return original(input, init)
    if (init?.signal?.aborted) throw new DOMException('Запрос отменён', 'AbortError')

    try {
      return await nativeRequest(url, method, headers, body)
    } catch {
      return original(input, init)
    }
  }
}
