import { chatTurn } from '@/api'
import { ApiError } from '@/providers/openai'
import type { WireMessage, WireToolCall } from '@/providers/openai/types'
import { buildTools, toolMap, toWireTools, type Tool } from '@/tools/registry'
import type { ChatMessage, TokenUsage, ToolCallRecord } from '@/types'
import { attachmentDataUrl } from './attachments'
import type { Settings } from './settings'
import { debugLog } from './debug'
import { historyBudgetFor, trimHistory } from './context'
import { getModelCapabilities, prettyJson, uid } from './utils'
import { buildMemoryContext } from './memory'

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
 * Инструментальные раунды прошлых ходов разворачивать не нужно:
 * для контекста достаточно финальных текстов, а инструмент модель вызовет снова.
 *
 * Асинхронная из-за картинок: в истории они лежат байтами (Blob), а в запрос
 * уходят data URL — собираем их только здесь, в момент отправки.
 */
export async function buildWireMessages(
  history: ChatMessage[],
  settings: Settings,
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

  // Окно контекста: история длиннее окна целиком не уходит — часть провайдеров
  // на переполнении отвечает ошибкой вместо тихой обрезки. Системный промпт и
  // блок памяти сохраняем всегда, режем только старые сообщения.
  const budget = historyBudgetFor(settings, systemContent)
  const trimmed = budget > 0 ? trimHistory(history, budget) : { history, droppedMessages: 0, droppedTokens: 0 }
  if (trimmed.droppedMessages > 0) {
    debugLog('info', 'Контекст обрезан по окну', [
      `окно: ${settings.contextWindow} токенов`,
      `бюджет истории: ${budget}`,
      `отброшено сообщений: ${trimmed.droppedMessages} (~${trimmed.droppedTokens} токенов)`,
    ])
  }

  for (const m of trimmed.history) {
    if (m.role === 'assistant') {
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
    },
  ])

  return result.content
}

export interface AgentInput {
  /** История ДО текущего ответа (user/assistant) */
  history: ChatMessage[]
  settings: Settings
  signal: AbortSignal
  callbacks: AgentCallbacks
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
  const wire: WireMessage[] = await buildWireMessages(history, settings)

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
