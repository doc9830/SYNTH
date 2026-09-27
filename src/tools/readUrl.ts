import { truncate } from '@/lib/utils'
import type { PageReadResult } from '@/types'
import type { Tool, ToolContext, ToolResult } from './types'

/**
 * read_url — открыть конкретную ссылку и разобрать, что на странице.
 *
 * В отличие от web_search (поиск по ключевым словам) этот инструмент работает
 * с той ссылкой, которую дал пользователь: рендерит страницу в headless Chrome
 * на backend, отдаёт модели текст/структуру, а пользователю — скриншот.
 */

const MAX_LINKS_FOR_MODEL = 15
const MAX_IMAGES_FOR_MODEL = 10

/** Текст результата для модели: структура страницы вместо сырого HTML. */
export function formatPageForModel(page: PageReadResult): string {
  const lines: string[] = []
  lines.push(`Страница: ${page.finalUrl}`)
  if (page.finalUrl !== page.url) lines.push(`Было запрошено: ${page.url}`)
  if (page.title) lines.push(`Заголовок: ${page.title}`)
  if (page.description) lines.push(`Описание: ${page.description}`)
  lines.push(
    `Язык: ${page.lang || 'не указан'} · способ чтения: ${
      page.engine === 'chrome' ? 'рендер в браузере (JS выполнен)' : 'статический HTML (без JS)'
    }`,
  )
  lines.push(
    page.screenshot
      ? `Скриншот: сделан (${page.screenshot.width}×${page.screenshot.height}) и уже показан пользователю в чате.`
      : 'Скриншот: не делался.',
  )
  if (page.design) {
    lines.push(
      `Дизайн: фон ${page.design.background}, цвет текста ${page.design.color}, шрифт ${page.design.font}`,
    )
    if (page.design.colors.length) {
      lines.push(`Палитра (частота): ${page.design.colors.join(', ')}`)
    }
  }
  if (page.ogImage) lines.push(`Главная картинка (og:image): ${page.ogImage}`)

  if (page.headings.length) {
    lines.push('', 'Заголовки страницы:')
    for (const h of page.headings.slice(0, 25)) lines.push(`- ${h}`)
  }

  lines.push('', `Текст страницы${page.truncated ? ' (обрезан по лимиту)' : ''}:`, page.text || '(текста нет)')

  const links = page.links.slice(0, MAX_LINKS_FOR_MODEL)
  if (links.length) {
    lines.push('', `Ссылки со страницы (${links.length} из ${page.links.length}):`)
    for (const link of links) lines.push(`- ${link.title} — ${link.url}`)
  }

  const images = page.images.slice(0, MAX_IMAGES_FOR_MODEL)
  if (images.length) {
    lines.push('', `Изображения на странице (${images.length}):`)
    for (const image of images) {
      const size = image.width && image.height ? ` (${image.width}×${image.height})` : ''
      lines.push(`- ${image.src}${size}${image.alt ? ` — alt: ${truncate(image.alt, 80)}` : ''}`)
    }
  }

  if (page.warnings.length) {
    lines.push('', 'Замечания при чтении:')
    for (const warning of page.warnings) lines.push(`- ${warning}`)
  }

  lines.push(
    '',
    'Как отвечать: перескажи то, что реально есть на странице (по тексту выше), опирайся на скриншот — он уже показан пользователю. Ссылки давай по URL из списка. Не вставляй base64 и не выдумывай данные, которых нет в тексте.',
  )
  return lines.join('\n')
}


function buildSummary(page: PageReadResult): string {
  const parts = [truncate(page.title || page.finalUrl.replace(/^https?:\/\//, ''), 60)]
  parts.push(`${page.text.length} симв.`)
  if (page.screenshot) parts.push(`скриншот ${page.screenshot.width}×${page.screenshot.height}`)
  if (page.engine === 'static') parts.push('без рендера JS')
  return parts.join(' · ')
}

/** В UI показываем ссылки на другие домены вперёд: обычно это самое интересное. */
function linksForUi(page: PageReadResult, limit = 8) {
  let host = ''
  try {
    host = new URL(page.finalUrl).hostname.replace(/^www\./, '')
  } catch {
    /* ignore */
  }
  const isExternal = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '') !== host
    } catch {
      return false
    }
  }
  const external = page.links.filter((l) => isExternal(l.url))
  const internal = page.links.filter((l) => !isExternal(l.url))
  return [...external, ...internal].slice(0, limit)
}

export const readUrlTool: Tool = {
  name: 'read_url',
  description:
    'Открывает конкретную страницу по ссылке и разбирает её содержимое: текст, заголовки, ссылки, картинки, дизайн и скриншот. Обязательно используй, когда пользователь прислал ссылку (лендинг, сайт, статью, товар) и просит «посмотри», «что там», «разбери», «сделай скриншоты», «возьми информацию»; также когда после web_search нужно прочитать найденный источник целиком. Для поиска в интернете используй web_search, для одной известной ссылки — read_url.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Ссылка на страницу. Можно без схемы (example.com) — https добавится автоматически.',
      },
      screenshot: {
        type: 'boolean',
        description:
          'Сделать скриншот страницы и показать его пользователю. По умолчанию true — так пользователь видит, как выглядит страница. Ставь false только если нужен исключительно текст.',
      },
      fullPage: {
        type: 'boolean',
        description: 'Скриншот всей страницы целиком, а не только первого экрана. Для длинных лендингов — true.',
      },
      maxChars: {
        type: 'number',
        description: 'Сколько символов текста страницы вернуть (по умолчанию 8000, максимум 40000).',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args.url ?? '').trim()
    if (!url) throw new Error('Пустой url: параметр url обязателен.')

    if (!ctx.settings.search.readPages) {
      throw new Error(
        'Чтение страниц отключено в настройках: Настройки → Поиск → «Читать присланные ссылки».',
      )
    }

    // импорт внутри функции — чтобы не тянуть api/транспорт в основной бандл
    const { readPage } = await import('@/api')
    const page = await readPage(url, ctx.settings, {
      screenshot: args.screenshot !== false,
      fullPage: args.fullPage === true,
      maxChars: typeof args.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : undefined,
      signal: ctx.signal,
    })

    return {
      content: formatPageForModel(page),
      summary: buildSummary(page),
      sources: linksForUi(page),
      images: page.screenshot ? [page.screenshot.dataUrl] : undefined,
    }
  },
}
