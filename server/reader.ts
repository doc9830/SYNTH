import { findChrome, withChromePage } from './chrome'
import { capText, normalizeUrl, readStaticPage, type PageImage, type PageLink } from '../src/lib/pageStatic'

// Статический разбор HTML живёт в src/lib/pageStatic.ts: этот же код
// использует приложение на телефоне, где headless-браузера нет.
export {
  PageInputError,
  extractStatic,
  htmlToText,
  normalizeUrl,
  type PageImage,
  type PageLink,
} from '../src/lib/pageStatic'

/**
 * Чтение страницы по ссылке.
 *
 * Два режима:
 *  - chrome — открываем URL в headless-браузере: получаем ОТРЕНДЕРЕННЫЙ текст
 *    (важно для SPA/лендингов на JS), ссылки, картинки, дизайн-токены и скриншот;
 *  - static — обычный HTTP-запрос + разбор HTML (если браузера нет).
 */

export interface PageDesign {
  /** background-color у body */
  background: string
  /** color у body */
  color: string
  /** font-family у body */
  font: string
  /** самые частые цвета на странице: "rgb(…) x12" */
  colors: string[]
}

export interface PageScreenshot {
  /** data URL: data:image/jpeg;base64,… */
  dataUrl: string
  format: 'jpeg' | 'png'
  width: number
  height: number
  bytes: number
}

export interface PageData {
  url: string
  finalUrl: string
  status: number | null
  kind: 'html' | 'text' | 'json' | 'pdf' | 'image' | 'other'
  /** Кто читал страницу: отрендерил Chrome или разобрали HTML статически */
  engine: 'chrome' | 'static'
  title: string
  description: string
  /** og:image — обычно главная картинка/баннер страницы */
  ogImage?: string
  lang: string
  headings: string[]
  text: string
  truncated: boolean
  links: PageLink[]
  images: PageImage[]
  design?: PageDesign
  screenshot?: PageScreenshot
  warnings: string[]
}

export interface ReadPageInput {
  url: string
  /** Снять скриншот и вернуть его data URL (по умолчанию — да) */
  screenshot?: boolean
  /** Скриншот всей страницы, а не только первого экрана */
  fullPage?: boolean
  /** Сколько символов текста вернуть (по умолчанию 8000) */
  maxChars?: number
  /** Пауза после load, мс */
  waitMs?: number
  /** Общий таймаут, мс */
  timeoutMs?: number
  width?: number
  signal?: AbortSignal
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.round(value), min), max)
}

/**
 * JS, который выполняется внутри страницы: забираем уже ОТРЕНДЕРЕННЫЕ данные.
 * Строка, а не шаблон с интерполяцией — так безопаснее и читаемее.
 */
const EXTRACT_SCRIPT = `(() => {
  var abs = function (u) { try { return new URL(u, location.href).href } catch (e) { return '' } }
  var clean = function (s) { return (s || '').replace(/\\s+/g, ' ').trim() }
  var meta = function (sel) { var el = document.querySelector(sel); return el ? clean(el.getAttribute('content')) : '' }
  var headings = []
  var hs = document.querySelectorAll('h1,h2,h3')
  for (var i = 0; i < hs.length && headings.length < 40; i++) {
    var t = clean(hs[i].innerText)
    if (t.length > 2) headings.push(hs[i].tagName.toLowerCase() + ': ' + t.slice(0, 200))
  }
  var links = []
  var seen = {}
  var anchors = document.querySelectorAll('a[href]')
  for (var j = 0; j < anchors.length && links.length < 60; j++) {
    var url = abs(anchors[j].getAttribute('href'))
    var text = clean(anchors[j].innerText).slice(0, 120)
    if (!url || url.indexOf('http') !== 0 || !text || seen[url]) continue
    seen[url] = true
    links.push({ title: text, url: url })
  }
  var images = []
  var seenImg = {}
  var imgs = document.querySelectorAll('img')
  for (var k = 0; k < imgs.length && images.length < 40; k++) {
    var src = abs(imgs[k].currentSrc || imgs[k].src)
    var w = imgs[k].naturalWidth
    var h = imgs[k].naturalHeight
    if (!src || src.indexOf('http') !== 0 || seenImg[src] || w < 40 || h < 40) continue
    seenImg[src] = true
    images.push({ src: src, alt: clean(imgs[k].alt).slice(0, 140), width: w, height: h })
  }
  var counts = {}
  var els = document.querySelectorAll('body *')
  var limit = Math.min(els.length, 1500)
  for (var n = 0; n < limit; n++) {
    var cs = getComputedStyle(els[n])
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    var vals = [cs.backgroundColor, cs.color]
    for (var v = 0; v < vals.length; v++) {
      var c = vals[v]
      if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') continue
      counts[c] = (counts[c] || 0) + 1
    }
  }
  var palette = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] }).slice(0, 8)
    .map(function (c) { return c + ' x' + counts[c] })
  var body = getComputedStyle(document.body || document.documentElement)
  var htmlBg = getComputedStyle(document.documentElement).backgroundColor
  var bgColor = body.backgroundColor
  if (!bgColor || bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') bgColor = htmlBg
  return {
    title: clean(document.title),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    ogImage: abs(meta('meta[property="og:image"]')),
    lang: document.documentElement.getAttribute('lang') || '',
    finalUrl: location.href,
    headings: headings,
    text: (document.body ? document.body.innerText : '') || '',
    links: links,
    images: images,
    design: { background: bgColor, color: body.color, font: body.fontFamily, colors: palette }
  }
})()`

interface Extracted {
  title: string
  description: string
  ogImage: string
  lang: string
  finalUrl: string
  headings: string[]
  text: string
  links: PageLink[]
  images: PageImage[]
  design: PageDesign
}

/** Рендер страницы в headless Chrome: отрендеренный текст + (опционально) скриншот. */
async function renderWithChrome(
  url: string,
  input: ReadPageInput,
  ctx: { maxChars: number; screenshot: boolean; warnings: string[] },
): Promise<PageData> {
  const timeoutMs = clamp(input.timeoutMs ?? 30000, 4000, 90000)
  const width = clamp(input.width ?? 1440, 320, 2560)
  const waitMs = clamp(input.waitMs ?? 700, 0, 10000)

  return withChromePage(
    { width, height: 900, timeoutMs, waitMs, signal: input.signal },
    async (page) => {
      await page.navigate(url, { waitMs, timeoutMs: Math.max(4000, timeoutMs - 6000) })
      const data = await page.evaluate<Extracted>(EXTRACT_SCRIPT)
      const { text, truncated } = capText(data.text ?? '', ctx.maxChars)

      let screenshot: PageScreenshot | undefined
      if (ctx.screenshot) {
        const shot = await page.screenshot({
          format: 'jpeg',
          quality: 78,
          fullPage: Boolean(input.fullPage),
        })
        if (shot.base64) {
          screenshot = {
            dataUrl: `data:image/${shot.format};base64,${shot.base64}`,
            format: shot.format,
            width: shot.width,
            height: shot.height,
            // base64 → байты (примерно)
            bytes: Math.round((shot.base64.length * 3) / 4),
          }
        }
      }

      const links = (data.links ?? []).map((l) => ({ title: String(l.title ?? ''), url: String(l.url ?? '') }))
      const images = (data.images ?? []).map((i) => ({
        src: String(i.src ?? ''),
        alt: i.alt ? String(i.alt) : undefined,
        width: typeof i.width === 'number' ? i.width : undefined,
        height: typeof i.height === 'number' ? i.height : undefined,
      }))
      if (!text.trim()) {
        ctx.warnings.push('Страница отрендерилась, но текста на ней почти нет (возможно, требуется вход или контент подгружается лениво).')
      }

      return {
        url,
        finalUrl: data.finalUrl || url,
        status: 200,
        kind: 'html' as const,
        engine: 'chrome' as const,
        title: data.title ?? '',
        description: data.description ?? '',
        ogImage: data.ogImage || undefined,
        lang: data.lang ?? '',
        headings: data.headings ?? [],
        text,
        truncated,
        links,
        images,
        design: data.design,
        screenshot,
        warnings: ctx.warnings,
      }
    },
  )
}

/** Обычный HTTP-запрос + разбор HTML: работает без браузера (см. src/lib/pageStatic.ts). */
async function readStatic(
  url: string,
  input: ReadPageInput,
  ctx: { maxChars: number; warnings: string[] },
): Promise<PageData> {
  const staticPage = await readStaticPage(url, {
    timeoutMs: clamp(input.timeoutMs ?? 20000, 3000, 60000),
    maxBytes: 3_000_000,
    maxChars: ctx.maxChars,
    signal: input.signal,
  })

  return {
    ...staticPage,
    engine: 'static',
    warnings: [...ctx.warnings, ...staticPage.warnings],
  }
}
/**
 * Прочитать страницу: сначала Chrome (рендер + скриншот), при неудаче — статический разбор.
 */
export async function readPage(input: ReadPageInput): Promise<PageData> {
  const url = normalizeUrl(input.url)
  const maxChars = clamp(input.maxChars ?? 8000, 500, 40000)
  const screenshot = input.screenshot !== false && Boolean(findChrome())
  const warnings: string[] = []

  if (findChrome()) {
    try {
      return await renderWithChrome(url, input, { maxChars, screenshot, warnings })
    } catch (err) {
      if (input.signal?.aborted) throw err
      warnings.push(`Рендер в Chrome не удался (${err instanceof Error ? err.message : String(err)}) — читаю статически.`)
    }
  } else {
    warnings.push(
      'Chrome/Chromium не найден — текст извлекается статически, скриншоты недоступны. Укажите CHROME_PATH в .env.',
    )
  }

  return readStatic(url, input, { maxChars, warnings })
}

