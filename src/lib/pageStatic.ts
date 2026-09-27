/**
 * Статическое чтение страницы — обычный HTTP-запрос и разбор HTML без браузера.
 *
 * Модуль общий для двух окружений:
 *  - backend (server/reader.ts) — запасной режим, когда Chrome недоступен;
 *  - приложение на телефоне (APK) — headless-браузера там нет вообще,
 *    поэтому текст и структура страницы читаются прямо в приложении.
 *
 * Использует только global fetch + TextDecoder, поэтому одинаково работает
 * и в Node, и в Android WebView.
 */

import { guardedFetch, NetGuardError, type LookupFn } from './netGuard'

export interface PageLink {
  title: string
  url: string
}

export interface PageImage {
  src: string
  alt?: string
  width?: number
  height?: number
}

/** Результат статического чтения страницы. */
export interface StaticPage {
  url: string
  finalUrl: string
  status: number | null
  kind: 'html' | 'text' | 'json' | 'pdf' | 'image' | 'other'
  title: string
  description: string
  ogImage?: string
  lang: string
  headings: string[]
  text: string
  truncated: boolean
  links: PageLink[]
  images: PageImage[]
  warnings: string[]
}

export interface StaticReadOptions {
  timeoutMs?: number
  maxBytes?: number
  maxChars?: number
  signal?: AbortSignal
  /**
   * Свой резолвер DNS для SSRF-проверки (на backend это node:dns);
   * `false` — не проверять DNS, оставив проверки IP и служебных имён.
   */
  lookup?: LookupFn | false
}

/** Ошибка во входных данных (URL) — вызывающий код показывает её как есть. */
export class PageInputError extends Error {}

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
}

/** Приводит пользовательский ввод к абсолютному http(s)-URL. */
export function normalizeUrl(raw: string): string {
  const value = (raw ?? '').trim()
  if (!value) throw new PageInputError('Пустой URL: параметр url обязателен.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new PageInputError(`Не похоже на ссылку: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PageInputError(`Поддерживаются только http/https-ссылки, получено ${url.protocol}`)
  }
  if (!url.hostname.includes('.')) {
    throw new PageInputError(`В ссылке нет домена: ${raw}`)
  }
  return url.href
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  euro: '€',
  rarr: '→',
  copy: '©',
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (full, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? full)
}

/** HTML → читаемый текст (без внешних зависимостей). */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n')
    .trim()
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).href
  } catch {
    return ''
  }
}

/** Обрезает текст по лимиту, аккуратно схлопывая пробелы. */
export function capText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (normalized.length <= maxChars) return { text: normalized, truncated: false }
  return { text: `${normalized.slice(0, maxChars)}\n…[текст обрезан]`, truncated: true }
}

/** Разбор обычного HTML без браузера: заголовки, мета, ссылки, картинки. */
export function extractStatic(
  html: string,
  base: string,
): {
  title: string
  description: string
  ogImage: string
  lang: string
  headings: string[]
  text: string
  links: PageLink[]
  images: PageImage[]
} {
  const title =
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  const meta = (name: string) =>
    decodeEntities(
      new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, 'i').exec(html)?.[1] ?? '',
    ).trim()
  const description = meta('description') || meta('og:description')
  const ogImage = absolute(meta('og:image'), base)
  const lang = /<html[^>]+lang=["']?([\w-]+)/i.exec(html)?.[1] ?? ''

  const headings = [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => htmlToText(m[2]).slice(0, 200))
    .filter((t) => t.length > 2)
    .slice(0, 40)

  const seen = new Set<string>()
  const links: PageLink[] = []
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(decodeEntities(m[1]), base)
    const text = decodeEntities(htmlToText(m[2])).slice(0, 120)
    if (!url.startsWith('http') || !text || seen.has(url)) continue
    seen.add(url)
    links.push({ title: text, url })
    if (links.length >= 60) break
  }

  const images: PageImage[] = []
  const seenImg = new Set<string>()
  for (const m of html.matchAll(/<img\s[^>]*>/gi)) {
    const tag = m[0]
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1]
    if (!src) continue
    const url = absolute(decodeEntities(src), base)
    if (!url.startsWith('http') || seenImg.has(url)) continue
    seenImg.add(url)
    images.push({ src: url, alt: decodeEntities(/alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? '').slice(0, 140) })
    if (images.length >= 40) break
  }

  return { title, description, ogImage, lang, headings, text: htmlToText(html), links, images }
}

/** Русские сайты до сих пор часто в windows-1251 — учитываем charset из заголовка и из meta. */
function decodeWithCharset(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1]
  const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1]
  const charset = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase()
  if (charset === 'utf-8' || charset === 'utf8') return new TextDecoder('utf-8').decode(bytes)
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Читает тело ответа с ограничением по размеру (чтобы не утащить гигабайт в память). */
async function readLimitedBody(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
  if (!res.body) return { bytes: new Uint8Array(0), size: 0 }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.byteLength
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, size: merged.byteLength }
}

/**
 * Скачивает страницу и разбирает её без браузера.
 * Бросает обычную Error — вызывающий код сам решает, как показать проблему.
 */
export async function readStaticPage(url: string, opts: StaticReadOptions = {}): Promise<StaticPage> {
  const timeoutMs = opts.timeoutMs ?? 20000
  const maxBytes = opts.maxBytes ?? 3_000_000
  const maxChars = opts.maxChars ?? 8000
  const warnings: string[] = []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

  let res: Response
  let body = ''
  let size = 0
  let finalUrl = url
  try {
    // guardedFetch: адрес и каждый редирект проверяются на SSRF (см. netGuard).
    const guarded = await guardedFetch(url, {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
      lookup: opts.lookup,
      warn: (message) => warnings.push(message),
    })
    res = guarded.response
    finalUrl = guarded.finalUrl || res.url || url
    if (guarded.visited.length > 1) {
      warnings.push(`Были перенаправления: ${guarded.visited.join(' → ')}`)
    }
    const raw = await readLimitedBody(res, maxBytes)
    body = decodeWithCharset(raw.bytes, res.headers.get('content-type') ?? '')
    size = raw.size
  } catch (err) {
    if (opts.signal?.aborted) throw new Error('Чтение страницы остановлено.')
    if (controller.signal.aborted) throw new Error(`Страница не ответила за ${timeoutMs} мс`)
    // Заблокированный адрес показываем как есть: это понятная причина, а не сбой сети.
    if (err instanceof NetGuardError) throw err
    throw new Error(`Не удалось открыть ${url}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }

  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  const base: StaticPage = {
    url,
    finalUrl,
    status: res.status,
    kind: 'html',
    title: '',
    description: '',
    lang: '',
    headings: [],
    text: '',
    truncated: false,
    links: [],
    images: [],
    warnings,
  }

  if (res.status >= 400) {
    warnings.push(`Сервер ответил HTTP ${res.status} — часть контента может отсутствовать.`)
  }

  if (/^image\//.test(type)) {
    return { ...base, kind: 'image', text: `[Изображение ${type}, ${size} байт] — текст не извлекается.` }
  }
  if (/pdf/.test(type)) {
    return {
      ...base,
      kind: 'pdf',
      text: '[PDF. Текстовый слой не извлекается: нужен рендер в браузере (Chrome на backend).]',
    }
  }
  if (/json|javascript|xml|plain/.test(type)) {
    const { text, truncated } = capText(body, maxChars)
    return { ...base, kind: /json/.test(type) ? 'json' : 'text', text, truncated }
  }

  const parsed = extractStatic(body, finalUrl)
  const { text, truncated } = capText(parsed.text, maxChars)
  if (!text.trim()) {
    warnings.push('В HTML нет текста: похоже на SPA — нужен рендер в браузере (Chrome на backend).')
  }
  return {
    ...base,
    kind: 'html',
    title: parsed.title,
    description: parsed.description,
    ogImage: parsed.ogImage || undefined,
    lang: parsed.lang,
    headings: parsed.headings,
    text,
    truncated,
    links: parsed.links,
    images: parsed.images,
  }
}


