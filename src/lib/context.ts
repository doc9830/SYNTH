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
const MESSAGE_OVERHEAD = 4
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

export interface TrimResult {
  /** История, которая влезает в бюджет */
  history: ChatMessage[]
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
 */
export function trimHistory(history: ChatMessage[], budget: number): TrimResult {
  const intact: TrimResult = { history, droppedMessages: 0, droppedTokens: 0 }
  if (!history.length || budget <= 0) return intact

  let keptTokens = 0
  let start = history.length
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = messageTokens(history[i])
    const isLast = start === history.length
    if (!isLast && keptTokens + cost > budget) break
    keptTokens += cost
    start = i
  }

  // выкидываем «ответы без вопроса» с начала оставшегося куска
  while (start < history.length - 1 && history[start].role === 'assistant') {
    keptTokens -= messageTokens(history[start])
    start += 1
  }

  if (start === 0) return intact

  const dropped = history.slice(0, start)
  return {
    history: history.slice(start),
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

function lastPromptTokens(history: ChatMessage[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const tokens = history[i].usage?.promptTokens
    if (tokens && tokens > 0) return tokens
  }
  return undefined
}

/** Системная часть запроса: системный промпт + блок долговременной памяти. */
function systemTokens(settings: Settings, history: ChatMessage[]): number {
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  // track: false — замер из интерфейса не должен накручивать статистику памяти
  const memoryBlock = buildMemoryContext(settings, lastUser?.content ?? '', { track: false })
  return MESSAGE_OVERHEAD + estimateTokens(settings.systemPrompt) + estimateTokens(memoryBlock)
}

/**
 * Замер контекста для текущего диалога: сколько токенов уйдёт в следующий
 * запрос, сколько всего накопилось и сколько сообщений срежет окно.
 * Считает по тем же правилам, что и агент (см. buildWireMessages).
 */
export function measureContext(settings: Settings, history: ChatMessage[]): ContextUsage {
  const limit = settings.contextWindow
  const budget = inputBudget(limit, settings.maxTokens)
  const system = systemTokens(settings, history)
  const full = system + historyTokens(history)
  const exact = lastPromptTokens(history)

  if (limit <= 0) {
    return { used: full, limit: 0, budget: 0, full, droppedMessages: 0, droppedTokens: 0, exact }
  }

  const historyBudget = Math.max(MIN_HISTORY_BUDGET, budget - system)
  const trimmed = trimHistory(history, historyBudget)
  const used = system + historyTokens(trimmed.history)

  return {
    used,
    limit,
    budget,
    full,
    droppedMessages: trimmed.droppedMessages,
    droppedTokens: trimmed.droppedMessages ? full - used : 0,
    exact,
  }
}

/** Заполнение окна в процентах (0…100). Без ограничения — 0. */
export function contextPercent(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  const percent = Math.round((used / limit) * 100)
  return Math.max(0, Math.min(100, percent))
}

