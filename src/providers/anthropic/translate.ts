import type {
  AssistantTurn,
  WireChatRequest,
  WireMessage,
  WireTool,
  WireToolCall,
  WireUsage,
} from '@/providers/openai/types'
import { ApiError } from '@/providers/openai/errors'
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from './headers'
import {
  type AnthropicChatRequest,
  type AnthropicContentBlock,
  type AnthropicImageBlock,
  type AnthropicMessage,
  type AnthropicResponse,
  type AnthropicTool,
  type AnthropicUsage,
} from './types'

/**
 * Перевод между внутренним (OpenAI-совместимым) представлением запроса
 * и Anthropic Messages API.
 *
 * Внутри приложения всё общается «проводными» WireMessage — так agent loop,
 * инструменты и контекст-менеджер не знают, к какому провайдеру идёт запрос.
 * Этот модуль делает двусторонний перевод: запрос → /v1/messages и
 * ответ/поток → привычный AssistantTurn.
 */

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/i

/** Картинка из вложения: data URL → base64-блок, ссылка → url-блок. */
export function toImageBlock(url: string): AnthropicImageBlock | null {
  const raw = (url ?? '').trim()
  if (!raw) return null
  const match = raw.match(DATA_URL_RE)
  if (match) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: match[1].toLowerCase(),
        data: match[2].replace(/\s+/g, ''),
      },
    }
  }
  if (/^https?:\/\//i.test(raw)) return { type: 'image', source: { type: 'url', url: raw } }
  return null
}

/**
 * Аргументы инструмента у нас всегда JSON-строкой (как в OpenAI-протоколе),
 * а Anthropic ждёт объект. Невалидный JSON отдать нечем — подставляем {}.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = (raw ?? '').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return {}
  }
}

/** Текст из блочного контента (для tool_result и системных сообщений). */
function textFromParts(content: WireMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part.type === 'text' ? part.text : '[изображение]'))
    .filter(Boolean)
    .join('\n')
}

function blocksFromParts(content: WireMessage['content']): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = []
  if (typeof content === 'string') {
    if (content.trim()) blocks.push({ type: 'text', text: content })
    return blocks
  }
  for (const part of content ?? []) {
    if (part.type === 'text') {
      if (part.text.trim()) blocks.push({ type: 'text', text: part.text })
      continue
    }
    const image = toImageBlock(part.image_url?.url ?? '')
    if (image) blocks.push(image)
  }
  return blocks
}

/**
 * Одно wire-сообщение → один ход Anthropic.
 *  · system      → отдельное поле запроса (обрабатывается в toAnthropicMessages);
 *  · assistant   → текст + блоки tool_use из tool_calls;
 *  · tool        → user-ход с блоком tool_result;
 *  · user        → текст и картинки.
 */
function convertMessage(message: WireMessage): AnthropicMessage | null {
  if (message.role === 'system') return null

  if (message.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: textFromParts(message.content),
        },
      ],
    }
  }

  const blocks = blocksFromParts(message.content)
  for (const call of message.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name ?? '',
      input: parseToolArguments(call.function?.arguments ?? ''),
    })
  }
  if (!blocks.length) return null
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content: blocks }
}

function asBlocks(message: AnthropicMessage): AnthropicContentBlock[] {
  if (Array.isArray(message.content)) return message.content
  return message.content ? [{ type: 'text', text: message.content }] : []
}

/**
 * Блоки tool_result обязаны идти первыми в user-ходе, который отвечает
 * на tool_use. Иначе Anthropic отвечает 400 «unexpected tool_use_id».
 */
function toolResultsFirst(blocks: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const results = blocks.filter((b) => b.type === 'tool_result')
  if (!results.length) return blocks
  return [...results, ...blocks.filter((b) => b.type !== 'tool_result')]
}

/**
 * История приложения → system-промпт и сообщения Anthropic.
 *
 * Соседние сообщения одной роли склеиваем: после нескольких tool calls у нас
 * получается серия user-ходов с tool_result, а Anthropic ждёт один ход
 * с несколькими блоками.
 */
export function toAnthropicMessages(wire: WireMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const systemParts: string[] = []
  const messages: AnthropicMessage[] = []

  for (const message of wire) {
    if (message.role === 'system') {
      const text = textFromParts(message.content).trim()
      if (text) systemParts.push(text)
      continue
    }

    const converted = convertMessage(message)
    if (!converted) continue

    const last = messages[messages.length - 1]
    if (last && last.role === converted.role) {
      last.content = toolResultsFirst([...asBlocks(last), ...asBlocks(converted)])
      continue
    }
    messages.push({ role: converted.role, content: toolResultsFirst(asBlocks(converted)) })
  }

  // Первый ход обязан быть пользовательским: ведущие ответы ассистента отбрасываем.
  while (messages.length && messages[0].role === 'assistant') messages.shift()

  return { system: systemParts.join('\n\n'), messages }
}

/** Инструменты: Anthropic использует input_schema вместо function.parameters. */
export function toAnthropicTools(tools?: WireTool[]): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined
  const out: AnthropicTool[] = []
  for (const tool of tools) {
    const fn = tool.function
    if (!fn?.name) continue
    out.push({
      name: fn.name,
      description: fn.description ?? '',
      input_schema: (fn.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    })
  }
  return out.length ? out : undefined
}

/** Тело запроса /v1/messages по нашему wire-запросу. */
export function toAnthropicRequest(request: WireChatRequest): AnthropicChatRequest {
  const { system, messages } = toAnthropicMessages(request.messages)
  const body: AnthropicChatRequest = {
    model: request.model,
    max_tokens:
      request.max_tokens && request.max_tokens > 0
        ? Math.round(request.max_tokens)
        : ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  }
  if (system) body.system = system

  // «Не использовать инструменты» в Anthropic выражается отсутствием tools.
  const tools = toAnthropicTools(request.tools)
  if (tools && request.tool_choice !== 'none') {
    body.tools = tools
    body.tool_choice = request.tool_choice === 'required' ? { type: 'any' } : { type: 'auto' }
  }

  if (typeof request.temperature === 'number' && Number.isFinite(request.temperature)) {
    // Claude принимает температуру только в диапазоне 0..1
    body.temperature = Math.min(Math.max(request.temperature, 0), 1)
  }

  body.stream = request.stream !== false
  return body
}

/** Счётчики токенов Anthropic → привычные prompt/completion (для метра контекста). */
export function toWireUsage(usage?: AnthropicUsage): WireUsage | undefined {
  if (!usage) return undefined
  const input =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  const output = usage.output_tokens ?? 0
  if (!input && !output) return undefined
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
}

/** stop_reason Anthropic → finish_reason OpenAI (UI ждёт последние). */
export function mapStopReason(reason?: string | null): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return reason ?? null
  }
}

export interface AnthropicTurnInput {
  blocks?: Array<{
    type?: string
    text?: string
    id?: string
    name?: string
    input?: unknown
    thinking?: string
  }>
  stopReason?: string | null
  usage?: AnthropicUsage
  model?: string
}

/** Блоки ответа → финальный результат одного прохода модели. */
export function toAssistantTurn(input: AnthropicTurnInput): AssistantTurn {
  let content = ''
  let reasoning = ''
  const toolCalls: WireToolCall[] = []

  for (const block of input.blocks ?? []) {
    if (block.type === 'text' && block.text) {
      content += block.text
      continue
    }
    if (block.type === 'thinking' && block.thinking) {
      reasoning += block.thinking
      continue
    }
    if (block.type === 'tool_use' && block.name) {
      const raw = block.input
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}),
        },
      })
    }
  }

  return {
    content,
    reasoning,
    toolCalls,
    finishReason: mapStopReason(input.stopReason),
    usage: toWireUsage(input.usage),
    model: input.model,
  }
}

/** Нестримовый ответ /v1/messages (ошибки API разворачиваем в ApiError). */
export function fromAnthropicResponse(json: AnthropicResponse): AssistantTurn {
  if (json.error) {
    throw new ApiError({
      message: json.error.message ?? 'Ошибка API Anthropic.',
      code: json.error.type,
    })
  }
  return toAssistantTurn({
    blocks: json.content,
    stopReason: json.stop_reason,
    usage: json.usage,
    model: json.model,
  })
}
