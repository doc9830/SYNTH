import { toolLabel } from '@/tools/registry'
import type { ChatMessage } from '@/types'

/**
 * Что модель делает прямо сейчас — подпись для живой строки в чате.
 *
 * Порядок определения такой же, как в популярных клиентах
 * (ChatGPT, Claude, Gemini, DeepSeek): сначала активный инструмент,
 * потом размышления, затем набор ответа — с отдельным статусом для кода.
 */

export interface StreamPhase {
  /** Короткая подпись: «Думаю…», «Пишу код…», «Ищу в интернете…» */
  label: string
  /** Иконка инструмента (эмодзи), если фаза связана с tool-вызовом */
  icon?: string
}

/** Нечётное число ``` — модель прямо сейчас печатает блок кода. */
export function isWritingCode(content: string): boolean {
  const fences = content.match(/```/g)
  return Boolean(fences && fences.length % 2 === 1)
}

export function describeStreamPhase(message: ChatMessage): StreamPhase {
  const running = (message.toolCalls ?? []).find((t) => t.status === 'running')
  if (running) {
    const label = toolLabel(running.name)
    return { label: label.running, icon: label.icon }
  }

  const reasoning = (message.reasoning ?? '').trim()
  const content = message.content ?? ''
  if (!content.trim()) {
    // Текста ещё нет: либо идут мысли, либо модель готовит первый токен
    return { label: reasoning ? 'Думаю…' : 'Готовлю ответ…' }
  }
  if (isWritingCode(content)) return { label: 'Пишу код…' }
  return { label: 'Отвечаю…' }
}
