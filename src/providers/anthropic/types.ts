/**
 * Проводные (wire) типы Anthropic Messages API (/v1/messages).
 *
 * Claude несовместим с OpenAI-протоколом, поэтому подключение «Anthropic»
 * описывается здесь отдельно: системный промпт — отдельное поле запроса,
 * ответ — массив блоков (text / tool_use / thinking), инструменты —
 * tool_use + tool_result вместо tool_calls + role: 'tool'.
 * Снаружи приложения эти типы не видны: перевод делает translate.ts.
 *
 * Константы и заголовки — в headers.ts.
 */

export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface AnthropicChatRequest {
  model: string
  /** Обязателен: без него API отвечает 400 */
  max_tokens: number
  messages: AnthropicMessage[]
  /** Системный промпт — отдельное поле, а не роль сообщения */
  system?: string
  tools?: AnthropicTool[]
  tool_choice?: { type: 'auto' | 'any' }
  temperature?: number
  stream?: boolean
}

export interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AnthropicResponse {
  id?: string
  model?: string
  content?: Array<{
    type?: string
    text?: string
    id?: string
    name?: string
    input?: unknown
    /** Блоки extended thinking */
    thinking?: string
  }>
  stop_reason?: string | null
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}

/** Событие SSE-потока Messages API (см. providers/anthropic/stream.ts). */
export interface AnthropicStreamEvent {
  type?: string
  index?: number
  message?: {
    model?: string
    usage?: AnthropicUsage
    stop_reason?: string | null
  }
  content_block?: { type?: string; id?: string; name?: string; text?: string }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    thinking?: string
    stop_reason?: string | null
  }
  usage?: AnthropicUsage
  error?: { type?: string; message?: string }
}
