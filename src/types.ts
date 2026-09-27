/**
 * Доменные типы приложения.
 * Никакой специфики конкретного провайдера здесь быть не должно —
 * она живёт в src/providers/**.
 */

export type MessageRole = 'user' | 'assistant'

export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error'

export type ToolRunStatus = 'running' | 'done' | 'error'

/** Результат web-поиска (общий формат для любого search-провайдера). */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** ISO-дата публикации, если провайдер её отдаёт */
  publishedAt?: string
  /** Источник/движок (tavily, brave, searxng, bing, duckduckgo, wikipedia) */
  source?: string
}

/**
 * Движок бесплатного поиска (без API-ключа).
 * auto — перебор по порядку: Bing → DuckDuckGo → Wikipedia.
 */
export type KeylessEngine = 'auto' | 'bing' | 'duckduckgo' | 'wikipedia'

/** Картинка, найденная на прочитанной странице. */
export interface PageImageInfo {
  src: string
  alt?: string
  width?: number
  height?: number
}

/** Скриншот страницы (read_url). */
export interface PageScreenshot {
  /** data URL: data:image/jpeg;base64,… — показываем прямо в чате */
  dataUrl: string
  width: number
  height: number
  bytes: number
}

/**
 * Результат чтения страницы по ссылке (инструмент read_url).
 * Заполняется backend'ом: он рендерит страницу в headless Chrome (или парсит HTML).
 */
export interface PageReadResult {
  url: string
  finalUrl: string
  title: string
  description: string
  /** og:image — обычно главная картинка/баннер страницы */
  ogImage?: string
  lang: string
  headings: string[]
  text: string
  truncated: boolean
  /** Ссылки со страницы (в UI показываются как источники) */
  links: SearchResult[]
  images: PageImageInfo[]
  /** Цвета и шрифт — полезно, если нужно повторить дизайн лендинга */
  design?: { background: string; color: string; font: string; colors: string[] }
  /** Чем читали: рендер в Chrome или статический разбор HTML */
  engine: 'chrome' | 'static'
  screenshot?: PageScreenshot
  warnings: string[]
}

/** Запись о вызове инструмента моделью. */
export interface ToolCallRecord {
  id: string
  name: string
  /** Сырые аргументы как их прислала модель (JSON-строка) */
  args: string
  /** Разобранные и pretty-printed аргументы — для панели «Подробнее» */
  argsPretty: string
  status: ToolRunStatus
  /** Короткий человекочитаемый результат для UI (не сырой JSON) */
  summary?: string
  /** Текст, который ушёл обратно модели */
  resultText?: string
  /** sources для web_search */
  sources?: SearchResult[]
  /** картинки (data URL) для generate_image */
  images?: string[]
  error?: string
  startedAt: number
  finishedAt?: number
}

/** Изображение, прикреплённое пользователем. */
export interface ImageAttachment {
  id: string
  name: string
  mime: string
  /** data URL: data:image/png;base64,... */
  dataUrl: string
  width?: number
  height?: number
}

export interface TokenUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  createdAt: number
  /** Текст сообщения (markdown) */
  content: string
  /** reasoning / thinking, если провайдер его вернул */
  reasoning?: string
  /** Сколько времени модель размышляла (мс) — для свёрнутого блока «Размышления · 12 с» */
  reasoningMs?: number
  /** Прикреплённые изображения (только у user) */
  attachments?: ImageAttachment[]
  /** Вызовы инструментов (только у assistant) */
  toolCalls?: ToolCallRecord[]
  status: MessageStatus
  /** Текст ошибки в человекочитаемом виде */
  error?: string
  errorDetails?: string
  model?: string
  usage?: TokenUsage
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  /** Последняя использованная модель */
  model: string
  messages: ChatMessage[]
}

/** Возможности модели — определяем эвристикой по ID. */
export interface ModelCapabilities {
  vision: boolean
  tools: boolean
  reasoning: boolean
}

/**
 * Принимает ли модель изображения на вход:
 *  - auto — решаем по id модели (эвристика, см. getModelCapabilities);
 *  - on   — да: пользователь знает лучше эвристики (шлюзы и внутренние
 *           имена моделей вида `my-gateway-vision-2` угадать невозможно);
 *  - off  — нет: картинки к запросу не добавляются.
 */
export type VisionInputMode = 'auto' | 'on' | 'off'

/**
 * Вид записи долговременной памяти.
 *  - fact        — устойчивый факт («живёт в Казани»)
 *  - preference  — предпочтение («любит короткие ответы без воды»)
 *  - project     — проект/контекст работы («пишет приложение SYNTH на React»)
 *  - instruction — постоянное указание («отвечай по-русски»)
 *  - note        — заметка, добавленная вручную
 */
export type MemoryKind = 'fact' | 'preference' | 'project' | 'instruction' | 'note'

/**
 * Запись долговременной памяти. Хранится только на устройстве (IndexedDB),
 * подмешивается в system prompt и доступна модели через инструменты.
 */
export interface MemoryEntry {
  id: string
  /** Само утверждение — одна короткая фраза, от третьего лица */
  text: string
  kind: MemoryKind
  tags: string[]
  /** Закреплённые записи не удаляются при чистке и всегда идут в контекст */
  pinned: boolean
  createdAt: number
  updatedAt: number
  /** Откуда запись: команда «запомни», авто-извлечение, инструмент модели, вручную */
  source: 'user' | 'auto' | 'tool' | 'manual'
  /** Чат-источник (если запись извлечена из переписки) */
  conversationId?: string
  /** Сколько раз запись попадала в контекст модели — влияет на ранжирование */
  hits: number
}
