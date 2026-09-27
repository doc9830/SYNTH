import type { ModelCapabilities, VisionInputMode } from '@/types'

/** Короткий уникальный id без внешних зависимостей. */
export function uid(prefix = ''): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 12)
  return `${prefix}${prefix ? '_' : ''}${Date.now().toString(36)}${rand}`
}

/** Склейка классов без внешних зависимостей. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** «сегодня», «вчера», «12 марта» — для списка чатов. */
export function formatDay(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays === 0) return formatTime(ts)
  if (diffDays === 1) return 'вчера'
  if (diffDays < 7) return `${diffDays} дн. назад`
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

/** Первое сообщение пользователя → заголовок чата. */
export function deriveTitle(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Новый чат'
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function maskKey(key: string): string {
  if (!key) return ''
  const trimmed = key.trim()
  if (trimmed.length <= 8) return trimmed.replace(/.(?=.)/g, '*')
  return `${trimmed.slice(0, 6)}${'*'.repeat(8)}${trimmed.slice(-4)}`
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** Человекочитаемая длительность. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} с`
  return `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`
}

/**
 * Модели, которые принимают изображения на вход (vision / multimodal).
 * Список собран по публичным каталогам провайдеров: `/v1/models` этих данных
 * почти не отдаёт, а ошибка «картинки нельзя» хуже обратной — пользователь
 * не может приложить фото к модели, которая его прекрасно понимает.
 * Семейства без vision перечислены в NO_VISION_MODEL_RE.
 */
const VISION_MODEL_RE =
  /(claude|gpt-4|gpt-5|gemini|gemma-?3|pixtral|llava|internvl|moondream|qwen.*(vl|vision)|glm-4v|glm-5v|minimax|grok-3|grok-4|grok.*vision|o[34](?![0-9])|deepseek-v4|step-1|-vl(-|$)|-v-|vision)/

/**
 * Заведомо текстовые семейства и генераторы картинок: изображения на вход
 * они не принимают. DeepSeek V3/R1 (`deepseek-chat`, `deepseek-reasoner`) —
 * только текст; `gpt-image-*` и `dall-e` рисуют, но не общаются.
 */
const NO_VISION_MODEL_RE =
  /(embedding|rerank|whisper|tts|speech|audio|moderation|reasoner|deepseek-chat|deepseek-r1|gpt-image|dall-e)/

/**
 * Эвристика возможностей модели по её ID: vision/reasoning/tools.
 * Провайдеры редко отдают эту информацию в /v1/models, поэтому
 * UI-подсказки (например, «модель не понимает картинки») строятся по имени.
 * `visionInput` переопределяет догадку вручную (Настройки → Подключение).
 */
export function getModelCapabilities(
  model: string,
  visionInput: VisionInputMode = 'auto',
): ModelCapabilities {
  const m = (model || '').toLowerCase()
  const vision =
    visionInput === 'on'
      ? true
      : visionInput === 'off'
        ? false
        : VISION_MODEL_RE.test(m) && !NO_VISION_MODEL_RE.test(m)
  const tools = !/(image|embedding|whisper|tts|audio|video|seedance)/.test(m)
  const reasoning = /(reason|think|r1|deepseek-v4|o[134](?![0-9])|pro)/.test(m)
  return { vision, tools, reasoning }
}
