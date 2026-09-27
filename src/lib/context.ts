import type { ChatMessage } from '@/types'
import { buildMemoryContext } from './memory'
import type { Settings } from './settings'

/**
 * Размер контекста: оценка токенов диалога и обрезка истории по окну модели.
 *
 * Токенизатора провайдера у приложения нет, поэтому считаем по символам:
 * латиница — примерно 4 символа на токен, кириллица — около 2.5.
 * Погрешность ±15%, этого достаточно, чтобы показать заполнение окна
 * («10/32k» в шапке) и решить, когда история перестанет влезать.
 * Точные числа провайдер присылает в usage (prompt_tokens) — показываем их
 * в шторке «Контекст» рядом с оценкой.
 *
 * Зачем обрезка: часть OpenAI-совместимых провайдеров на слишком длинном
 * запросе отвечает ошибкой, а не молча его режет. Поэтому историю режем сами —
 * системный промпт и блок памяти при этом сохраняются всегда.
 */

/** Накладные расходы на одно сообщение (роль, разделители). */
export const MESSAGE_OVERHEAD = 4
/** Оценка стоимости одной картинки во входе (база + тайлы, как считает OpenAI). */
export const IMAGE_TOKENS = 850
/** Минимальный бюджет истории: даже с крошечным окном последнее сообщение уходит. */
export const MIN_HISTORY_BUDGET = 256
/** Символов на токен: так оценка ближе к реальным токенизаторам. */
const CHARS_PER_TOKEN_LATIN = 4
const CHARS_PER_TOKEN_CYRILLIC = 2.5

const CYRILLIC_RE = /[\u0400-\u04FF]/

/** Типичные размеры окна контекста у OpenAI-совместимых моделей. */
export const CONTEXT_PRESETS: number[] = [4096, 8192, 16384, 32768, 65536, 131072]

/**
 * Оценка числа токенов в тексте.
 * Кириллица дороже: в BPE-словарях русские слова распадаются на 2–3 байта-токена.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cyrillic = 0
  let total = 0
  for (const ch of text) {
    total += 1
    if (CYRILLIC_RE.test(ch)) cyrillic += 1
  }
  const other = total - cyrillic
  return Math.ceil(cyrillic / CHARS_PER_TOKEN_CYRILLIC + other / CHARS_PER_TOKEN_LATIN)
}

/**
 * Кэш оценок по объекту сообщения.
 * Сообщения в сторе не мутируются (изменённое пересоздаётся), поэтому
 * ссылка — корректный ключ: при стриминге пересчитывается только последнее.
 */
const messageTokensCache = new WeakMap<ChatMessage, number>()

/** Оценка стоимости одного сообщения вместе с вложениями. */
export function messageTokens(message: ChatMessage): number {
  const cached = messageTokensCache.get(message)
  if (cached !== undefined) return cached
  const images = message.attachments?.length ?? 0
  const value = MESSAGE_OVERHEAD + estimateTokens(message.content) + images * IMAGE_TOKENS
  messageTokensCache.set(message, value)
  return value
}

/** Суммарная оценка истории. */
export function historyTokens(history: ChatMessage[]): number {
  let total = 0
  for (const message of history) total += messageTokens(message)
  return total
}

/**
 * Дополнительная стоимость одного сообщения ПОВЕРХ его собственного текста.
 *
 * Пример: развёрнутые tool-раунды (см. `toolRoundCost` в toolHistory.ts) —
 * результат поиска или прочитанной страницы тоже занимает место в окне, и
 * обрезка обязана это учитывать. Базовый текст сообщения считается отдельно
 * (`messageTokens`), поэтому функция возвращает только доплату.
 */
export type MessageCost = (message: ChatMessage) => number

/** Стоимость сообщения для бюджета окна: собственный текст + доплата. */
function costWith(message: ChatMessage, extra?: MessageCost): number {
  return messageTokens(message) + (extra ? extra(message) : 0)
}

/** Компактная подпись размера: 10240 → «10k», 32768 → «32k», 1500 → «1.5k». */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  const k = tokens / 1024
  const rounded = k >= 10 ? Math.round(k) : Math.round(k * 10) / 10
  return `${rounded}k`
}

/** Бюджет входного контекста: окно минус место, зарезервированное под ответ. */
export function inputBudget(limit: number, maxTokens: number | null): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  const reserve = maxTokens && maxTokens > 0 ? Math.min(maxTokens, Math.floor(limit / 2)) : 0
  return Math.max(MIN_HISTORY_BUDGET, limit - reserve)
}

/**
 * Сколько токенов остаётся истории, если вычесть системную часть запроса
 * (системный промпт + блок памяти) и резерв под ответ. 0 — без ограничения.
 */
export function historyBudgetFor(settings: Settings, systemContent: string): number {
  const budget = inputBudget(settings.contextWindow, settings.maxTokens)
  if (budget <= 0) return 0
  return Math.max(MIN_HISTORY_BUDGET, budget - MESSAGE_OVERHEAD - estimateTokens(systemContent))
}

/**
 * Бюджет истории за вычетом дополнительного системного блока.
 *
 * Нужен сводке: её блок уходит в запрос отдельным системным сообщением, и
 * обрезка обязана его учитывать — иначе запрос выходит за окно ровно на
 * размер сводки, а план «выпавших» сообщений расходится с фактом.
 */
export function budgetWithoutExtraSystem(budget: number, extraSystem?: string): number {
  const extra = extraSystem?.trim()
  if (!extra || budget <= 0) return budget
  return Math.max(MIN_HISTORY_BUDGET, budget - MESSAGE_OVERHEAD - estimateTokens(extra))
}

export interface TrimResult {
  /** История, которая влезает в бюджет */
  history: ChatMessage[]
  /** Что не влезло: старые сообщения в порядке диалога (для сводки, задача 04.2) */
  dropped: ChatMessage[]
  /** Сколько старых сообщений отброшено */
  droppedMessages: number
  /** Сколько токенов отброшено */
  droppedTokens: number
}

/**
 * Оставляет только «хвост» истории, влезающий в бюджет.
 * Последнее сообщение сохраняется всегда — иначе запрос потеряет смысл.
 * Начинать историю с ответа ассистента без вопроса тоже нельзя: он относится
 * к отброшенному сообщению и только путает модель.
 *
 * `costOf` позволяет считать сообщение дороже собственного текста — агент
 * добавляет сюда развёрнутые tool-раунды (см. MessageCost).
 */
export function trimHistory(
  history: ChatMessage[],
  budget: number,
  extraCost?: MessageCost,
): TrimResult {
  const intact: TrimResult = { history, dropped: [], droppedMessages: 0, droppedTokens: 0 }
  if (!history.length || budget <= 0) return intact

  let keptTokens = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = costWith(history[i], extraCost)
    const isLast = start === history.length
    if (!isLast && keptTokens + cost > budget) break
    keptTokens += cost
    start = i
  }

  // выкидываем «ответы без вопроса» с начала оставшегося куска
  while (start < history.length - 1 && history[start].role === 'assistant') {
    keptTokens -= costWith(history[start], extraCost)
    start += 1
  }

  if (start === 0) return intact

  const dropped = history.slice(0, start)
  return {
    history: history.slice(start),
    dropped,
    droppedMessages: dropped.length,
    droppedTokens: historyTokens(dropped),
  }
}

export interface ContextUsage {
  /** Оценка токенов, которые уйдут в следующий запрос (уже после обрезки) */
  used: number
  /** Размер окна из настроек; 0 — без ограничения */
  limit: number
  /** Порог обрезки истории: окно минус резерв под ответ; 0 — без ограничения */
  budget: number
  /** Оценка всего диалога без обрезки */
  full: number
  /** Сколько сообщений отброшено по окну */
  droppedMessages: number
  /** Сколько токенов отброшено по окну */
  droppedTokens: number
  /** prompt_tokens последнего ответа провайдера — точное измерение, если есть */
  exact?: number
}

/** prompt_tokens последнего ответа провайдера — точное измерение, если есть. */
export function lastPromptTokens(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const tokens = history[i].usage?.promptTokens
    if (tokens && tokens > 0) return tokens
  }
  return undefined
}

/**
 * Готовый план запроса: что именно уйдёт в модель и что выпало по окну.
 *
 * Нужен двум потребителям:
 *  - агенту (см. buildWireMessages) — разложить историю по wire-сообщениям;
 *  - подготовке сводки (см. lib/contextSummary.ts) — узнать, какие сообщения
 *    окно выбрасывает, чтобы сжать их ДО отправки запроса.
 *
 * Считает по тем же правилам, что и сам запрос, поэтому вызывающие обязаны
 * передать тот же `systemContent`: у агента он собран с учётом статистики
 * памяти (track: true), у плана — без неё.
 *
 * Потребители обычно не зовут эту функцию напрямую, а берут готовый план из
 * `planContext` (lib/contextPlan.ts) — там же собираются все надбавки, из-за
 * которых раньше планы расходились.
 */
export interface HistoryPlan {
  /** Системная часть запроса (промпт + память) */
  systemContent: string
  /** Бюджет токенов на историю; 0 — без ограничения */
  budget: number
  /** История, которая уйдёт в запрос */
  kept: ChatMessage[]
  /** Что выпало по окну (в порядке диалога) */
  dropped: ChatMessage[]
  droppedMessages: number
  droppedTokens: number
}

export function planHistory(
  settings: Settings,
  history: ChatMessage[],
  options: { systemContent?: string; extraCost?: MessageCost; extraSystem?: string } = {},
): HistoryPlan {
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  // track: false — план не должен накручивать статистику памяти
  const memoryBlock = buildMemoryContext(settings, lastUser?.content ?? '', { track: false })
  const systemContent =
    options.systemContent ??
    [settings.systemPrompt.trim(), memoryBlock].filter(Boolean).join('\n\n')

  const budget = budgetWithoutExtraSystem(historyBudgetFor(settings, systemContent), options.extraSystem)
  const trimmed =
    budget > 0
      ? trimHistory(history, budget, options.extraCost)
      : { history, dropped: [], droppedMessages: 0, droppedTokens: 0 }

  return {
    systemContent,
    budget,
    kept: trimmed.history,
    dropped: trimmed.dropped,
    droppedMessages: trimmed.droppedMessages,
    droppedTokens: trimmed.droppedTokens,
  }
}


/**
 * Замер контекста для шапки и шторки «Контекст» переехал в plan-based вид:
 * см. `measureContext` в src/lib/contextPlan.ts — он считает по тому же плану,
 * что уходит в запрос, поэтому цифры совпадают с агентом.
 */

/** Заполнение окна в процентах (0…100). Без ограничения — 0. */
export function contextPercent(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  const percent = Math.round((used / limit) * 100)
  return Math.max(0, Math.min(100, percent))
}

