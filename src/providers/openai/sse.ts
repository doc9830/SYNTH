import { ApiError } from './errors'
import type {
  AssistantTurn,
  WireChatRequest,
  WireStreamChunk,
  WireStreamDelta,
  WireToolCall,
  WireUsage,
} from './types'

/**
 * Низкоуровневый разбор Server-Sent Events.
 * Важно: tool call может приходить НЕСКОЛЬКИМИ chunks, поэтому нужен accumulator.
 */

interface SseEvent {
  event?: string
  data: string
}

const DONE = '[DONE]'

/** Итератор по SSE-событиям из потока fetch-ответа. */
export async function* iterateSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let currentEvent: string | undefined

  const handleLine = (line: string): SseEvent | null => {
    if (!line) return null
    if (line.startsWith(':')) return null // keep-alive комментарий
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
      return null
    }
    if (line.startsWith('data:')) {
      const data = line.slice(5).trimStart()
      const evt: SseEvent = { event: currentEvent, data }
      currentEvent = undefined
      return evt
    }
    return null
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        const evt = handleLine(line)
        if (evt) yield evt
        idx = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const evt = handleLine(buffer.replace(/\r$/, ''))
    if (evt) yield evt
  } finally {
    reader.releaseLock()
  }
}

/** Собирает tool_calls, приходящие по частям (по index). */
export class ToolCallAccumulator {
  private items = new Map<number, { id: string; name: string; args: string }>()

  push(deltas: WireStreamDelta['tool_calls']): void {
    if (!deltas?.length) return
    for (const delta of deltas) {
      const index = delta.index ?? 0
      const existing = this.items.get(index) ?? { id: '', name: '', args: '' }
      if (delta.id) existing.id = delta.id
      if (delta.function?.name) existing.name += delta.function.name
      if (delta.function?.arguments) existing.args += delta.function.arguments
      this.items.set(index, existing)
    }
  }

  /** На случай, если полный (нестримовый) ответ пришёл целиком. */
  pushFull(calls: WireToolCall[]): void {
    calls.forEach((call, index) => {
      const existing = this.items.get(index) ?? { id: '', name: '', args: '' }
      this.items.set(index, {
        id: call.id || existing.id,
        name: call.function?.name || existing.name,
        args: call.function?.arguments || existing.args,
      })
    })
  }

  get size(): number {
    return this.items.size
  }

  toWire(): WireToolCall[] {
    return [...this.items.entries()]
      .filter(([, v]) => v.name.length > 0)
      .sort((a, b) => a[0] - b[0])
      .map(([index, v], i) => ({
        id: v.id || `call_${index}_${i}`,
        type: 'function' as const,
        function: { name: v.name, arguments: v.args || '{}' },
      }))
  }
}

export interface StreamHandlers {
  onModel?: (model: string) => void
  onDelta?: (text: string) => void
  onReasoning?: (text: string) => void
  onToolCallDelta?: (info: { index: number; name?: string; argsDelta?: string }) => void
  onUsage?: (usage: WireUsage) => void
}

function normalizeUsage(usage: WireUsage | undefined): WireUsage | undefined {
  if (!usage) return undefined
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  }
}

/**
 * Читает SSE-поток chat/completions и возвращает собранный ответ модели:
 * текст, reasoning, tool_calls, finish_reason и usage.
 */
export async function consumeChatStream(
  response: Response,
  handlers: StreamHandlers = {},
): Promise<AssistantTurn> {
  if (!response.body) {
    throw new ApiError({ message: 'Пустой ответ от API (нет тела потока).' })
  }

  const toolCalls = new ToolCallAccumulator()
  let content = ''
  let reasoning = ''
  let finishReason: string | null = null
  let usage: WireUsage | undefined
  let model: string | undefined

  for await (const event of iterateSse(response.body)) {
    if (event.data === DONE) break
    if (!event.data) continue

    let chunk: WireStreamChunk
    try {
      chunk = JSON.parse(event.data) as WireStreamChunk
    } catch {
      continue // не-JSON служебные строки игнорируем
    }

    if (chunk.error) {
      throw new ApiError({
        message: chunk.error.message ?? 'Ошибка в потоке ответа API.',
        code: chunk.error.code,
      })
    }

    if (chunk.model && chunk.model !== model) {
      model = chunk.model
      handlers.onModel?.(chunk.model)
    }

    if (chunk.usage) {
      const next = normalizeUsage(chunk.usage)
      if (next) {
        usage = next
        handlers.onUsage?.(next)
      }
    }

    const choice = chunk.choices?.[0]
    if (!choice) continue

    if (choice.finish_reason) finishReason = choice.finish_reason

    const delta = choice.delta ?? choice.message
    if (!delta) continue

    const text = delta.content
    if (typeof text === 'string' && text.length > 0) {
      content += text
      handlers.onDelta?.(text)
    }

    const think = delta.reasoning_content ?? delta.reasoning
    if (typeof think === 'string' && think.length > 0) {
      reasoning += think
      handlers.onReasoning?.(think)
    }

    if (delta.tool_calls?.length) {
      toolCalls.push(delta.tool_calls)
      for (const tc of delta.tool_calls) {
        handlers.onToolCallDelta?.({
          index: tc.index ?? 0,
          name: tc.function?.name,
          argsDelta: tc.function?.arguments,
        })
      }
    }

    if (choice.message?.tool_calls?.length) {
      toolCalls.pushFull(choice.message.tool_calls)
    }
  }

  return {
    content,
    reasoning,
    toolCalls: toolCalls.toWire(),
    finishReason,
    usage,
    model,
  }
}

/** Разбор ответа без streaming (fallback). */
export function parseChatResponse(json: unknown): AssistantTurn {
  const data = json as {
    model?: string
    choices?: Array<{
      message?: {
        content?: string | null
        reasoning_content?: string | null
        reasoning?: string | null
        tool_calls?: WireToolCall[]
      }
      finish_reason?: string | null
    }>
    usage?: WireUsage
    error?: { message?: string; code?: string }
  }

  if (data.error) {
    throw new ApiError({ message: data.error.message ?? 'Ошибка API.', code: data.error.code })
  }

  const choice = data.choices?.[0]
  const message = choice?.message
  return {
    content: message?.content ?? '',
    reasoning: message?.reasoning_content ?? message?.reasoning ?? '',
    toolCalls: message?.tool_calls ?? [],
    finishReason: choice?.finish_reason ?? null,
    usage: normalizeUsage(data.usage),
    model: data.model,
  }
}

/** Тело запроса chat/completions по настройкам приложения. */
export function buildChatRequest(input: {
  model: string
  messages: WireChatRequest['messages']
  stream: boolean
  tools?: WireChatRequest['tools']
  temperature?: number
  maxTokens?: number | null
  includeUsage?: boolean
}): WireChatRequest {
  const body: WireChatRequest = {
    model: input.model,
    messages: input.messages,
    stream: input.stream,
  }
  if (input.tools?.length) {
    body.tools = input.tools
    body.tool_choice = 'auto'
  }
  if (typeof input.temperature === 'number') body.temperature = input.temperature
  if (input.maxTokens) body.max_tokens = input.maxTokens
  if (input.stream && input.includeUsage !== false) {
    body.stream_options = { include_usage: true }
  }
  return body
}
