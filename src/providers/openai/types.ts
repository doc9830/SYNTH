/**
 * Проводные (wire) типы OpenAI-совместимого протокола.
 * Снаружи приложения эти типы не используются — только внутри providers/openai.
 */

export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** ВСЕГДА JSON-строка, не объект */
    arguments: string
  }
}

export type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireChatRequest {
  model: string
  messages: WireMessage[]
  stream?: boolean
  tools?: WireTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  temperature?: number
  max_tokens?: number
  stream_options?: { include_usage: boolean }
}

export interface WireStreamDelta {
  role?: string
  /** Обычный текст ответа */
  content?: string | null
  /** Reasoning (thinking) — отдают DeepSeek, Claude, Gemini и другие */
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export interface WireStreamChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: WireStreamDelta
    message?: WireStreamDelta & { tool_calls?: WireToolCall[] }
    finish_reason?: string | null
  }>
  usage?: WireUsage
  error?: { message?: string; type?: string; code?: string }
}

/** Финальный (собранный) результат одного прохода модели. */
export interface AssistantTurn {
  content: string
  reasoning: string
  toolCalls: WireToolCall[]
  finishReason: string | null
  usage?: WireUsage
  model?: string
}
