/**
 * Возврат инструментальных раундов прошлых ходов в контекст (задача 04.1).
 *
 * Почему: приложение хранит вызовы инструментов и их результаты в истории
 * (`ChatMessage.toolCalls`), но в запрос уходили только финальные тексты
 * ассистента. Из-за этого модель не помнила, что уже искала и читала: на
 * «покажи те цены ещё раз» шёл новый поиск, а источники терялись.
 *
 * Что разворачиваем: последние K раундов — `assistant(tool_calls)` плюс
 * ответные `role: "tool"`. Раунд — сообщение ассистента с непустыми
 * `toolCalls` (ровно так их собирает agent loop, см. src/lib/agent.ts).
 *
 * Чего не делаем: не тянем в контекст полные тексты прочитанных страниц.
 * Полный результат остаётся в записи сообщения (IndexedDB, схема 3 из задачи
 * 02), а в контекст уходит выжимка с пометкой «…обрезано» и ссылкой на
 * источник. Плюс ограничение на K раундов: старые страницы в контекст вообще
 * не возвращаются, сколько бы их ни прочитали за чат.
 *
 * Рамка внешних данных (untrusted.ts) при усечении сохраняется: закрывающий
 * маркер обязан остаться на месте, иначе модель перестанет понимать, что текст
 * внутри — данные, а не инструкции.
 */
import type { WireToolCall } from '@/providers/openai/types'
import type { ChatMessage, ToolCallRecord } from '@/types'
import { estimateTokens, type MessageCost } from './context'
import { isUntrustedEnvelope, UNTRUSTED_CLOSE } from './untrusted'

/** Сколько последних tool-раундов разворачиваем в контекст */
export const TOOL_HISTORY_ROUNDS = 3

/** Сколько символов результата одного вызова попадает в контекст */
export const TOOL_RESULT_CHARS = 2400

/**
 * Сколько символов занимает однострочная выжимка результата.
 * Ею сворачиваются старые результаты, когда запрос внутри хода перерастает
 * окно (этап B задачи «Деградация агента»): место в окне важнее подробностей,
 * а полный текст остался в записи сообщения.
 */
export const TOOL_RESULT_ONELINE_CHARS = 240

/** Пометка об усечении — по ней видно, что текст неполный */
export const TRUNCATION_MARK = '…обрезано'

/** Накладные расходы на один вызов инструмента (роль, tool_call_id, обвязка) */
const PER_CALL_OVERHEAD = 4

export interface ToolRoundPlan {
  /** id сообщений, чьи tool-раунды разворачиваем в контекст */
  ids: Set<string>
  /** Дополнительная стоимость (токены) по id сообщения — для бюджета окна */
  tokens: Map<string, number>
  /** Сколько раундов в плане */
  rounds: number
}

/** Сообщение ассистента с вызовами инструментов — то, что разворачиваем. */
export function isToolRound(message: ChatMessage): boolean {
  return message.role === 'assistant' && Boolean(message.toolCalls?.length)
}

/**
 * План разворачивания: последние K раундов истории.
 *
 * Считаем по всей истории, а не по уже обрезанной: стоимость нужна обрезке
 * (см. `trimHistory`), чтобы tool-раунды не вытолкнули окно за предел.
 */
export function planToolRounds(
  history: ChatMessage[],
  rounds: number = TOOL_HISTORY_ROUNDS,
): ToolRoundPlan {
  const ids = new Set<string>()
  const tokens = new Map<string, number>()
  if (rounds <= 0) return { ids, tokens, rounds: 0 }
  let taken = 0
  for (let i = history.length - 1; i >= 0 && taken < rounds; i -= 1) {
    const message = history[i]
    if (!isToolRound(message)) continue
    ids.add(message.id)
    tokens.set(message.id, toolRoundTokens(message))
    taken += 1
  }
  return { ids, tokens, rounds: taken }
}

/** Функция доплаты за развёрнутые раунды: к тексту сообщения прибавляется
 * стоимость его tool-результатов (см. MessageCost в context.ts). */
export function toolRoundCost(plan: ToolRoundPlan): MessageCost {
  return (message) => plan.tokens.get(message.id) ?? 0
}

/** Сколько токенов добавит развёрнутый раунд. */
export function toolRoundTokens(
  message: ChatMessage,
  limit: number = TOOL_RESULT_CHARS,
): number {
  const calls = message.toolCalls ?? []
  return calls.length * PER_CALL_OVERHEAD + estimateTokens(toolRoundText(message, limit))
}

/** Текст раунда для контекста: вызов и результат каждого инструмента. */
export function toolRoundText(
  message: ChatMessage,
  limit: number = TOOL_RESULT_CHARS,
): string {
  return (message.toolCalls ?? []).map((call) => toolCallText(call, limit)).join('\n\n')
}

function toolCallText(call: ToolCallRecord, limit: number): string {
  const args = (call.args ?? '').trim() || '{}'
  return `${call.name}(${args}) → ${toolResultForContext(call, limit)}`
}

/** Вызов инструмента в том виде, в каком он уходит обратно в запрос. */
export function toolCallToWire(call: ToolCallRecord): WireToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: (call.args ?? '').trim() || '{}' },
  }
}

/**
 * Результат инструмента для контекста: полный текст, если он короткий, иначе
 * выжимка с пометкой об усечении и ссылкой на источник.
 */
export function toolResultForContext(
  record: ToolCallRecord,
  limit: number = TOOL_RESULT_CHARS,
): string {
  const full = resultTextOf(record)
  if (full.length <= limit) return full
  return `${truncateToolResult(full, limit)}\n${truncatedResultNote(record, full.length)}`
}

/**
 * Однострочная выжимка результата: имя, ключевой аргумент, итог.
 * Нужна прогрессивному сжатию внутри хода (см. `squeezeWire` в agent.ts)
 * и журналу выполненных вызовов: подробности в окне не помещаются, а факт
 * «это уже читали, вот итог» обязан остаться.
 */
export function toolResultOneLiner(record: ToolCallRecord): string {
  const args = (record.args ?? '').trim() || '{}'
  return `${record.name}(${args}) → ${flatten(resultTextOf(record), TOOL_RESULT_ONELINE_CHARS)}`
}

/** Сжимает пробелы и режет длинный текст: в одну строку и без переводов строк. */
function flatten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}${TRUNCATION_MARK}`
}

/** Что инструмент реально вернул модели: текст, иначе сводку, иначе ошибку. */
export function resultTextOf(record: ToolCallRecord): string {
  const text = (record.resultText ?? '').trim()
  if (text) return text
  const summary = (record.summary ?? '').trim()
  if (summary) return summary
  if (record.status === 'error') {
    return `Инструмент завершился ошибкой${record.error ? `: ${record.error}` : '.'}`
  }
  if (record.status === 'running') return 'Инструмент не успел завершиться: ход был остановлен.'
  return 'Инструмент не вернул данных.'
}

/**
 * Усечение результата инструмента до лимита.
 * Если результат пришёл в рамке внешних данных, режем содержимое внутри рамки,
 * а саму рамку (закрывающий маркер и текст после неё) сохраняем.
 */
export function truncateToolResult(text: string, limit: number = TOOL_RESULT_CHARS): string {
  if (text.length <= limit) return text
  if (!isUntrustedEnvelope(text)) return `${text.slice(0, limit)}${TRUNCATION_MARK}`
  const closeAt = text.indexOf(UNTRUSTED_CLOSE)
  const head = text.slice(0, Math.max(0, closeAt)).slice(0, limit)
  return [head, TRUNCATION_MARK, text.slice(closeAt)].join('\n')
}

/**
 * Пояснение к сокращённому результату: сколько было всего, короткая выжимка
 * инструмента и ссылка на источник — чтобы модель знала, что текст полный есть,
 * и не принимала усечение за отсутствие информации.
 */
export function truncatedResultNote(record: ToolCallRecord, chars: number): string {
  const summary = (record.summary ?? '').trim()
  const link = toolResultLink(record)
  return [
    `[Результат «${record.name}» приведён сокращённо: всего ${chars.toLocaleString('ru-RU')} символов,`,
    'полный текст остался в этом чате.',
    summary ? `Выжимка: ${summary}.` : '',
    link ? `Источник: ${link}.` : '',
    'Если нужна деталь, которой нет выше, — скажи об этом, а не додумывай.]',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Ссылка или запрос, по которым результат можно получить заново. */
export function toolResultLink(record: ToolCallRecord): string {
  for (const field of ['url', 'link', 'href']) {
    const value = argsField(record.args, field)
    if (value) return value
  }
  const url = record.sources?.[0]?.url
  if (url) return url
  const query = argsField(record.args, 'query')
  return query ? `поиск: «${query}»` : ''
}

function argsField(args: string, field: string): string {
  try {
    const parsed: unknown = JSON.parse(args)
    if (!parsed || typeof parsed !== 'object') return ''
    const value = (parsed as Record<string, unknown>)[field]
    return typeof value === 'string' ? value.trim() : ''
  } catch {
    return ''
  }
}
