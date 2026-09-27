import { formatTime, truncate } from '@/lib/utils'
import type { SearchResult } from '@/types'
import type { Tool, ToolContext, ToolResult } from './types'

/**
 * web_search — реальный веб-поиск через provider abstraction.
 * Модель вызывает его сама, когда нужны свежие данные.
 */

function resultDate(result: SearchResult): string {
  if (!result.publishedAt) return ''
  const ts = Date.parse(result.publishedAt)
  if (Number.isNaN(ts)) return `Дата: ${result.publishedAt}`
  return `Дата: ${new Date(ts).toLocaleDateString('ru-RU')}`
}

/** Форматирует результаты поиска для модели (без сырых JSON-простыней). */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (!results.length) {
    return `По запросу «${query}» ничего не найдено. Попробуйте изменить формулировку запроса.`
  }
  const blocks = results.map((r, i) => {
    const date = resultDate(r)
    return [
      `[${i + 1}] ${r.title}`,
      `URL: ${r.url}`,
      date,
      r.snippet ? `Содержание: ${truncate(r.snippet, 900)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return [
    `Результаты веб-поиска по запросу «${query}» (получено ${formatTime(Date.now())}):`,
    '',
    blocks.join('\n\n'),
    '',
    'При ответе опирайся на эти данные и указывай ссылки-источники.',
  ].join('\n')
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Поиск актуальной информации в интернете. Используй, когда нужны свежие данные, новости, цены, события после даты обучения модели, или когда пользователь прямо просит поискать. Не используй для общих вопросов, ответ на которые ты знаешь.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Поисковый запрос. Формулируй его как в поисковой строке: ключевые слова без лишних слов.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('Пустой поисковый запрос: параметр query обязателен.')

    // импорт внутри функции — чтобы не тянуть провайдеры в основной бандл
    const { searchWeb } = await import('@/api')
    const results = await searchWeb(query, ctx.settings, ctx.signal)

    return {
      content: formatSearchResults(query, results),
      summary: results.length
        ? `Найдено источников: ${results.length}`
        : 'Ничего не найдено',
      sources: results,
    }
  },
}
