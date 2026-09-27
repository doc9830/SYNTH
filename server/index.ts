import 'dotenv/config'
import { once } from 'node:events'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response as ExpressResponse } from 'express'
import { createSearchProvider } from '../src/providers/search'
import { findChrome } from './chrome'
import { PageInputError, readPage } from './reader'

/**
 * Локальный backend-proxy для OpenAI-совместимых API.
 *
 * Зачем он нужен:
 *  - API key остаётся на сервере (.env) и не попадает в frontend bundle;
 *  - web_search, чтение страниц по ссылке и генерация изображений работают
 *    даже там, где браузер блокирует CORS-запросы к провайдерам;
 *  - можно смотреть сырые запросы/ответы в терминале.
 *
 * Frontend в режиме proxy обращается к:
 *   POST /api/chat     → {PROVIDER_BASE_URL}/chat/completions (SSE passthrough)
 *   POST /api/image    → {PROVIDER_BASE_URL}/images/generations
 *   GET  /api/models   → {PROVIDER_BASE_URL}/models
 *   POST /api/search   → бесплатный поиск без ключа (Bing RSS / DuckDuckGo / Wikipedia)
 *                        либо Tavily / Brave / SearXNG, если так указано в настройках
 *   POST /api/page     → чтение страницы по ссылке (headless Chrome: текст + скриншот)
 */

const PORT = Number(process.env.PORT ?? 8787)
const BASE_URL = (process.env.PROVIDER_BASE_URL ?? process.env.RUAPI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
const ENV_API_KEY = (process.env.PROVIDER_API_KEY ?? process.env.RUAPI_API_KEY ?? '').trim()
const DEFAULT_MODEL = process.env.PROVIDER_MODEL ?? ''
const CORS_ORIGIN = (process.env.CORS_ORIGIN ?? '*').trim()

const app = express()
app.disable('x-powered-by')

app.use(
  cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',').map((s) => s.trim()),
    allowedHeaders: ['Content-Type', 'Accept', 'x-provider-key', 'x-ruapi-key', 'x-search-key'],
    methods: ['GET', 'POST', 'OPTIONS'],
  }),
)
// 25 МБ: в историю чата могут попадать изображения в base64
app.use(express.json({ limit: '25mb' }))

/** Ключ провайдера: приоритет — заголовок из UI, иначе значение из .env. */
function clientKey(req: Request): string {
  const header = req.header('x-provider-key') ?? req.header('x-ruapi-key')
  if (header && header.trim()) return header.trim()
  return ENV_API_KEY
}

function fail(res: ExpressResponse, status: number, message: string, hint?: string): void {
  res.status(status).json({ error: { message, ...(hint ? { hint } : {}) } })
}

/** Пробрасывает ошибку апстрима как есть, чтобы фронт показал точный текст. */
async function relayError(res: ExpressResponse, upstream: globalThis.Response, endpoint: string): Promise<void> {
  const text = await upstream.text().catch(() => '')
  res.status(upstream.status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.send(
    text && text.trim().startsWith('{')
      ? text
      : JSON.stringify({ error: { message: `Апстрим вернул HTTP ${upstream.status}`, endpoint, details: text.slice(0, 800) } }),
  )
}

/** GET /api/models — список моделей для селектора в настройках. */
app.get('/api/models', async (req, res) => {
  const key = clientKey(req)
  if (!key) return fail(res, 401, 'Не задан API-ключ провайдера.', 'Добавьте ключ в .env или укажите его в Settings → API.')

  try {
    const upstream = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    })
    if (!upstream.ok) return await relayError(res, upstream, `${BASE_URL}/models`)
    const json = (await upstream.json()) as { data?: Array<{ id?: string }> }
    const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
    res.json({ data: ids.map((id) => ({ id, object: 'model' })) })
  } catch (err) {
    fail(res, 502, `Не удалось обратиться к ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * POST /api/chat — основной эндпоинт.
 * Пробрасывает тело OpenAI-запроса в RuAPI и отдаёт SSE-поток байт-в-байт.
 */
app.post('/api/chat', async (req, res) => {
  const key = clientKey(req)
  if (!key) return fail(res, 401, 'Не задан API-ключ провайдера.', 'Добавьте ключ в .env или укажите его в Settings → API.')

  const body = req.body as Record<string, unknown>
  if (!body || !Array.isArray(body.messages)) {
    return fail(res, 400, 'Тело запроса должно содержать массив messages.')
  }

  const controller = new AbortController()
  // Клиент мог закрыть соединение (Esc, закрытие вкладки) — тогда прекращаем тянуть поток
  // от апстрима. 'close' на res срабатывает и при нормальном завершении ответа,
  // поэтому различаем случаи по res.writableEnded.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  let upstream: globalThis.Response
  try {
    upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: req.header('accept') ?? 'text/event-stream',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) return res.end()
    return fail(res, 502, `Не удалось обратиться к ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!upstream.ok) return await relayError(res, upstream, `${BASE_URL}/chat/completions`)
  if (!upstream.body) return fail(res, 502, 'Апстрим вернул пустой ответ.')

  res.status(200)
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // отключаем буферизацию у промежуточных прокси (nginx и пр.)
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) await once(res, 'drain')
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('Ошибка стрима:', err instanceof Error ? err.message : err)
    }
  } finally {
    res.end()
    void reader.cancel().catch(() => undefined)
  }
})

/** GET /api/health — проверка, что backend запущен и ключ виден. */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    hasKey: Boolean(ENV_API_KEY),
    defaultModel: DEFAULT_MODEL,
    search: {
      provider: process.env.SEARCH_PROVIDER || 'keyless',
      engine: process.env.SEARCH_ENGINE || 'auto',
      needsKey: ['tavily', 'brave'].includes(process.env.SEARCH_PROVIDER || 'keyless'),
      hasKey: Boolean((process.env.SEARCH_API_KEY ?? '').trim()),
      baseUrl: process.env.SEARCH_BASE_URL || null,
    },
    image: {
      provider: process.env.IMAGE_PROVIDER || 'ruapi-images',
      model: process.env.IMAGE_MODEL || 'gpt-image-2',
    },
    // чтение страниц по ссылке: без Chrome работает только статический разбор HTML
    page: {
      chrome: findChrome(),
      screenshots: Boolean(findChrome()),
    },
  })
})

/** POST /api/image — генерация через /v1/images/generations (b64_json). */
app.post('/api/image', async (req, res) => {
  const key = clientKey(req)
  if (!key) return fail(res, 401, 'Не задан API-ключ провайдера.', 'Добавьте ключ в .env или укажите его в Settings → API.')

  const body = (req.body ?? {}) as Record<string, unknown>
  if (!body.prompt) return fail(res, 400, 'В запросе генерации изображения нет поля prompt.')

  try {
    const upstream = await fetch(`${BASE_URL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    })
    if (!upstream.ok) return await relayError(res, upstream, `${BASE_URL}/images/generations`)
    const json = (await upstream.json()) as { data?: Array<{ b64_json?: string }> }
    if (!json.data?.some((d) => d.b64_json)) {
      return fail(
        res,
        502,
        'Image API не вернул b64_json.',
        'Проверьте модель генерации в Settings → Изображения (gpt-image-2) и параметр response_format.',
      )
    }
    res.json(json)
  } catch (err) {
    fail(res, 502, `Не удалось обратиться к ${BASE_URL}: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * POST /api/search — веб-поиск через backend.
 *
 * Провайдер по умолчанию — keyless: бесплатный поиск без API-ключей
 * (Bing RSS → DuckDuckGo → Wikipedia, перебор в режиме engine=auto).
 * Tavily / Brave / SearXNG поддерживаются как опция (нужен ключ или инстанс).
 * Ключ поиска, если он нужен, берётся из заголовка x-search-key или из .env.
 */
app.post('/api/search', async (req, res) => {
  const body = (req.body ?? {}) as {
    query?: string
    provider?: string
    engine?: string
    maxResults?: number
  }
  const query = (body.query ?? '').trim()
  if (!query) return fail(res, 400, 'Не указан поисковый запрос (query).')

  const providerId = (body.provider || process.env.SEARCH_PROVIDER || 'keyless') as
    | 'keyless'
    | 'tavily'
    | 'brave'
    | 'searxng'
  const engine = (body.engine || process.env.SEARCH_ENGINE || 'auto') as
    | 'auto'
    | 'bing'
    | 'duckduckgo'
    | 'wikipedia'
  const maxResults = Math.min(Math.max(Number(body.maxResults) || 5, 1), 10)
  const apiKey = (req.header('x-search-key') ?? process.env.SEARCH_API_KEY ?? '').trim()

  const provider = createSearchProvider({
    enabled: true,
    provider: providerId,
    engine,
    readPages: true,
    apiKey,
    baseUrl: (process.env.SEARCH_BASE_URL ?? '').trim(),
    backendUrl: '',
    maxResults,
  })

  if (!provider) return fail(res, 400, `Неизвестный провайдер поиска: ${providerId}.`)
  if (provider.requiresKey && !apiKey) {
    return fail(
      res,
      401,
      `Провайдер «${provider.label}» требует API key.`,
      'Добавьте SEARCH_API_KEY в .env на сервере, укажите ключ в Settings → Web Search или выберите бесплатный поиск (без ключа).',
    )
  }

  try {
    const results = await provider.search(query, { maxResults })
    res.json({ results, provider: provider.id, engine: providerId === 'keyless' ? engine : undefined })
  } catch (err) {
    fail(res, 502, err instanceof Error ? err.message : String(err))
  }
})

/**
 * POST /api/page — прочитать страницу по ссылке.
 *
 * Chrome рендерит страницу (важно для JS-лендингов) и отдаёт отрендеренный текст,
 * заголовки, ссылки, картинки, дизайн-токены (цвета/шрифт) и, если screenshot=true,
 * скриншот в виде data URL. Без Chrome работает статический разбор HTML.
 * Выполняется на backend, потому что произвольные сайты не отдают CORS браузеру.
 */
app.post('/api/page', async (req, res) => {
  const body = (req.body ?? {}) as {
    url?: string
    screenshot?: boolean
    fullPage?: boolean
    maxChars?: number
    waitMs?: number
    timeoutMs?: number
    width?: number
  }
  const url = (body.url ?? '').trim()
  if (!url) return fail(res, 400, 'Не указан URL страницы (url).')

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })

  try {
    const page = await readPage({
      url,
      screenshot: body.screenshot !== false,
      fullPage: Boolean(body.fullPage),
      ...(Number.isFinite(Number(body.maxChars)) && body.maxChars ? { maxChars: Number(body.maxChars) } : {}),
      ...(Number.isFinite(Number(body.waitMs)) ? { waitMs: Number(body.waitMs) } : {}),
      ...(Number.isFinite(Number(body.timeoutMs)) && body.timeoutMs ? { timeoutMs: Number(body.timeoutMs) } : {}),
      ...(Number.isFinite(Number(body.width)) && body.width ? { width: Number(body.width) } : {}),
      signal: controller.signal,
    })
    res.json({ page })
  } catch (err) {
    if (controller.signal.aborted) return res.end()
    if (err instanceof PageInputError) return fail(res, 400, err.message)
    fail(res, 502, err instanceof Error ? err.message : String(err))
  }
})

app.use('/api', (_req, res) => {
  fail(res, 404, 'Такого эндпоинта нет. Доступны: /api/health, /api/models, /api/chat, /api/image, /api/search, /api/page.')
})

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: ExpressResponse, _next: NextFunction) => {
  console.error('Необработанная ошибка:', err)
  if (res.headersSent) return
  fail(res, 500, err instanceof Error ? err.message : 'Внутренняя ошибка backend.')
})

app.listen(PORT, () => {
  console.log(`\n  RuAPI proxy → http://localhost:${PORT}`)
  console.log(`  Апстрим:      ${BASE_URL}`)
  console.log(`  Ключ из .env: ${ENV_API_KEY ? 'задан' : 'НЕ ЗАДАН (укажите PROVIDER_API_KEY)'}`)
  console.log(`  CORS origin:  ${CORS_ORIGIN}`)
  console.log(`  Healthcheck:  http://localhost:${PORT}/api/health\n`)
})
