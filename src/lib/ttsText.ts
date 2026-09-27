/**
 * Ответ модели → фрагменты для озвучки (задача 06).
 *
 * Читать сообщение целиком нельзя: «стоп» срабатывал бы только после всего
 * текста, а подсветку прогресса не к чему привязать. Поэтому markdown
 * разбирается по блокам (абзац, заголовок, пункт списка, строка таблицы):
 * каждый блок — отдельный фрагмент TTS.
 *
 * Блоки кода не читаем совсем: синтезатор произносит их бессмысленно.
 *
 * Модуль без зависимостей и без DOM — его целиком проверяет checks/tts.check.ts.
 */

export interface SpeechChunk {
  /** Что читает движок (markdown уже снят). */
  text: string
  /** Ключ подсветки: нормализованный текст фрагмента. */
  key: string
}

/** Предел длины фрагмента: абзац длиннее режем по предложениям. */
export const MAX_CHUNK = 400

/** Фрагмент короче этого порога подсвечиваем только по точному совпадению. */
const CONTAINMENT_MIN = 24

const FENCE_RE = /^\s*(?:```|~~~)/
const HEADING_RE = /^\s{0,3}#{1,6}\s+/
const LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/
const QUOTE_RE = /^\s{0,3}>\s?/
const HR_RE = /^\s{0,3}(?:[-*_]\s*){3,}$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
}

/** Схлопывает пробелы и переносы: движку они не нужны. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Есть ли что произносить (одних знаков препинания мало). */
function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text)
}

/**
 * Снимает markdown с одной строки, оставляя произносимый текст.
 * Важно: `snake_case` не трогаем — подчёркивания внутри слова в GFM
 * не курсив, а в идентификаторах они встречаются часто.
 */
export function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[(\^[^\]]*)\]/g, '')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_(.+?)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (_m, entity: string) => ENTITIES[entity] ?? ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
}

/** Нормализованный вид текста для сопоставления блока и фрагмента. */
export function normalizeForMatch(text: string): string {
  return collapse(
    text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' '),
  )
}

/**
 * Похож ли блок сообщения на озвучиваемый фрагмент (для подсветки).
 * Длинный абзац режется на предложения — тогда подсвечиваем абзац целиком.
 */
export function blockMatches(blockText: string, key: string): boolean {
  if (!key) return false
  const normalized = normalizeForMatch(blockText)
  if (!normalized) return false
  if (normalized === key) return true
  return key.length >= CONTAINMENT_MIN && normalized.includes(key)
}

/** Режет слишком длинный текст: сначала по предложениям, потом по словам. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]
  const parts: string[] = []
  let buffer = ''
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length > MAX_CHUNK) {
      if (buffer) {
        parts.push(buffer)
        buffer = ''
      }
      parts.push(...hardSplit(sentence))
      continue
    }
    if (buffer && buffer.length + sentence.length + 1 > MAX_CHUNK) {
      parts.push(buffer)
      buffer = sentence
      continue
    }
    buffer = buffer ? `${buffer} ${sentence}` : sentence
  }
  if (buffer) parts.push(buffer)
  return parts
}

/** Одно предложение без точек: режем по словам, чтобы «стоп» был отзывчивым. */
function hardSplit(sentence: string): string[] {
  const words = sentence.split(' ')
  const parts: string[] = []
  let buffer = ''
  for (const word of words) {
    if (buffer && buffer.length + word.length + 1 > MAX_CHUNK) {
      parts.push(buffer)
      buffer = word
      continue
    }
    buffer = buffer ? `${buffer} ${word}` : word
  }
  if (buffer) parts.push(buffer)
  return parts
}

/** Добавляет произносимый текст в список фрагментов. */
function pushText(chunks: SpeechChunk[], text: string): void {
  const clean = collapse(text)
  if (!hasSpeech(clean)) return
  for (const part of splitLong(clean)) {
    const key = normalizeForMatch(part)
    if (!key) continue
    chunks.push({ text: part, key })
  }
}


/**
 * Разбирает markdown-ответ на фрагменты для озвучки.
 * Пустой результат — читать нечего (одни блоки кода или картинки).
 */
export function speechChunks(markdown: string): SpeechChunk[] {
  const chunks: SpeechChunk[] = []
  const paragraph: string[] = []
  let inFence = false

  const flush = () => {
    if (!paragraph.length) return
    pushText(chunks, paragraph.join(' '))
    paragraph.length = 0
  }

  for (const raw of markdown.split(/\r?\n/)) {
    if (FENCE_RE.test(raw)) {
      // Открытие или закрытие блока кода: сам код не читаем.
      flush()
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (HR_RE.test(line) || TABLE_SEP_RE.test(line)) {
      // Разделитель секции или шапка таблицы: произносить нечего.
      flush()
      continue
    }
    if (QUOTE_RE.test(raw)) {
      flush()
      pushText(chunks, stripInline(raw.replace(QUOTE_RE, '')))
      continue
    }
    if (HEADING_RE.test(raw)) {
      flush()
      pushText(chunks, stripInline(raw.replace(HEADING_RE, '')))
      continue
    }
    if (LIST_RE.test(raw)) {
      flush()
      pushText(chunks, stripInline(raw.replace(LIST_RE, '')))
      continue
    }
    if (line.startsWith('|') || line.endsWith('|')) {
      // Строка таблицы: ячейки читаем подряд, как перечисление.
      flush()
      pushText(chunks, stripInline(line.replace(/^\|/, '').replace(/\|$/, '').split('|').join(' — ')))
      continue
    }
    paragraph.push(stripInline(line))
  }
  flush()

  return chunks
}
