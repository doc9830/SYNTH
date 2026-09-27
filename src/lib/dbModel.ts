/**
 * Модель записей IndexedDB: чат (обёртка) и сообщение (отдельная запись).
 *
 * Здесь только чистые функции — их легко проверить в Node (checks/db.check.ts),
 * IndexedDB-обвязка живёт в `db.ts`. Миграция обязана переносить старые данные
 * без потерь, поэтому вся раскладка старой записи описана именно здесь.
 */
import type {
  ChatMessage,
  Conversation,
  ConversationSummary,
  ImageAttachment,
  MessageRecord,
} from '@/types'
import { dataUrlToBlob } from './dataUrl'

/** Сколько символов последнего сообщения попадает в подпись чата */
export const PREVIEW_LENGTH = 90

/**
 * Старая запись (схемы ≤ 2): чат вместе с массивом сообщений.
 * Поля необязательны: база живёт с первых версий приложения, поэтому читаем
 * максимально терпимо и нормализуем при миграции.
 */
export type LegacyConversation = Partial<Conversation> & { messages?: ChatMessage[] }

/** Похожа ли запись на старую: у неё есть поле `messages` с массивом. */
export function isLegacyRecord(value: unknown): value is LegacyConversation {
  if (!value || typeof value !== 'object') return false
  return Array.isArray((value as { messages?: unknown }).messages)
}

/**
 * Вложение в том виде, в каком его кладём в базу: картинка — Blob.
 * Старые data URL превращаем в байты один раз, при миграции.
 */
export function storedAttachment(attachment: ImageAttachment): ImageAttachment {
  if (attachment.blob || !attachment.dataUrl) return attachment
  const blob = dataUrlToBlob(attachment.dataUrl)
  if (!blob) return attachment
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    width: attachment.width,
    height: attachment.height,
    blob,
  }
}

/**
 * Сообщение → запись стора `messages`.
 * `order` — позиция в диалоге: по ней сообщения собираются обратно, потому что
 * порядок в индексе IndexedDB задаётся ключом (id), а не временем создания.
 */
export function messageRecord(
  conversationId: string,
  message: ChatMessage,
  order: number,
): MessageRecord {
  const attachments = message.attachments?.length
    ? message.attachments.map(storedAttachment)
    : message.attachments
  return { ...message, conversationId, order, attachments }
}

/** Короткая подпись последнего сообщения — её показывает список чатов. */
export function previewOf(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  const text = last.content.replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, PREVIEW_LENGTH)
  if (last.attachments?.length) return `🖼 ${last.attachments.length}`
  if (last.reasoning) return 'Размышления…'
  return ''
}

/**
 * Сводка чата из базы: поле появилось в 1.9.0 (задача 04.2), поэтому читаем
 * терпимо — у старых записей его нет, а испорченную сводку лучше выбросить,
 * чем подставить модели мусор.
 */
export function sanitizeSummary(value: unknown): ConversationSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ConversationSummary>
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!text) return undefined
  const covered = Number(raw.covered)
  const updatedAt = Number(raw.updatedAt)
  return {
    text,
    upToMessageId: typeof raw.upToMessageId === 'string' ? raw.upToMessageId : '',
    covered: Number.isFinite(covered) && covered > 0 ? Math.round(covered) : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  }
}

/** Обёртка чата по его сообщениям: подпись, число сообщений, время правки. */
export function wrapperOf(
  base: Pick<Conversation, 'id' | 'title' | 'createdAt' | 'pinned' | 'model' | 'summary'>,
  messages: ChatMessage[],
  updatedAt = Date.now(),
): Conversation {
  return {
    id: base.id,
    title: base.title,
    createdAt: base.createdAt,
    updatedAt,
    pinned: base.pinned,
    model: base.model,
    // сводка выпавшей части диалога едет вместе с чатом и не теряется при
    // обновлении подписи/числа сообщений (см. sanitizeSummary)
    summary: sanitizeSummary(base.summary),
    preview: previewOf(messages),
    messageCount: messages.length,
  }
}

/**
 * Старая запись → обёртка + отдельные сообщения.
 * Идемпотентно по построению: повторный прогон по обёртке даёт её саму и
 * пустой список сообщений, ничего не теряя и не дублируя.
 */
export function splitLegacyConversation(legacy: LegacyConversation): {
  conversation: Conversation
  messages: MessageRecord[]
} {
  const id = String(legacy.id)
  const messages = (Array.isArray(legacy.messages) ? legacy.messages : []).map((message, index) =>
    messageRecord(id, message, index),
  )
  const now = Date.now()
  const createdAt = Number.isFinite(legacy.createdAt) ? Number(legacy.createdAt) : now
  const updatedAt = Number.isFinite(legacy.updatedAt) ? Number(legacy.updatedAt) : createdAt
  return {
    conversation: wrapperOf(
      {
        id,
        title: typeof legacy.title === 'string' && legacy.title.trim() ? legacy.title : 'Без названия',
        createdAt,
        pinned: Boolean(legacy.pinned),
        model: typeof legacy.model === 'string' ? legacy.model : '',
        // сводку старых записей переносим: пересчитывать её незачем
        summary: legacy.summary,
      },
      messages,
      updatedAt,
    ),
    messages,
  }
}

/**
 * Облегчённая копия сообщения для страховочного снимка стрима.
 *
 * Снимок пишется каждые ~0.7 с, пока идёт ответ. Тяжёлые поля инструментов
 * (картинки в base64 и тексты прочитанных страниц) в него не попадают: иначе
 * одна запись снова весила бы мегабайты. Полная версия записывается один раз —
 * в терминальном состоянии хода.
 */
export function lightMessage(record: MessageRecord): MessageRecord {
  const calls = record.toolCalls
  if (!calls?.length) return record
  return {
    ...record,
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      args: call.args,
      argsPretty: call.argsPretty,
      status: call.status,
      summary: call.summary,
      error: call.error,
      startedAt: call.startedAt,
      finishedAt: call.finishedAt,
    })),
  }
}

/**
 * Что изменилось между прежним и новым списком сообщений чата.
 *
 * Сообщения в сторе не мутируются: изменённое всегда новый объект. Значит,
 * сравнение по ссылке — честный признак «это сообщение не трогали», и в базу
 * уходят только реально изменившиеся записи (главный смысл схемы 3).
 */
export function diffMessages(
  conversationId: string,
  previous: ChatMessage[],
  next: ChatMessage[],
): { changed: MessageRecord[]; removed: string[] } {
  const previousById = new Map(previous.map((message) => [message.id, message]))
  const changed: MessageRecord[] = []
  next.forEach((message, order) => {
    const before = previousById.get(message.id)
    // сначала вычёркиваем из «прежних»: иначе неизменённое сообщение
    // попадёт в список на удаление
    previousById.delete(message.id)
    if (before === message) return
    changed.push(messageRecord(conversationId, message, order))
  })
  return { changed, removed: [...previousById.keys()] }
}

/** Сообщения чата в порядке диалога (страховка от разъехавшегося `order`). */
export function sortMessages<T extends ChatMessage & { order?: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => {
    const byOrder = (a.order ?? 0) - (b.order ?? 0)
    return byOrder !== 0 ? byOrder : a.createdAt - b.createdAt
  })
}
