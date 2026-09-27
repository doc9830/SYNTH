/**
 * Сводка выпавших сообщений (rolling summary, задача 04.2).
 *
 * `trimHistory` выбрасывает старые сообщения по окну безвозвратно — модель
 * забывала, о чём был разговор, и начинала отвечать «не помню такого».
 * Здесь выброшенный кусок сжимается отдельным дешёвым запросом (`chatOnce`)
 * и подставляется в контекст отдельным системным блоком.
 *
 * Как это устроено:
 *  - сводка живёт в самом чате (`Conversation.summary`) вместе с id последнего
 *    сжатого сообщения (`upToMessageId`) — по нему видно, актуальна ли она;
 *  - обновляем ТОЛЬКО то, чего в сводке ещё нет: сообщения после `upToMessageId`;
 *  - обновление идёт ДО отправки запроса, поэтому модель помнит разговор уже в
 *    том же ходу, где сообщения выпали;
 *  - любая ошибка суммаризации не ломает чат: остаётся прежняя сводка, причина
 *    уходит в лог, а история, как и раньше, просто обрезается.
 *
 * Сводка — обычный текст, а не структура: модели проще читать изложение, а нам
 * не нужен парсер, который сломается на нестандартном ответе провайдера.
 */
import { chatOnce, type WireMessages } from '@/api'
import type { ChatMessage, ConversationSummary } from '@/types'
import type { HistoryPlan } from './context'
import { debugLog } from './debug'
import type { Settings } from './settings'
import { resultTextOf } from './toolHistory'

/** Сколько символов занимает сводка (и сколько её просим у модели) */
export const SUMMARY_MAX_CHARS = 1400

/** Лимит символов на одно сообщение при пересказе диалога */
export const SUMMARY_MESSAGE_CHARS = 1200

/** Лимит символов на один запрос суммаризации */
export const SUMMARY_INPUT_CHARS = 16000

/** Сколько запросов суммаризации делаем за один ход (остальное — в следующие) */
export const SUMMARY_MAX_CHUNKS = 4

/** Сколько токенов разрешаем модели на ответ со сводкой */
const SUMMARY_MAX_TOKENS = 900

const SUMMARY_SYSTEM = [
  'Ты сжимаешь прежнюю часть разговора в короткую сводку, чтобы собеседник помнил её без полного текста.',
  'Сохраняй без изменений: имена и названия, числа, цены, даты, адреса, ссылки, названия файлов, принятые решения и обещания (кто что обещал сделать).',
  'Отдельно отметь текущую задачу и то, на чём остановились, если разговор не закончен.',
  'Пиши по-русски, от третьего лица, короткими пунктами. Не добавляй того, чего в разговоре не было, и не давай оценок.',
  `Максимум ${SUMMARY_MAX_CHARS} символов. Ответь только текстом сводки, без пояснений и без markdown-обёртки.`,
].join(' ')

/** Пояснение к системному блоку сводки — уходит модели вместе с ней. */
export const SUMMARY_HINT =
  'Опирайся на сводку как на факты из этого же чата: это прежняя часть разговора, которая не поместилась в окно. Если для ответа нужна деталь, которой в сводке нет, — скажи, что подробность не поместилась, и не выдумывай.'

/** Запрос на обновление сводки: прежняя сводка + новые сообщения. */
export function summaryRequestMessages(previous: string, dialog: string): WireMessages {
  const parts = [
    previous.trim() ? `Уже есть сводка прежних сообщений:\n${previous.trim()}` : '',
    `Сообщения, которые нужно добавить в сводку:\n\n${dialog}`,
    'Верни обновлённую сводку целиком (прежнее + новое), без пояснений.',
  ].filter(Boolean)
  return [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/** Приводит ответ модели к тексту сводки: без обёрток, лишних пустых строк и префиксов. */
export function parseSummary(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^```[a-zа-я]*\s*/i, '').replace(/```\s*$/, '').trim()
  text = text.replace(/^(сводка|итог|краткое изложение|summary)\s*:?\s*/i, '')
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > SUMMARY_MAX_CHARS) text = `${text.slice(0, SUMMARY_MAX_CHARS)}…`
  return text
}

/* ───────────────────────────── Пересказ диалога ───────────────────────────── */

/** Сжимает пробелы и режет длинный текст — для пересказа подробности не нужны. */
function compress(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** Одно сообщение в виде строки для пересказа (с вызовами инструментов). */
export function renderMessage(message: ChatMessage, limit = SUMMARY_MESSAGE_CHARS): string {
  if (message.role === 'user') {
    const files = message.attachments?.length ? ` [вложений: ${message.attachments.length}]` : ''
    return `Пользователь: ${compress(message.content, limit)}${files}`
  }

  const lines: string[] = []
  if (message.content.trim()) lines.push(`Ассистент: ${compress(message.content, limit)}`)
  for (const call of message.toolCalls ?? []) {
    const args = compress(call.args ?? '', 240)
    const result = compress(resultTextOf(call), Math.floor(limit / 4))
    lines.push(`Ассистент вызвал ${call.name}(${args}) → ${result}`)
  }
  return lines.join('\n') || 'Ассистент: (пустой ответ)'
}

/** Оценка «веса» сообщения в символах — по ней нарезаем запросы суммаризации. */
export function messageChars(message: ChatMessage): number {
  let size = message.content.length
  for (const call of message.toolCalls ?? []) {
    size += (call.args?.length ?? 0) + resultTextOf(call).length
  }
  return size
}

/**
 * Нарезка сообщений на запросы суммаризации.
 * Одно сообщение в чанк попадает целиком, даже если оно больше лимита:
 * резать сообщение пополам и терять его конец нельзя.
 */
export function chunkMessages(
  messages: ChatMessage[],
  total = SUMMARY_INPUT_CHARS,
): ChatMessage[][] {
  const chunks: ChatMessage[][] = []
  let current: ChatMessage[] = []
  let used = 0
  for (const message of messages) {
    const size = messageChars(message)
    if (current.length && used + size > total) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(message)
    used += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Пересказ диалога для запроса суммаризации.
 * Идём с конца: свежие сообщения важнее, при нехватке лимита старые пропускаем
 * и честно сообщаем об этом модели (`skipped`).
 */
export function renderDialog(
  messages: ChatMessage[],
  total = SUMMARY_INPUT_CHARS,
): { text: string; skipped: number } {
  const parts: string[] = []
  let used = 0
  let skipped = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const part = renderMessage(messages[i])
    if (used + part.length > total) {
      skipped = i + 1
      break
    }
    used += part.length
    parts.unshift(part)
  }
  const text = parts.join('\n\n')
  return {
    text: skipped > 0 ? `(более ранние сообщения пропущены: ${skipped})\n\n${text}` : text,
    skipped,
  }
}

/* ─────────────────────── Сводка в контексте и её обновление ─────────────────────── */

/**
 * Системный блок сводки для запроса.
 *
 * Пустая строка означает «сводка не нужна»: либо её нет, либо сжатые сообщения
 * всё ещё в окне — тогда это просто дублирование и лишние токены.
 */
export function summaryBlockFor(
  summary: ConversationSummary | undefined,
  kept: ChatMessage[],
): string {
  const text = summary?.text.trim()
  if (!text) return ''
  if (summary && kept.some((message) => message.id === summary.upToMessageId)) return ''
  const covered = summary?.covered ?? 0
  return [
    covered > 0
      ? `Сводка прежнего разговора (сжато ${covered} сообщ., не поместились в окно контекста):`
      : 'Сводка прежнего разговора (не поместился в окно контекста):',
    text,
    SUMMARY_HINT,
  ].join('\n\n')
}

/** Есть ли в сводке что-то, кроме уже отправленных сообщений. */
export function summaryCovers(summary: ConversationSummary | undefined, kept: ChatMessage[]): boolean {
  return Boolean(summary?.text.trim()) &&
    !kept.some((message) => message.id === summary?.upToMessageId)
}

/**
 * Что из выпавших сообщений ещё не сжато.
 * Если `upToMessageId` в выпавшем куске не нашёлся (сообщение удалили, сводка
 * осталась от другой ветки) — сжимаем всё: лучше пересжать, чем забыть.
 */
export function dropCovered(
  dropped: ChatMessage[],
  summary: ConversationSummary | undefined,
): ChatMessage[] {
  if (!summary?.upToMessageId) return dropped
  const index = dropped.findIndex((message) => message.id === summary.upToMessageId)
  return index === -1 ? dropped : dropped.slice(index + 1)
}

export interface SummaryPrep {
  /** Сводка, с которой пойдёт запрос (может отсутствовать) */
  summary?: ConversationSummary
  /** Свежая сводка — её надо сохранить в чате */
  created?: ConversationSummary
  /** Сообщения, которые окно выбрасывает в этом ходу */
  dropped: ChatMessage[]
  /** Почему обновить сводку не удалось (чат продолжает работать обрезкой) */
  error?: string
}

/**
 * Готовит сводку для хода: если окно выбрасывает сообщения, которых в сводке
 * ещё нет, — сжимает их ДО отправки запроса, чтобы модель помнила разговор уже
 * в этом ответе.
 *
 * План контекста приходит снаружи (см. `planContext`): сводка обязана считать
 * выпавшими ровно те сообщения, которые отбросит запрос. Раньше она считала
 * план сама — без надбавки за tool-раунды и без учёта собственного блока, —
 * и часть разговора исчезала без следа в сводке (этап A задачи «Деградация
 * агента»). Теперь у сводки и у запроса буквально один и тот же план.
 *
 * Ошибка суммаризации наружу не бросается: чат важнее. Возвращаем прежнюю
 * сводку и причину — вызывающий пишет её в лог и продолжает ход.
 */
export async function prepareSummary(input: {
  settings: Settings
  summary?: ConversationSummary
  signal?: AbortSignal
  /** План контекста на этот ход — тот же, по которому строится запрос */
  plan: HistoryPlan
}): Promise<SummaryPrep> {
  const dropped = input.plan.dropped
  if (!dropped.length) return { summary: input.summary, dropped }

  const fresh = dropCovered(dropped, input.summary)
  if (!fresh.length) return { summary: input.summary, dropped }

  const built = await summarizeFresh({
    settings: input.settings,
    summary: input.summary,
    dropped: fresh,
    signal: input.signal,
  })
  return {
    summary: built.summary,
    created: built.summary && built.summary !== input.summary ? built.summary : undefined,
    dropped,
    error: built.error,
  }
}

/** Пересказ куска истории: по чанкам, с накоплением текста сводки. */
async function summarizeFresh(input: {
  settings: Settings
  summary?: ConversationSummary
  dropped: ChatMessage[]
  signal?: AbortSignal
}): Promise<{ summary?: ConversationSummary; error?: string }> {
  const chunks = chunkMessages(input.dropped)
  const used = chunks.slice(0, SUMMARY_MAX_CHUNKS)
  let current = input.summary
  const startedAt = Date.now()

  for (const chunk of used) {
    const dialog = renderDialog(chunk).text
    if (!dialog.trim()) continue
    const previous = current?.text ?? ''
    try {
      const raw = await chatOnce(input.settings, {
        messages: summaryRequestMessages(previous, dialog),
        temperature: 0,
        maxTokens: SUMMARY_MAX_TOKENS,
        signal: input.signal,
      })
      const text = parseSummary(raw)
      if (!text) throw new Error('модель вернула пустую сводку')
      const last = chunk[chunk.length - 1]
      current = {
        text,
        upToMessageId: last.id,
        covered: (current?.covered ?? 0) + chunk.length,
        updatedAt: Date.now(),
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      debugLog('error', 'Сводка: сжать историю не удалось — работаю как раньше, с обрезкой', [reason])
      return { summary: current, error: reason }
    }
  }

  if (current && current !== input.summary) {
    debugLog('info', 'Сводка: прежний разговор сжат', [
      `сообщений: ${current.covered}`,
      `символов: ${current.text.length}`,
      `запросов: ${used.length}${chunks.length > used.length ? ` из ${chunks.length}` : ''}`,
      `мс: ${Date.now() - startedAt}`,
    ])
  }
  return { summary: current }
}
