import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb'
import type { ChatMessage, Conversation, MemoryEntry, MessageRecord } from '@/types'
import { isLegacyRecord, sanitizeSummary, sortMessages, splitLegacyConversation } from './dbModel'

const DB_NAME = 'deepseek-chat'
/**
 * Схема 3: чаты и сообщения — разные сторы.
 * До этого сообщения лежали внутри записи чата, и любая правка переписывала
 * всю переписку целиком (с картинками в base64 — десятки мегабайт на запись).
 */
const DB_VERSION = 3
const STORE_CONVERSATIONS = 'conversations'
const STORE_MESSAGES = 'messages'
const STORE_MEMORIES = 'memories'
const STORE_META = 'meta'
/** Ключ в сторе `meta`: версия схемы, которую увидело приложение */
const META_SCHEMA = 'schema'

interface ChatDB extends DBSchema {
  /** Обёртки чатов: без сообщений (см. `Conversation`) */
  conversations: {
    key: string
    value: Conversation
    indexes: { byUpdatedAt: number }
  }
  /** Сообщения: ключ — id сообщения, индекс — владелец */
  messages: {
    key: string
    value: MessageRecord
    indexes: { byConversationId: string }
  }
  /** Долговременная память: короткие факты о пользователе */
  memories: {
    key: string
    value: MemoryEntry
    indexes: { byUpdatedAt: number }
  }
  meta: {
    key: string
    value: unknown
  }
}

type VersionTx = IDBPTransaction<ChatDB, ArrayLike<StoreNames<ChatDB>>, 'versionchange'>

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

/**
 * Переносит старые записи в схему 3: обёртка остаётся в `conversations`,
 * каждое сообщение уезжает отдельной записью в `messages`.
 *
 * Идемпотентно: запись без поля `messages` уже переехала и пропускается.
 * Работает только на IDB-запросах (без сети и таймеров), поэтому транзакция
 * версии остаётся живой. Если что-то упало — транзакция откатывается целиком:
 * версия базы не фиксируется, старые данные остаются как были.
 */
async function migrateMessagesToOwnStore(tx: VersionTx): Promise<void> {
  const conversations = tx.objectStore(STORE_CONVERSATIONS)
  const messages = tx.objectStore(STORE_MESSAGES)
  for (const key of await conversations.getAllKeys()) {
    const record: unknown = await conversations.get(key)
    if (!isLegacyRecord(record)) continue
    const split = splitLegacyConversation(record)
    for (const message of split.messages) await messages.put(message)
    await conversations.put(split.conversation)
  }
}

function getDB(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatDB>(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, tx) {
        // схема 1–2: базовые сторы (создаются и на пустой базе)
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const store = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' })
          store.createIndex('byUpdatedAt', 'updatedAt')
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const store = db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' })
          store.createIndex('byConversationId', 'conversationId')
        }
        if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
          const store = db.createObjectStore(STORE_MEMORIES, { keyPath: 'id' })
          store.createIndex('byUpdatedAt', 'updatedAt')
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META)
        }

        // схема 3: сообщения — отдельный стор
        if (oldVersion < 3) await migrateMessagesToOwnStore(tx)

        await tx.objectStore(STORE_META).put(DB_VERSION, META_SCHEMA)
      },
    })
  }
  return dbPromise
}


/* ───────────────────────── Чаты и сообщения ───────────────────────── */

/** Только обёртки чатов: сообщения тянем лениво, по открытому чату. */
export async function loadConversationsFromDB(): Promise<Conversation[]> {
  const db = await getDB()
  const all = await db.getAll(STORE_CONVERSATIONS)
  // сводка (задача 04.2) могла остаться от прежней версии или испортиться:
  // нормализуем на чтении, битую — выбрасываем
  return all
    .map((record) => {
      const summary = sanitizeSummary(record.summary)
      return summary === record.summary ? record : { ...record, summary }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Сообщения одного чата в порядке диалога.
 * Заодно помечаем «stopped» недописанный ответ: если приложение убили посреди
 * хода, продолжать его уже некому, а вечный «печатает…» выглядит как поломка.
 */
export async function loadMessagesFromDB(conversationId: string): Promise<ChatMessage[]> {
  const db = await getDB()
  const records = await db.getAllFromIndex(STORE_MESSAGES, 'byConversationId', conversationId)
  return sortMessages(records).map((record) =>
    record.status === 'streaming' ? { ...record, status: 'stopped' } : record,
  )
}

/** Запись обёртки чата (без сообщений). */
export async function putConversationRecord(conversation: Conversation): Promise<void> {
  const db = await getDB()
  await db.put(STORE_CONVERSATIONS, conversation)
}

/** Запись изменившихся сообщений — по одной записи на сообщение. */
export async function putMessageRecords(records: MessageRecord[]): Promise<void> {
  if (!records.length) return
  const db = await getDB()
  const tx = db.transaction(STORE_MESSAGES, 'readwrite')
  for (const record of records) await tx.store.put(record)
  await tx.done
}

/** Удаление сообщений (правка истории, удаление чата). */
export async function deleteMessageRecords(ids: string[]): Promise<void> {
  if (!ids.length) return
  const db = await getDB()
  const tx = db.transaction(STORE_MESSAGES, 'readwrite')
  for (const id of ids) await tx.store.delete(id)
  await tx.done
}

/** Удаление чата: обёртка + все его сообщения по индексу. */
export async function deleteConversationFromDB(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite')
  const keys = await tx.objectStore(STORE_MESSAGES).index('byConversationId').getAllKeys(id)
  for (const key of keys) await tx.objectStore(STORE_MESSAGES).delete(key)
  await tx.objectStore(STORE_CONVERSATIONS).delete(id)
  await tx.done
}

/** Полная очистка истории: и чаты, и сообщения. */
export async function clearConversationsInDB(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite')
  await tx.objectStore(STORE_MESSAGES).clear()
  await tx.objectStore(STORE_CONVERSATIONS).clear()
  await tx.done
}

/**
 * Проход по всем сообщениям базы (поиск по истории).
 *
 * Списка сообщений всех чатов в памяти больше нет, поэтому искать приходится
 * в базе. Курсор читает записи по одной, выходим сразу, как набрали `limit`.
 */
export async function scanMessages(
  match: (record: MessageRecord) => boolean,
  limit: number,
): Promise<MessageRecord[]> {
  const db = await getDB()
  const tx = db.transaction(STORE_MESSAGES, 'readonly')
  const found: MessageRecord[] = []
  let cursor = await tx.store.openCursor()
  while (cursor) {
    if (match(cursor.value)) {
      found.push(cursor.value)
      if (found.length >= limit) break
    }
    cursor = await cursor.continue()
  }
  await tx.done
  return found
}

/* ───────────────────────── Долговременная память ───────────────────────── */

export async function loadMemoriesFromDB(): Promise<MemoryEntry[]> {
  const db = await getDB()
  const all = await db.getAll(STORE_MEMORIES)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putMemoryToDB(entry: MemoryEntry): Promise<void> {
  const db = await getDB()
  await db.put(STORE_MEMORIES, entry)
}

export async function deleteMemoryFromDB(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_MEMORIES, id)
}

export async function clearMemoriesInDB(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE_MEMORIES)
}

export async function replaceMemoriesInDB(entries: MemoryEntry[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(STORE_MEMORIES, 'readwrite')
  await tx.store.clear()
  for (const entry of entries) await tx.store.put(entry)
  await tx.done
}

/* ───────────────────────── Диагностика ───────────────────────── */

export interface DBStats {
  /** Версия схемы, записанная приложением (3 — раздельные сторы) */
  schema: number | null
  conversations: number
  messages: number
  /** Сколько записей ещё в старом формате (должно быть 0 — миграция не доехала) */
  legacyConversations: number
}

/**
 * Состояние базы: показываем в консоли диагностики, чтобы можно было проверить
 * миграцию на настоящей истории, а не только на пустой базе.
 */
export async function dbStats(): Promise<DBStats> {
  const db = await getDB()
  const schema = await db.get(STORE_META, META_SCHEMA)
  const wrappers = await db.getAll(STORE_CONVERSATIONS)
  return {
    schema: typeof schema === 'number' ? schema : null,
    conversations: wrappers.length,
    messages: await db.count(STORE_MESSAGES),
    legacyConversations: wrappers.filter((record) => isLegacyRecord(record)).length,
  }
}

/**
 * Оценка занятого места (Storage API) — показываем в настройках.
 * Картинки лежат в истории байтами (Blob), но история всё равно занимает
 * больше, чем текст, поэтому размер честно показываем пользователю.
 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}
