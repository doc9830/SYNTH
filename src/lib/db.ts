import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Conversation, MemoryEntry } from '@/types'

const DB_NAME = 'deepseek-chat'
const DB_VERSION = 2
const STORE_CONVERSATIONS = 'conversations'
const STORE_MEMORIES = 'memories'
const STORE_META = 'meta'

interface ChatDB extends DBSchema {
  conversations: {
    key: string
    value: Conversation
    indexes: { byUpdatedAt: number }
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

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

function getDB(): Promise<IDBPDatabase<ChatDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ChatDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          const store = db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' })
          store.createIndex('byUpdatedAt', 'updatedAt')
        }
        if (!db.objectStoreNames.contains(STORE_MEMORIES)) {
          const store = db.createObjectStore(STORE_MEMORIES, { keyPath: 'id' })
          store.createIndex('byUpdatedAt', 'updatedAt')
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META)
        }
      },
    })
  }
  return dbPromise
}

export async function loadConversationsFromDB(): Promise<Conversation[]> {
  const db = await getDB()
  const all = await db.getAll(STORE_CONVERSATIONS)
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putConversation(c: Conversation): Promise<void> {
  const db = await getDB()
  await db.put(STORE_CONVERSATIONS, c)
}

export async function deleteConversationFromDB(id: string): Promise<void> {
  const db = await getDB()
  await db.delete(STORE_CONVERSATIONS, id)
}

export async function clearConversationsInDB(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE_CONVERSATIONS)
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

/**
 * Оценка занятого места (Storage API) — показываем в настройках,
 * потому что картинки хранятся в истории как data URL.
 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}
