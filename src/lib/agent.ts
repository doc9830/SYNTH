import { chatTurn } from '@/api'
import { ApiError } from '@/providers/openai'
import type { WireMessage, WireToolCall } from '@/providers/openai/types'
import { buildTools, toolMap, toWireTools, type Tool } from '@/tools/registry'
import type { ChatMessage, ConversationSummary, TokenUsage, ToolCallRecord } from '@/types'
import { attachmentDataUrl } from './attachments'
import type { Settings } from './settings'
import { debugLog } from './debug'
import { planHistory } from './context'
import { summaryBlockFor } from './contextSummary'
import {
  planToolRounds,
  toolCallToWire,
  toolResultForContext,
  toolRoundCost,
} from './toolHistory'
import { getModelCapabilities, prettyJson, uid } from './utils'
import { buildMemoryContext } from './memory'
import { isUntrustedEnvelope, wrapUntrusted } from './untrusted'

/** Лимит последовательных tool calls, чтобы не уйти в бесконечный цикл. */
export const MAX_TOOL_ITERATIONS = 8

export interface AgentCallbacks {
  onDelta: (text: string) => void
  onReasoning: (text: string) => void
  /** Полный актуальный список вызовов инструментов (копия) */
  onTools: (records: ToolCallRecord[]) => void
  onModel?: (model: string) => void
  onUsage?: (usage: TokenUsage) => void
}

export interface AgentRunResult {
  content: string
  reasoning: string
  toolCalls: ToolCallRecord[]
  model?: string
  usage?: TokenUsage
  stopped: boolean
  error?: ApiError
}

function toTokenUsage(usage?: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

/**
 * История приложения → сообщения OpenAI-совместимого протокола.
 *
 * Инструментальные раунды прошлых ходов разворачиваются (последние K — см.
 * toolHistory.ts): без них модель не помнила, что уже искала и читала, и на
 * «покажи те цены ещё раз» шла искать заново.
 *
 * Асинхронная из-за картинок: в истории они лежат байтами (Blob), а в запрос
 * уходят data URL — собираем их только здесь, в момент отправки.
 */

/**
 * Как передать модели «допиши начатое»:
 *  - prefix — уже написанный текст как начало ответа ассистента (модель
 *    продолжает с этого места, повторов нет);
 *  - nudge — то же самое, но просьбой в сообщении пользователя: так делают
 *    серверы, требующие строгого чередования ролей (user → assistant).
 */
export type ContinuationMode = 'prefix' | 'nudge'

/** Просьба продолжить, когда префикс ассистента сервер не принимает. */
export const CONTINUE_NUDGE_MESSAGE =
  '[Продолжи свой предыдущий ответ ровно с того места, где он оборвался. Не начинай заново, не повторяй уже написанное и не извиняйся.]'

/**
 * Режим продолжения, выученный для подключения (baseUrl|model). Часть
 * OpenAI-совместимых серверов отвечает 400 на сообщение ассистента в конце
 * истории, поэтому один раз попробовав префикс и получив отказ, дальше
 * сразу используем просьбу — без лишнего неудачного запроса.
 */
const continuationModes = new Map<string, ContinuationMode>()

export function continuationProfile(settings: Settings): string {
  return `${settings.baseUrl.trim()}|${settings.model.trim()}`
}

export function continuationModeFor(settings: Settings): ContinuationMode {
  return continuationModes.get(continuationProfile(settings)) ?? 'prefix'
}

export function rememberContinuationMode(settings: Settings, mode: ContinuationMode): void {
  continuationModes.set(continuationProfile(settings), mode)
}

/** Сброс выученных режимов — для проверок. */
export function resetContinuationModes(): void {
  continuationModes.clear()
}

export interface WireBuildOptions {
  /** Уже написанный текст, который модель должна продолжить */
  assistantPrefix?: string
  /** Как передать продолжение (по умолчанию — префиксом ассистента) */
  continuationMode?: ContinuationMode
  /** Сводка выпавшей части диалога — отдельным системным блоком (задача 04.2) */
  summary?: ConversationSummary
  /** Разворачивать tool-раунды прошлых ходов; по умолчанию — из настроек */
  toolHistory?: boolean
}

export async function buildWireMessages(
  history: ChatMessage[],
  settings: Settings,
  options: WireBuildOptions = {},
): Promise<WireMessage[]> {
  // Возможности модели: эвристика по id + ручное переопределение из настроек
  // («Изображения на вход»), чтобы картинки не пропадали у нестандартных имён.
  const caps = getModelCapabilities(settings.model, settings.visionInput)
  const out: WireMessage[] = []

  // Запрос к памяти строим по последнему вопросу пользователя:
  // в контекст попадают закреплённые записи и самые близкие к теме.
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  const memoryBlock = buildMemoryContext(settings, lastUser?.content ?? '')
  const systemParts = [settings.systemPrompt.trim(), memoryBlock].filter(Boolean)
  const systemContent = systemParts.join('\n\n')

  if (systemParts.length) {
    out.push({ role: 'system', content: systemContent })
  }

  // Tool-раунды прошлых ходов (можно выключить в настройках, чтобы сравнить
  // поведение): сколько их разворачивать и сколько токенов они займут.
  const rounds =
    (options.toolHistory ?? settings.toolHistoryInContext) ? planToolRounds(history) : null

  // Окно контекста: история длиннее окна целиком не уходит — часть провайдеров
  // на переполнении отвечает ошибкой вместо тихой обрезки. Системный промпт и
  // блок памяти сохраняем всегда, режем только старые сообщения.
  const plan = planHistory(settings, history, {
    systemContent,
    extraCost: rounds ? toolRoundCost(rounds) : undefined,
  })
  if (plan.droppedMessages > 0) {
    debugLog('info', 'Контекст обрезан по окну', [
      `окно: ${settings.contextWindow} токенов`,
      `бюджет истории: ${plan.budget}`,
      `отброшено сообщений: ${plan.droppedMessages} (~${plan.droppedTokens} токенов)`,
      `сжато в сводку: ${options.summary?.covered ?? 0}`,
    ])
  }

  // Сводка выпавших сообщений — отдельным системным блоком в начале контекста.
  const summaryBlock = summaryBlockFor(options.summary, plan.kept)
  if (summaryBlock) out.push({ role: 'system', content: summaryBlock })

  for (const m of plan.kept) {
    if (m.role === 'assistant') {
      const calls = rounds?.ids.has(m.id) ? (m.toolCalls ?? []) : []
      if (calls.length) {
        // Раунд в том же виде, в каком он шёл в модель: сообщение ассистента с
        // tool_calls и ответы role="tool" — порядок строгий, иначе провайдер
        // отвечает 400. Результаты крупных инструментов усечены (toolHistory.ts).
        out.push({
          role: 'assistant',
          content: m.content.trim() ? m.content : null,
          tool_calls: calls.map(toolCallToWire),
        })
        for (const call of calls) {
          out.push({ role: 'tool', tool_call_id: call.id, content: toolResultForContext(call) })
        }
        continue
      }
      if (!m.content.trim()) continue
      out.push({ role: 'assistant', content: m.content })
      continue
    }

    const attachments = m.attachments ?? []
    if (!attachments.length) {
      out.push({ role: 'user', content: m.content })
      continue
    }

    if (!caps.vision) {
      out.push({
        role: 'user',
        content: `${m.content}\n\n[Пользователь приложил изображение(я), но в настройках SYNTH указано, что модель «${settings.model}» не принимает изображения на вход, поэтому картинки не отправлены. Скажи об этом и предложи выбрать vision-модель либо включить «Изображения на вход» (Настройки → Подключение).]`,
      })
      continue
    }

    const parts: NonNullable<WireMessage['content']> = []
    if (m.content.trim()) parts.push({ type: 'text', text: m.content })
    for (const a of attachments) {
      // картинка в истории лежит байтами: data URL собираем здесь, на отправке
      parts.push({ type: 'image_url', image_url: { url: await attachmentDataUrl(a) } })
    }
    out.push({ role: 'user', content: parts })
  }

  // Продолжение ответа: дописываем уже начатый текст. Обрезка контекста его не
  // касается — префикс короткий (это последний ответ) и добавляется после trim.
  if (options.assistantPrefix?.trim()) {
    out.push({ role: 'assistant', content: options.assistantPrefix })
    if ((options.continuationMode ?? 'prefix') === 'nudge') {
      out.push({ role: 'user', content: CONTINUE_NUDGE_MESSAGE })
    }
  }

  return out
}

function createRecord(call: WireToolCall): ToolCallRecord {
  let argsPretty = call.function.arguments
  try {
    argsPretty = prettyJson(call.function.arguments)
  } catch {
    /* оставляем как есть */
  }
  return {
    id: call.id || uid('tool'),
    name: call.function.name,
    args: call.function.arguments,
    argsPretty,
    status: 'running',
    startedAt: Date.now(),
  }
}

function parseArgs(call: WireToolCall): Record<string, unknown> {
  const raw = call.function.arguments?.trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    throw new Error(`Аргументы инструмента «${call.function.name}» не являются корректным JSON.`)
  }
}

/** Выполняет один tool call и заполняет запись о нём для UI. */
async function executeTool(
  call: WireToolCall,
  byName: Map<string, Tool>,
  tools: Tool[],
  settings: Settings,
  signal: AbortSignal,
  record: ToolCallRecord,
): Promise<string> {
  const tool = byName.get(call.function.name)
  if (!tool) {
    throw new Error(
      `Инструмент «${call.function.name}» недоступен. Доступные: ${
        tools.map((t) => t.name).join(', ') || 'нет'
      }. Его можно включить в настройках.`,
    )
  }

  const args = parseArgs(call)
  const result = await tool.execute(args, { settings, signal })

  record.status = 'done'
  record.finishedAt = Date.now()
  record.summary = result.summary
  record.resultText = result.content
  record.sources = result.sources
  record.images = result.images

  debugLog('tool', `Инструмент ${call.function.name} выполнен`, [
    {
      args,
      summary: result.summary,
      sources: result.sources?.length ?? 0,
      images: result.images?.length ?? 0,
      untrusted: Boolean(result.untrusted),
    },
  ])

  // Внешние данные (текст чужой страницы) уходят модели в рамке «это данные,
  // а не инструкции». Инструмент мог обернуть результат сам — не оборачиваем дважды.
  if (result.untrusted && !isUntrustedEnvelope(result.content)) {
    return wrapUntrusted(result.summary ?? call.function.name, result.content)
  }
  return result.content
}

export interface AgentInput {
  /** История ДО текущего ответа (user/assistant) */
  history: ChatMessage[]
  settings: Settings
  signal: AbortSignal
  callbacks: AgentCallbacks
  /**
   * Продолжение оборванного ответа: текст, который модель должна дописать.
   * Приложение отправляет его как начало ответа ассистента (или просьбой, если
   * сервер такого не принимает) и приклеивает результат к уже показанному тексту.
   */
  assistantPrefix?: string
  /** Как передать продолжение (по умолчанию — префиксом ассистента) */
  continuationMode?: ContinuationMode
  /**
   * Сводка выпавшей по окну части диалога (см. lib/contextSummary.ts).
   * Приложение считает её до хода и передаёт сюда — тогда модель помнит
   * прежний разговор уже в этом ответе.
   */
  summary?: ConversationSummary
}

/**
 * Сервер отклонил сообщение ассистента в конце истории? Тогда повторяем ход,
 * передав продолжение служебной просьбой.
 *
 * Повтор безопасен только если ничего не сгенерировано (content пуст и
 * инструменты не вызывались) — иначе пользователь увидел бы задвоенный текст.
 */
export function shouldFallbackToNudge(input: {
  hasPrefix: boolean
  mode: ContinuationMode
  apiError: ApiError
  content: string
  records: ToolCallRecord[]
  signal: AbortSignal
}): boolean {
  if (!input.hasPrefix || input.mode !== 'prefix') return false
  if (input.signal.aborted) return false
  if (input.content.length > 0 || input.records.length > 0) return false
  if (input.apiError.status !== 400 && input.apiError.status !== 422) return false
  const text = `${input.apiError.message} ${input.apiError.details ?? ''}`
  // Так ругаются серверы, требующие строгого чередования ролей или не знающие
  // незакрытого сообщения ассистента: «messages must alternate», «assistant
  // message must be the last» и похожие формулировки.
  return /assistant|alternat|prefill|prefix|last message|must end|roles/i.test(text)
}

/**
 * Agent loop:
 *   user → LLM → tool calls? → execute → append results → LLM → ... → final answer
 *
 * Наружу не выбрасывает исключений: при ошибке возвращает частичный результат
 * вместе с ApiError, чтобы UI показал то, что успело прийти.
 */
export async function runAgent(input: AgentInput): Promise<AgentRunResult> {
  const { history, settings, signal, callbacks } = input
  const tools: Tool[] = buildTools(settings)
  const byName = toolMap(tools)
  const wireTools = toWireTools(tools)
  const wire: WireMessage[] = await buildWireMessages(history, settings, {
    assistantPrefix: input.assistantPrefix,
    continuationMode: input.continuationMode,
    summary: input.summary,
  })

  let content = ''
  let reasoning = ''
  let model: string | undefined
  let usage: TokenUsage | undefined
  const records: ToolCallRecord[] = []
  let stopped = false

  debugLog('request', 'POST chat/completions', [
    {
      model: settings.model,
      messages: wire.length,
      tools: wireTools.map((t) => t.function.name),
      continuation: input.assistantPrefix ? (input.continuationMode ?? 'prefix') : undefined,
      toolRounds: wire.filter((m) => m.role === 'tool').length,
      summary: input.summary?.covered ?? 0,
    },
  ])

  try {
    for (let step = 0; step < MAX_TOOL_ITERATIONS; step += 1) {
      const turn = await chatTurn(settings, {
        messages: wire,
        tools: wireTools.length ? wireTools : undefined,
        signal,
        handlers: {
          onDelta: (t) => {
            content += t
            callbacks.onDelta(t)
          },
          onReasoning: (t) => {
            reasoning += t
            callbacks.onReasoning(t)
          },
          onModel: (m) => {
            model = m
            callbacks.onModel?.(m)
          },
          onUsage: (u) => {
            usage = toTokenUsage(u)
            if (usage) callbacks.onUsage?.(usage)
          },
        },
      })

      if (turn.model) model = turn.model
      if (turn.usage) {
        usage = toTokenUsage(turn.usage)
        if (usage) callbacks.onUsage?.(usage)
      }

      debugLog('response', `Итерация ${step + 1}: ответ получен`, [
        {
          model: turn.model,
          finish_reason: turn.finishReason,
          tool_calls: turn.toolCalls.map((c) => c.function.name),
          content_length: turn.content.length,
          usage: turn.usage,
        },
      ])

      if (!turn.toolCalls.length) break

      // Порядок строгий: сначала ответ ассистента с tool_calls, затем role="tool"
      wire.push({
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.toolCalls,
      })

      for (const call of turn.toolCalls) {
        const record = createRecord(call)
        records.push(record)
        callbacks.onTools([...records])

        let resultText: string
        try {
          resultText = await executeTool(call, byName, tools, settings, signal, record)
        } catch (err) {
          if (signal.aborted) {
            record.status = 'error'
            record.error = 'Остановлено пользователем'
            record.finishedAt = Date.now()
            callbacks.onTools([...records])
            return { content, reasoning, toolCalls: records, model, usage, stopped: true }
          }
          const message = err instanceof Error ? err.message : String(err)
          record.status = 'error'
          record.error = message
          record.finishedAt = Date.now()
          resultText = `Ошибка выполнения инструмента «${call.function.name}»: ${message}`
          debugLog('error', `Инструмент ${call.function.name}: ошибка`, [message])
        }

        callbacks.onTools([...records])
        wire.push({ role: 'tool', tool_call_id: call.id, content: resultText })
      }

      if (step === MAX_TOOL_ITERATIONS - 1) {
        content += `${content ? '\n\n' : ''}_Достигнут лимит из ${MAX_TOOL_ITERATIONS} последовательных вызовов инструментов — цикл остановлен._`
      }

      if (signal.aborted) {
        stopped = true
        break
      }
    }
  } catch (err) {
    const apiError =
      err instanceof ApiError
        ? err
        : new ApiError({ message: err instanceof Error ? err.message : String(err) })

    if (signal.aborted || apiError.message === 'Генерация остановлена.') {
      debugLog('info', 'Генерация остановлена пользователем', [])
      return { content, reasoning, toolCalls: records, model, usage, stopped: true }
    }

    debugLog('error', 'Ошибка при обращении к API', [
      {
        message: apiError.message,
        status: apiError.status,
        endpoint: apiError.endpoint,
        details: apiError.details,
      },
    ])
    return { content, reasoning, toolCalls: records, model, usage, stopped, error: apiError }
  }

  return { content, reasoning, toolCalls: records, model, usage, stopped }
}
