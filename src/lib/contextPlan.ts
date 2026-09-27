/**
 * Единый план контекста на ход (этап A задачи «Деградация агента»).
 *
 * Что было не так: план считали три места, каждое по-своему.
 *  - агент (`buildWireMessages`) — с надбавкой за развёрнутые tool-раунды;
 *  - подготовка сводки (`prepareSummary`) — без неё;
 *  - метр контекста в шапке (`ContextMeter`) — со своей копией той же логики.
 *
 * Из-за расхождения по `extraCost` суммаризация считала выпавшими меньше
 * сообщений, чем реально отбрасывала обрезка: часть разговора исчезала без
 * следа в сводке, и модель на границе окна «достраивала» контекст по памяти —
 * отсюда повторы уже написанного. Отдельно не учитывался блок сводки: он
 * уходит системным сообщением и вытеснял из окна ещё несколько сообщений.
 *
 * Теперь план считается один раз (`planContext`) и передаётся всем
 * потребителям как готовый объект. Расхождение стало невозможным по
 * построению: у агента и у сводки буквально один и тот же план.
 */
import type { ChatMessage, ConversationSummary } from '@/types'
import {
  MESSAGE_OVERHEAD,
  estimateTokens,
  historyTokens,
  inputBudget,
  lastPromptTokens,
  planHistory,
  type ContextUsage,
  type HistoryPlan,
  type MessageCost,
} from './context'
import { summaryBlockFor } from './contextSummary'
import type { Settings } from './settings'
import { planToolRounds, toolRoundCost, type ToolRoundPlan } from './toolHistory'

export interface ContextPlanOptions {
  /** Сводка выпавшей части: её блок тоже занимает место в окне */
  summary?: ConversationSummary
  /**
   * Готовая системная часть (промпт + память). Агент собирает её сам — с
   * включённой статистикой памяти (`track: true`), — и передаёт сюда, чтобы
   * бюджет окна считался по тому же тексту, что уйдёт в запрос.
   */
  systemContent?: string
  /** Разворачивать tool-раунды прошлых ходов (по умолчанию — да) */
  toolHistory?: boolean
  /**
   * Не резать историю: нужно, когда сжать выпавшее не удалось, а выбрасывать
   * сообщения без сводки нельзя (этап C). Бюджет в плане остаётся настоящим.
   */
  noTrim?: boolean
  /** Явная надбавка за сообщение вместо расчёта по tool-раундам (проверки) */
  extraCost?: MessageCost
}

export interface ContextPlan extends HistoryPlan {
  /** Системный блок сводки — тот самый, что уйдёт в запрос ('' — не нужен) */
  summaryBlock: string
  /** План разворачивания tool-раундов; null — выключено в настройках */
  rounds: ToolRoundPlan | null
}

/**
 * План запроса: что уходит в модель, что выпадает по окну и сколько места
 * занято системной частью. Единственный источник правды для агента, сводки и
 * метра контекста.
 */
export function planContext(
  settings: Settings,
  history: ChatMessage[],
  options: ContextPlanOptions = {},
): ContextPlan {
  const rounds = options.toolHistory === false ? null : planToolRounds(history)
  const extraCost = options.extraCost ?? (rounds ? toolRoundCost(rounds) : undefined)
  // Место под сводку резервируем по её полному тексту: блок уйдёт системным
  // сообщением, и обрезка обязана это учитывать заранее.
  const summaryReserve = summaryBlockFor(options.summary, [])
  const base = planHistory(settings, history, {
    systemContent: options.systemContent,
    extraCost,
    extraSystem: summaryReserve,
  })

  // Без обрезки: сообщения остаются в контексте, даже если окно превышено —
  // честная ошибка провайдера лучше молчаливой потери половины разговора.
  const dropped = options.noTrim ? [] : base.dropped
  const kept = options.noTrim ? history : base.kept

  return {
    systemContent: base.systemContent,
    budget: base.budget,
    kept,
    dropped,
    droppedMessages: dropped.length,
    droppedTokens: dropped.length ? historyTokens(dropped) : 0,
    summaryBlock: summaryBlockFor(options.summary, kept),
    rounds,
  }
}

/**
 * Замер контекста для шапки и шторки «Контекст».
 *
 * Считает по тому же плану, что уходит в запрос, поэтому цифры совпадают с
 * агентом: meter обязан показывать то, что случится на самом деле, а не свою
 * оценку «примерно».
 */
export function measureContext(
  settings: Settings,
  history: ChatMessage[],
  options: ContextPlanOptions = {},
): ContextUsage {
  const plan = planContext(settings, history, options)
  const limit = settings.contextWindow
  const budget = inputBudget(limit, settings.maxTokens)
  const system =
    MESSAGE_OVERHEAD +
    estimateTokens(plan.systemContent) +
    (plan.summaryBlock ? MESSAGE_OVERHEAD + estimateTokens(plan.summaryBlock) : 0)
  const roundCost = (messages: ChatMessage[]): number =>
    plan.rounds ? messages.reduce((sum, m) => sum + (plan.rounds?.tokens.get(m.id) ?? 0), 0) : 0
  const full = system + historyTokens(history) + roundCost(history)
  const exact = lastPromptTokens(history)

  if (limit <= 0) {
    return { used: full, limit: 0, budget, full, droppedMessages: 0, droppedTokens: 0, exact }
  }

  const used = system + historyTokens(plan.kept) + roundCost(plan.kept)
  return {
    used,
    limit,
    budget,
    full,
    droppedMessages: plan.droppedMessages,
    droppedTokens: plan.droppedMessages ? full - used : 0,
    exact,
  }
}
