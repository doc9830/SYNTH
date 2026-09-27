import type { KeylessEngine, SearchResult } from '@/types'
import type { SearchQueryOptions, WebSearchProvider } from './types'

/**
 * Бесплатный веб-поиск без API-ключей и регистрации.
 *
 * Движки (в режиме «авто» перебираются по порядку):
 *  1. Bing RSS   — GET https://www.bing.com/search?q=...&format=rss (XML без ключа);
 *  2. DuckDuckGo — POST на html/lite-версию выдачи + Instant Answer API;
 *  3. Wikipedia  — MediaWiki API (ru.wikipedia.org), энциклопедический фолбэк.
 *
 * Bing и DuckDuckGo не отдают CORS-заголовки, поэтому движки выполняются
 * на нашем backend (см. provider.serverSide) — браузеру их вызывать нельзя.
 */

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const ACCEPT_LANG = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'

export const KEYLESS_ENGINE_LABELS: Record<KeylessEngine, string> = {
  auto: 'Авто (Bing → DuckDuckGo → Wikipedia)',
  bing: 'Bing (RSS)',
  duckduckgo: 'DuckDuckGo',
  wikipedia: 'Wikipedia (ru)',
}

/** Порядок перебора движков в режиме «авто». */
export const KEYLESS_AUTO_ORDER: Array<Exclude<KeylessEngine, 'auto'>> = [
  'bing',
  'duckduckgo',
  'wikipedia',
]

// ── Утилиты разбора HTML/XML ─────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  rsquo: '’',
  lsquo: '‘',
  middot: '·',
  copy: '©',
  reg: '®',
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number(dec)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

/** Убирает теги и HTML-сущности, схлопывает пробелы. */
function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Содержимое тега в XML-блоке (с поддержкой CDATA). */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''
}

function parseDate(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? value : new Date(ts).toISOString()
}

/** Запрос без исключения на не-2xx: статус нужен вызывающему коду. */
async function request(
  url: string,
  init: RequestInit,
  label: string,
): Promise<{ status: number; body: string }> {
  let res: Response
  try {
    res = await fetch(url, { ...init, redirect: 'follow' })
  } catch (err) {
    throw new Error(`${label}: нет соединения (${err instanceof Error ? err.message : String(err)})`)
  }
  const body = await res.text().catch(() => '')
  return { status: res.status, body }
}

// ── Движок 1: Bing RSS ───────────────────────────────────────────────

async function searchBing(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
  // Bing RSS — устаревший, но бесплатный эндпоинт: для части запросов (особенно
  // русскоязычных) выдачу отдаёт только с явной локалью, поэтому пробуем два варианта.
  const encoded = encodeURIComponent(query)
  const urls = [
    `https://www.bing.com/search?q=${encoded}&format=rss&mkt=ru-RU&cc=RU`,
    `https://www.bing.com/search?q=${encoded}&format=rss`,
  ]

  for (const url of urls) {
    const { status, body } = await request(
      url,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
          'Accept-Language': ACCEPT_LANG,
        },
        signal: options.signal,
      },
      'Bing',
    )
    if (status >= 400) continue
    const results = parseBingRss(body, options.maxResults)
    if (results.length) return results
  }

  return []
}

/** Разбор RSS-выдачи Bing. */
function parseBingRss(xml: string, maxResults: number): SearchResult[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((m) => m[1])
    .map((item) => {
      const link = decodeEntities(tag(item, 'link')).trim()
      return {
        title: stripTags(tag(item, 'title')) || link,
        url: link,
        snippet: stripTags(tag(item, 'description')),
        publishedAt: parseDate(tag(item, 'pubDate')),
        source: 'bing',
      }
    })
    .filter((r) => /^https?:\/\//i.test(r.url))
    .slice(0, maxResults)
}

// ── Движок 2: DuckDuckGo ─────────────────────────────────────────────

const DDG_HTML_ENDPOINTS = [
  'https://html.duckduckgo.com/html/',
  'https://lite.duckduckgo.com/lite/',
]

/** Достаёт реальный URL из редиректа DuckDuckGo (//duckduckgo.com/l/?uddg=...). */
function unwrapDuckDuckGoUrl(href: string): string {
  const raw = decodeEntities(href).trim()
  const uddg = raw.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1])
    } catch {
      return ''
    }
  }
  if (raw.startsWith('//')) return `https:${raw}`
  return raw
}

/** Разбор и html-, и lite-версии выдачи DuckDuckGo. */
function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const anchors = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*(?:result__a|result-link)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
  ].map((m) => ({
    href: m[0].match(/href="([^"]*)"/i)?.[1] ?? '',
    title: stripTags(m[1]),
  }))

  const snippets = [
    ...html.matchAll(
      /<(?:a|td)\b[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td)>/gi,
    ),
  ].map((m) => stripTags(m[1]))

  const results: SearchResult[] = []
  anchors.forEach((anchor, i) => {
    const url = unwrapDuckDuckGoUrl(anchor.href)
    if (!/^https?:\/\//i.test(url)) return
    // реклама и служебные редиректы самого DuckDuckGo
    if (/(^|\.)duckduckgo\.com\/(y\.js|l\/)/i.test(url)) return
    results.push({
      title: anchor.title || url,
      url,
      snippet: snippets[i] ?? '',
      source: 'duckduckgo',
    })
  })
  return results
}

interface IaTopic {
  Text?: string
  FirstURL?: string
  Topics?: IaTopic[]
}

/** Instant Answer API: отдаёт CORS и работает, когда HTML-выдача закрыта ботозащитой. */
async function searchDuckDuckGoInstant(
  query: string,
  options: SearchQueryOptions,
): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`
  const { status, body } = await request(
    url,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: options.signal },
    'DuckDuckGo Instant Answer',
  )
  if (status >= 400) return []

  const json = JSON.parse(body) as {
    Heading?: string
    AbstractText?: string
    AbstractURL?: string
    RelatedTopics?: IaTopic[]
    Results?: IaTopic[]
  }

  const out: SearchResult[] = []
  if (json.AbstractURL && json.AbstractText) {
    out.push({
      title: json.Heading?.trim() || json.AbstractURL,
      url: json.AbstractURL,
      snippet: json.AbstractText.trim(),
      source: 'duckduckgo',
    })
  }

  const flat: IaTopic[] = []
  const walk = (topics?: IaTopic[]): void => {
    for (const t of topics ?? []) {
      if (t.Topics?.length) walk(t.Topics)
      else if (t.FirstURL) flat.push(t)
    }
  }
  walk(json.RelatedTopics)
  for (const r of json.Results ?? []) if (r.FirstURL) flat.push(r)

  for (const t of flat) {
    if (!t.FirstURL) continue
    out.push({
      title: (t.Text ?? '').split(' - ')[0]?.trim() || t.FirstURL,
      url: t.FirstURL,
      snippet: (t.Text ?? '').trim(),
      source: 'duckduckgo',
    })
  }
  return out.slice(0, options.maxResults)
}

async function searchDuckDuckGo(
  query: string,
  options: SearchQueryOptions,
): Promise<SearchResult[]> {
  const problems: string[] = []

  for (const endpoint of DDG_HTML_ENDPOINTS) {
    const host = new URL(endpoint).host
    try {
      const { status, body } = await request(
        endpoint,
        {
          method: 'POST',
          headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': ACCEPT_LANG,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ q: query, kl: 'ru-ru' }).toString(),
          signal: options.signal,
        },
        'DuckDuckGo',
      )
      // HTTP 202 + anomaly.js = заглушка ботозащиты вместо выдачи
      if (status === 202 || /anomaly/i.test(body)) {
        problems.push(`${host} → ботозащита (HTTP ${status})`)
        continue
      }
      if (status >= 400) {
        problems.push(`${host} → HTTP ${status}`)
        continue
      }
      const results = parseDuckDuckGoHtml(body).slice(0, options.maxResults)
      if (results.length) return results
      problems.push(`${host} → пустая выдача`)
    } catch (err) {
      problems.push(`${host} → ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const instant = await searchDuckDuckGoInstant(query, options).catch(() => [])
  if (instant.length) return instant

  throw new Error(`DuckDuckGo не отдал выдачу (${problems.join('; ')}).`)
}

// ── Движок 3: Wikipedia (ru) ─────────────────────────────────────────

async function searchWikipedia(
  query: string,
  options: SearchQueryOptions,
): Promise<SearchResult[]> {
  const limit = Math.min(Math.max(options.maxResults, 1), 10)
  const url =
    `https://ru.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*` +
    `&srlimit=${limit}&srprop=snippet%7Ctimestamp&srsearch=${encodeURIComponent(query)}`

  const { status, body } = await request(
    url,
    { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: options.signal },
    'Wikipedia',
  )
  if (status >= 400) throw new Error(`Wikipedia вернула HTTP ${status}.`)

  const json = JSON.parse(body) as {
    query?: {
      search?: Array<{ title?: string; pageid?: number; snippet?: string; timestamp?: string }>
    }
  }

  return (json.query?.search ?? [])
    .map((hit) => {
      const title = (hit.title ?? '').trim()
      return {
        title,
        url: hit.pageid
          ? `https://ru.wikipedia.org/?curid=${hit.pageid}`
          : `https://ru.wikipedia.org/wiki/${encodeURIComponent(title)}`,
        snippet: stripTags(hit.snippet ?? ''),
        publishedAt: parseDate(hit.timestamp ?? ''),
        source: 'wikipedia',
      }
    })
    .filter((r) => r.title && r.url)
    .slice(0, limit)
}

// ── Provider ─────────────────────────────────────────────────────────

const ENGINES: Record<
  Exclude<KeylessEngine, 'auto'>,
  (query: string, options: SearchQueryOptions) => Promise<SearchResult[]>
> = {
  bing: searchBing,
  duckduckgo: searchDuckDuckGo,
  wikipedia: searchWikipedia,
}

/**
 * Бесплатный поиск без API-ключей.
 * Ничего не требует от пользователя: ни ключа, ни self-hosted инстанса.
 */
export function createKeylessProvider(config: { engine?: KeylessEngine } = {}): WebSearchProvider {
  const engine: KeylessEngine = config.engine ?? 'auto'

  return {
    id: 'keyless',
    label: 'Бесплатный поиск (Bing · DuckDuckGo · Wikipedia)',
    requiresKey: false,
    // Bing/DuckDuckGo не отдают CORS — движки обязаны работать на backend
    serverSide: true,

    async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
      const order = engine === 'auto' ? KEYLESS_AUTO_ORDER : [engine]
      const failures: string[] = []
      const collected: SearchResult[] = []
      const seen = new Set<string>()
      // достаточно ли результатов, чтобы не спрашивать остальные движки
      const enough = Math.max(1, Math.floor(options.maxResults / 2))

      for (const id of order) {
        try {
          const results = await ENGINES[id](query, options)
          for (const r of results) {
            if (seen.has(r.url)) continue
            seen.add(r.url)
            collected.push(r)
          }
          if (collected.length >= enough) break
        } catch (err) {
          const reason = (err instanceof Error ? err.message : String(err)).replace(/\.+$/, '')
          failures.push(`${KEYLESS_ENGINE_LABELS[id]}: ${reason}`)
        }
      }

      if (collected.length) return collected.slice(0, options.maxResults)

      // Явно выбранный движок не смог — сообщаем причину, а не «ничего не найдено»
      if (engine !== 'auto' && failures.length) {
        throw new Error(
          `${failures.join('; ')}. Попробуйте движок «Авто» или другой движок в Settings → Web Search.`,
        )
      }
      // «Авто»: все движки упали — это ошибка, а не пустой результат
      if (failures.length === order.length) {
        throw new Error(`Бесплатный поиск недоступен. ${failures.join('; ')}`)
      }
      return []
    },
  }
}

