import { ApiError } from '@/providers/openai/errors'
import { iterateSse, type StreamHandlers } from '@/providers/openai/sse'
import type { AssistantTurn, WireToolCall } from '@/providers/openai/types'
import { mapStopReason, toWireUsage } from './translate'
import type { AnthropicStreamEvent, AnthropicUsage } from './types'

/**
 * Разбор SSE-потока Anthropic Messages API.
 *
 * Отличия от OpenAI-потока, из-за которых нужен отдельный парсер:
 *  · события названы по типу (`content_block_delta`), а не `choices[].delta`;
 *  · текст и аргументы инструментов приходят дельтами разных типов
 *    (`text_delta`, `thinking_delta`, `input_json_delta`);
 *  · счётчики токенов разделены: input_tokens — в message_start,
 *    output_tokens — в message_delta;
 *  · ошибка приходит отдельным событием `error` уже после начала потока.
 *
 * Наружу отдаём привычный AssistantTurn и те же handlers, что у OpenAI-пути,
 * поэтому UI, метру контекста и agent loop всё равно, кто отвечает.
 */

interface BlockState {
  type: string
  id: string
  name: string
  args: string
  started: boolean
}

function emptyState(): BlockState {
  return { type: '', id: '', name: '', args: '', started: false }
}

export async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  handlers?: StreamHandlers,
  options: { idleTimeoutMs?: number } = {},
): Promise<AssistantTurn> {
  const blocks = new Map<number, BlockState>()
  let content = ''
  let reasoning = ''
  let model: string | undefined
  let stopReason: string | null = null
  let usage: AnthropicUsage = {}

  const stateOf = (index: number): BlockState => {
    const existing = blocks.get(index)
    if (existing) return existing
    const fresh = emptyState()
    blocks.set(index, fresh)
    return fresh
  }

  for await (const event of iterateSse(body, { idleTimeoutMs: options.idleTimeoutMs })) {
    if (!event.data || event.data === '[DONE]') continue

    let payload: AnthropicStreamEvent
    try {
      payload = JSON.parse(event.data) as AnthropicStreamEvent
    } catch {
      continue // «мусорные» строки потока игнорируем, как и в OpenAI-ветке
    }

    switch (payload.type ?? event.event) {
      case 'ping':
        break

      case 'error':
        throw new ApiError({
          message: payload.error?.message ?? 'Ошибка в потоке ответа Anthropic.',
          code: payload.error?.type,
        })

      case 'message_start': {
        if (payload.message?.model) {
          model = payload.message.model
          handlers?.onModel?.(model)
        }
        usage = { ...payload.message?.usage }
        // input_tokens известны уже сейчас — метру контекста это важно
        const startUsage = toWireUsage(usage)
        if (startUsage) handlers?.onUsage?.(startUsage)
        break
      }

      case 'content_block_start': {
        const index = payload.index ?? 0
        const state = stateOf(index)
        const block = payload.content_block ?? {}
        state.type = block.type ?? ''
        state.id = block.id ?? ''
        state.name = block.name ?? ''
        state.started = true
        // Иногда блок приходит сразу с готовым текстом (нестримовые прокси)
        if (typeof block.text === 'string' && block.text) {
          content += block.text
          handlers?.onDelta?.(block.text)
        }
        const input = (block as { input?: unknown }).input
        if (state.type === 'tool_use' && input && Object.keys(input as object).length) {
          state.args = JSON.stringify(input)
        }
        break
      }

      case 'content_block_delta': {
        const index = payload.index ?? 0
        const state = stateOf(index)
        const delta = payload.delta ?? {}

        if (delta.type === 'text_delta' && delta.text) {
          content += delta.text
          handlers?.onDelta?.(delta.text)
          break
        }
        if (delta.type === 'thinking_delta' && delta.thinking) {
          reasoning += delta.thinking
          handlers?.onReasoning?.(delta.thinking)
          break
        }
        if (delta.type === 'input_json_delta' && delta.partial_json) {
          state.args += delta.partial_json
          handlers?.onToolCallDelta?.({
            index,
            name: state.name || undefined,
            argsDelta: delta.partial_json,
          })
        }
        break
      }

      case 'message_delta': {
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        if (payload.usage) usage = { ...usage, ...payload.usage }
        const next = toWireUsage(usage)
        if (next) handlers?.onUsage?.(next)
        break
      }

      default:
        break // content_block_stop / message_stop / неизвестные события
    }
  }

  const toolCalls: WireToolCall[] = [...blocks.entries()]
    .filter(([, state]) => state.type === 'tool_use' && state.name)
    .sort((a, b) => a[0] - b[0])
    .map(([index, state], i) => ({
      id: state.id || `call_${index}_${i}`,
      type: 'function' as const,
      function: { name: state.name, arguments: state.args || '{}' },
    }))

  return {
    content,
    reasoning,
    toolCalls,
    finishReason: mapStopReason(stopReason),
    usage: toWireUsage(usage),
    model,
  }
}
