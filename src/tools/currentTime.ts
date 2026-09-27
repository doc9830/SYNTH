import type { Tool, ToolResult } from './types'

/**
 * Текущие дата и время.
 * Модель не знает сегодняшнюю дату, поэтому без этого инструмента она
 * «уверенно» ошибается в днях недели, сроках и возрасте. Запрос локальный:
 * никуда не ходит, работает даже без интернета.
 */

function formatIn(date: Date, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'full',
    timeStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }
  return new Intl.DateTimeFormat('ru-RU', options).format(date)
}

export const currentTimeTool: Tool = {
  name: 'current_time',
  description:
    'Возвращает текущие дату и время (локальные у пользователя и, если указана, в конкретном часовом поясе). Используй для вопросов «какое сегодня число», «сколько дней осталось», «который час», при работе с расписаниями и сроками. Считает время детерминированно, а не по догадке.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'Часовой пояс в формате IANA, например Europe/Moscow или Asia/Tokyo. Необязателен: без него берётся локальное время пользователя.',
      },
    },
    required: [],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : ''
    const now = new Date()
    const userZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'локальный'

    let requested = ''
    if (timezone) {
      try {
        requested = formatIn(now, timezone)
      } catch {
        throw new Error(
          `Неизвестный часовой пояс «${timezone}». Нужен формат IANA, например Europe/Moscow.`,
        )
      }
    }

    const lines = [
      `Сейчас: ${formatIn(now)} (${userZone}).`,
      `ISO 8601: ${now.toISOString()}`,
      `Unix-время, мс: ${now.getTime()}`,
    ]
    if (requested) lines.push(`В поясе ${timezone}: ${requested}.`)

    return {
      content: lines.join('\n'),
      summary: `Текущее время: ${formatIn(now)}`,
    }
  },
}
