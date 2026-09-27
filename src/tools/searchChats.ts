import { useConversations } from '@/lib/conversations'
import type { ChatMessage } from '@/types'
import type { Tool, ToolResult } from './types'

/**
 * Поиск по прошлым чатам этого приложения.
 * Память хранит факты, а этот инструмент даёт доступ к сырой истории:
 * «мы обсуждали это раньше», «что я говорил про бюджет проекта».
 * Работает полностью локально (IndexedDB → стор разговоров), ничего не отправляет.
 */

const MAX_CHATS = 5
const MAX_SNIPPETS_PER_CHAT = 2
const SNIPPET_LENGTH = 280
const STOP = new Set(['что', 'как', 'где', 'когда', 'это', 'мне', 'the', 'and', 'for', 'про', 'или'])

/** Токены запроса: слова от 3 символов; пусто → берём запрос целиком. */
function queryTokens(query: string): string[] {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP.has(t))
  return tokens.length ? tokens : [query.trim().toLowerCase()].filter(Boolean)
}

/** Вырезает окно вокруг первого совпадения, чтобы модель видела контекст. */
function snippet(content: string, tokens: string[]): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const token of tokens) {
    const found = lower.indexOf(token)
    if (found !== -1 && (at === -1 || found < at)) at = found
  }
  if (at <= SNIPPET_LENGTH / 2) return flat.slice(0, SNIPPET_LENGTH)
  const start = Math.max(0, at - Math.floor(SNIPPET_LENGTH / 3))
  return `…${flat.slice(start, start + SNIPPET_LENGTH)}`
}

export const searchChatsTool: Tool = {
  name: 'search_chats',
  description:
    'Ищет по предыдущим чатам пользователя в этом приложении (заголовки и тексты сообщений) и возвращает подходящие фрагменты с датами. Используй, когда пользователь ссылается на прошлые разговоры: «мы обсуждали», «я уже спрашивал», «вернись к тому чату». Работает локально.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Ключевые слова для поиска по истории чатов.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },

  async execute(args): Promise<ToolResult> {
    const query = String(args.query ?? '').trim()
    if (!query) throw new Error('Параметр query обязателен.')

    const conversations = useConversations.getState().conversations
    if (!conversations.length) {
      return { content: 'История чатов пуста: искать нечего.', summary: 'История пуста' }
    }

    const tokens = queryTokens(query)
    const scored = conversations
      .map((conversation) => {
        const titleHit = tokens.some((t) => conversation.title.toLowerCase().includes(t))
        const matches: Array<{ message: ChatMessage; score: number }> = []
        for (const message of conversation.messages) {
          const text = message.content.toLowerCase()
          let score = 0
          for (const token of tokens) if (text.includes(token)) score += 1
          if (score > 0) matches.push({ message, score: score + (message.role === 'user' ? 0.5 : 0) })
        }
        matches.sort((a, b) => b.score - a.score)
        const score = (titleHit ? 3 : 0) + matches.reduce((sum, m) => sum + m.score, 0)
        return { conversation, score, matches }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CHATS)

    if (!scored.length) {
      return {
        content: `По запросу «${query}» в истории чатов ничего не найдено. Всего чатов: ${conversations.length}.`,
        summary: 'Ничего не найдено',
      }
    }

    const blocks: string[] = []
    for (const item of scored) {
      const date = new Date(item.conversation.updatedAt).toLocaleDateString('ru-RU')
      const head = `Чат «${item.conversation.title}» (обновлён ${date}, сообщений: ${item.conversation.messages.length})`
      const lines = item.matches.slice(0, MAX_SNIPPETS_PER_CHAT).map(({ message }) => {
        const who = message.role === 'user' ? 'пользователь' : 'ассистент'
        return `  · ${who}: ${snippet(message.content, tokens)}`
      })
      blocks.push([head, ...lines].join('\n'))
    }

    return {
      content: [
        `Найдено чатов: ${scored.length} (из ${conversations.length}). Фрагменты:`,
        '',
        ...blocks,
        '',
        'Цитируй только эти фрагменты и не выдумывай содержимое чатов.',
      ].join('\n'),
      summary: `Нашёл в ${scored.length} чат(ах)`,
    }
  },
}
