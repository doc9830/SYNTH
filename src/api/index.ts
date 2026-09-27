import type { ChatMessage, PageReadResult, SearchResult } from '@/types'
import type { Settings } from '@/lib/settings'
import { nativeHttpAvailable } from '@/lib/nativeHttp'
import { normalizeUrl, readStaticPage } from '@/lib/pageStatic'
import {
  ApiError,
  errorFromResponse,
  streamChatCompletion,
  type OpenAiTransport,
  type StreamHandlers,
} from '@/providers/openai'
import type { AssistantTurn, WireMessage, WireTool } from '@/providers/openai/types'
import { createSearchProvider } from '@/providers/search'
import { resolveTransport, toOpenAiTransport, type ResolvedTransport } from './transport'

export * from './transport'

export interface ChatTurnRequest {
  messages: WireMessages
  tools?: WireTool[]
  signal: AbortSignal
  handlers?: StreamHandlers
  temperature?: number
  maxTokens?: number | null
  stream?: boolean
}

/** Wire-сообщения чата (OpenAI-совместимый протокол). */
export type WireMessages = WireMessage[]

function resolve(settings: Settings): ResolvedTransport {
  try {
    return resolveTransport(settings)
  } catch (err) {
    throw new ApiError({
      message: err instanceof Error ? err.message : String(err),
      hint: 'Откройте Settings → API и заполните Base URL и API key (или переключитесь на proxy-режим).',
    })
  }
}

/** Один проход модели (со streaming). */
export async function chatTurn(
  settings: Settings,
  req: ChatTurnRequest,
): Promise<AssistantTurn> {
  const transport = toOpenAiTransport(resolve(settings))
  return streamChatCompletion(
    transport,
    {
      model: settings.model,
      messages: req.messages,
      stream: req.stream !== false,
      tools: req.tools,
      temperature: req.temperature ?? settings.temperature,
      max_tokens: req.maxTokens ?? settings.maxTokens ?? undefined,
      stream_options: { include_usage: true },
    },
    { signal: req.signal, handlers: req.handlers },
  )
}

/** Список моделей: GET /v1/models (или /api/models в proxy-режиме). */
export async function listModels(settings: Settings, signal?: AbortSignal): Promise<string[]> {
  const resolved = resolve(settings)
  const transport: OpenAiTransport = toOpenAiTransport(resolved)
  const { fetchModelIds } = await import('@/providers/openai/client')
  return fetchModelIds(transport, signal)
}

/** База backend-прокси: пусто → эндпоинты текущего сайта (/api/…). */
function resolveBackendBase(settings: Settings): string {
  const raw = settings.search.backendUrl.trim().replace(/\/+$/, '')
  if (!raw) return ''
  // пользователь мог вставить полный путь /api/search — берём только базу
  return raw.replace(/\/api\/(?:search|page)$/i, '')
}

/** Куда обращаться за search/page в direct-режиме: свой backend (CORS у сайтов нет). */
function backendEndpoint(settings: Settings, path: '/api/search' | '/api/page'): string {
  const base = resolveBackendBase(settings)
  return base ? `${base}${path}` : path
}

/** Заголовки для запросов к своему backend (ключ RuAPI нужен только для чата/картинок). */
function backendHeaders(settings: Settings, extra?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(settings.mode === 'proxy' && settings.apiKey ? { 'x-provider-key': settings.apiKey.trim() } : {}),
    ...extra,
  }
}

/**
 * Веб-поиск.
 *  - proxy-режим → всегда наш backend (/api/search);
 *  - direct + бесплатный провайдер (Bing/DuckDuckGo/Wikipedia) → тоже backend,
 *    потому что эти сервисы не отдают CORS-заголовки браузеру;
 *  - direct + Tavily/Brave/SearXNG → прямой запрос из браузера.
 * API key RuAPI для поиска не нужен.
 */
export async function searchWeb(
  query: string,
  settings: Settings,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const maxResults = settings.search.maxResults
  const provider = createSearchProvider({ ...settings.search, enabled: true })
  if (!provider) {
    throw new ApiError({
      message: 'Веб-поиск отключён.',
      hint: 'Включите его в Settings → Web Search.',
    })
  }

  const backendSearchUrl = settings.mode === 'proxy' ? '/api/search' : backendEndpoint(settings, '/api/search')
  // В APK нативный HTTP обходит CORS, поэтому «серверные» движки
  // (Bing / DuckDuckGo / Wikipedia) выполняются прямо в приложении: backend не нужен.
  const localNative =
    nativeHttpAvailable() && settings.mode === 'direct' && !settings.search.backendUrl.trim()
  const useBackend =
    !localNative &&
    (settings.mode === 'proxy' ||
      Boolean(provider.serverSide) ||
      Boolean(settings.search.backendUrl.trim()))

  if (useBackend) {
    let res: Response
    try {
      res = await fetch(backendSearchUrl, {
        method: 'POST',
        headers: backendHeaders(
          settings,
          provider.requiresKey && settings.search.apiKey
            ? { 'x-search-key': settings.search.apiKey.trim() }
            : {},
        ),
        body: JSON.stringify({
          query,
          provider: settings.search.provider,
          engine: settings.search.engine,
          maxResults,
        }),
        signal,
      })
    } catch (err) {
      throw new ApiError({
        message: `Не удалось обратиться к backend-поиску (${backendSearchUrl}): ${err instanceof Error ? err.message : String(err)}`,
        endpoint: backendSearchUrl,
        hint: 'Запустите backend (npm run dev:api). Если фронтенд открыт не с backend-хоста, укажите Settings → Web Search → Backend URL, например http://localhost:8787.',
      })
    }
    if (!res.ok) throw await errorFromResponse(res, backendSearchUrl)
    const json = (await res.json()) as { results?: SearchResult[] }
    return json.results ?? []
  }

  try {
    return await provider.search(query, { maxResults, signal })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cors = /failed to fetch|networkerror|load failed|cors/i.test(message)
    throw new ApiError({
      message,
      endpoint: provider.label,
      hint: cors
        ? `Провайдер «${provider.label}» не разрешает запросы из браузера (CORS). Включите proxy-режим в Settings → API или укажите Backend URL в Settings → Web Search.`
        : undefined,
    })
  }
}

/** Ответ backend-эндпоинта /api/page (см. server/reader.ts). */
interface RawPageResponse {
  page?: {
    url?: string
    finalUrl?: string
    title?: string
    description?: string
    ogImage?: string
    lang?: string
    headings?: string[]
    text?: string
    truncated?: boolean
    links?: Array<{ title?: string; url?: string }>
    images?: Array<{ src?: string; alt?: string; width?: number; height?: number }>
    design?: { background: string; color: string; font: string; colors: string[] }
    engine?: 'chrome' | 'static'
    screenshot?: { dataUrl?: string; format?: string; width?: number; height?: number; bytes?: number }
    warnings?: string[]
  }
}

/**
 * Локальное чтение страницы внутри приложения (APK): нативный HTTP + разбор HTML.
 * Браузера и скриншотов здесь нет — отдаём текст, структуру и метаданные.
 */
async function readLocalPage(
  url: string,
  opts: { screenshot?: boolean; fullPage?: boolean; maxChars?: number; signal?: AbortSignal } = {},
): Promise<PageReadResult> {
  let page
  try {
    page = await readStaticPage(normalizeUrl(url), {
      maxChars: opts.maxChars ?? 8000,
      signal: opts.signal,
    })
  } catch (err) {
    throw new ApiError({
      message: err instanceof Error ? err.message : String(err),
      hint: 'Проверьте ссылку и соединение. Скриншоты страниц требуют внешнего backend: укажите его в Settings → Web Search → Backend URL.',
    })
  }

  return {
    url: page.url,
    finalUrl: page.finalUrl,
    title: page.title,
    description: page.description,
    ogImage: page.ogImage,
    lang: page.lang,
    headings: page.headings,
    text: page.text,
    truncated: page.truncated,
    links: page.links.map((l) => ({ title: l.title, url: l.url, snippet: '', source: 'page' })),
    images: page.images,
    engine: 'static',
    warnings: [
      ...page.warnings,
      'Страница прочитана в приложении без браузера: скриншот недоступен, JS-контент может отсутствовать.',
    ],
  }
}

/**
 * Чтение страницы по ссылке (инструмент read_url).
 *
 * Всегда выполняется на backend: произвольные сайты не отдают CORS браузеру,
 * а рендер JS и скриншот умеет делать только серверный headless Chrome.
 */
export async function readPage(
  url: string,
  settings: Settings,
  opts: { screenshot?: boolean; fullPage?: boolean; maxChars?: number; signal?: AbortSignal } = {},
): Promise<PageReadResult> {
  // Автономный режим (APK без внешнего backend): читаем страницу прямо в приложении.
  if (nativeHttpAvailable() && settings.mode === 'direct' && !settings.search.backendUrl.trim()) {
    return readLocalPage(url, opts)
  }

  const endpoint = settings.mode === 'proxy' ? '/api/page' : backendEndpoint(settings, '/api/page')
  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: backendHeaders(settings),
      body: JSON.stringify({
        url,
        screenshot: opts.screenshot !== false,
        fullPage: Boolean(opts.fullPage),
        ...(opts.maxChars ? { maxChars: opts.maxChars } : {}),
      }),
      signal: opts.signal,
    })
  } catch (err) {
    throw new ApiError({
      message: `Не удалось обратиться к backend-чтению страниц (${endpoint}): ${err instanceof Error ? err.message : String(err)}`,
      endpoint,
      hint: 'Нужен запущенный backend: npm run dev:api (для скриншотов — с установленным Chrome). Если фронтенд открыт не с backend-хоста — укажите Settings → Web Search → Backend URL, например http://localhost:8787.',
    })
  }
  if (!res.ok) throw await errorFromResponse(res, endpoint)

  const json = (await res.json()) as RawPageResponse
  const p = json.page
  if (!p) {
    throw new ApiError({ message: 'Backend вернул пустой ответ при чтении страницы.', endpoint })
  }

  const screenshot = p.screenshot?.dataUrl
    ? {
        dataUrl: p.screenshot.dataUrl,
        width: p.screenshot.width ?? 0,
        height: p.screenshot.height ?? 0,
        bytes: p.screenshot.bytes ?? 0,
      }
    : undefined

  return {
    url: p.url ?? url,
    finalUrl: p.finalUrl ?? p.url ?? url,
    title: p.title ?? '',
    description: p.description ?? '',
    ogImage: p.ogImage,
    lang: p.lang ?? '',
    headings: p.headings ?? [],
    text: p.text ?? '',
    truncated: Boolean(p.truncated),
    links: (p.links ?? [])
      .filter((l) => l.url)
      .map((l) => ({ title: l.title || (l.url as string), url: l.url as string, snippet: '', source: 'page' })),
    images: (p.images ?? [])
      .filter((i) => i.src)
      .map((i) => ({ src: i.src as string, alt: i.alt, width: i.width, height: i.height })),
    design: p.design,
    engine: p.engine ?? 'static',
    screenshot,
    warnings: p.warnings ?? [],
  }
}

/** Генерация изображений через RuAPI (или backend proxy). */
export async function generateImages(
  settings: Settings,
  input: { model: string; prompt: string; size?: string; quality?: 'low' | 'medium' | 'high' },
  signal?: AbortSignal,
): Promise<{ images: string[]; text: string; provider: string }> {
  const resolved = resolve(settings)
  const { generateImage } = await import('@/providers/openai/images')
  return generateImage(
    toOpenAiTransport(resolved),
    {
      model: input.model,
      prompt: input.prompt,
      size: input.size ?? settings.image.size,
      quality: input.quality ?? settings.image.quality,
      n: 1,
    },
    signal,
  )
}

/** Актуальные сообщения чата в wire-формате (без специфики UI). */
export function historyToWire(messages: ChatMessage[]): WireMessages {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
}
