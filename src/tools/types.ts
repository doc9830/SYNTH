import type { Settings } from '@/lib/settings'
import type { SearchResult } from '@/types'

/**
 * Универсальная система инструментов.
 * Инструменты НЕ зашиты в компонент чата: они регистрируются в registry
 * и исполняются agent loop'ом на основе tool_calls от модели.
 */

export interface ToolResult {
  /** Текст, который уйдёт обратно модели */
  content: string
  /** Короткая человекочитаемая сводка для UI («Найдено 5 источников») */
  summary?: string
  /** Источники для отображения ссылками */
  sources?: SearchResult[]
  /** data URL'ы картинок для показа в сообщении */
  images?: string[]
  /**
   * Результат пришёл из внешнего источника (страница в интернете, чужой текст).
   * Агент оборачивает такие результаты в рамку «внешние данные» — чтобы модель
   * читала их как данные, а не как инструкции (см. lib/untrusted.ts).
   */
  untrusted?: boolean
}

export interface ToolContext {
  settings: Settings
  signal: AbortSignal
}

export interface JsonSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface Tool {
  name: string
  description: string
  parameters: JsonSchema
  /** Выполнить инструмент. Ошибки бросаем как Error — их увидит и модель, и пользователь. */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
