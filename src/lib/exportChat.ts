import type { ChatMessage, Conversation } from '@/types'

function toolLine(m: ChatMessage): string {
  const calls = m.toolCalls ?? []
  if (!calls.length) return ''
  return calls.map((c) => `- ${c.name}: ${c.summary ?? c.status}`).join('\n')
}

/** Чат → Markdown (для экспорта и «копировать целиком»). */
export function conversationToMarkdown(conversation: Conversation): string {
  const lines: string[] = [
    `# ${conversation.title}`,
    '',
    `Модель: ${conversation.model || '—'}`,
    `Создан: ${new Date(conversation.createdAt).toLocaleString('ru-RU')}`,
    '',
  ]

  for (const m of conversation.messages) {
    const who = m.role === 'user' ? '## Пользователь' : '## Ассистент'
    lines.push(who, '')
    if (m.content.trim()) lines.push(m.content.trim(), '')
    const tools = toolLine(m)
    if (tools) lines.push('> Вызовы инструментов:', tools, '')
    if (m.error) lines.push(`> Ошибка: ${m.error}`, '')
  }

  return lines.join('\n')
}

/** Скачивание текстового файла без обращений к серверу. */
export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Безопасное имя файла из заголовка чата. */
export function safeFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${base || 'chat'}.md`
}
