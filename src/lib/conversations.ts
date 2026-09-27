import { create } from 'zustand'
import type { ChatMessage, Conversation, MessageRecord } from '@/types'
import {
  clearConversationsInDB,
  dbStats,
  deleteConversationFromDB,
  deleteMessageRecords,
  loadConversationsFromDB,
  loadMessagesFromDB,
  putConversationRecord,
  putMessageRecords,
} from './db'
import { diffMessages, lightMessage, messageRecord, wrapperOf } from './dbModel'
import { debugLog } from './debug'
import { useStreamDraft } from './streamDraft'
import { notify } from './toast'
import { deriveTitle, uid } from './utils'

const ORDER = (a: Conversation, b: Conversation): number => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.updatedAt - a.updatedAt
}

/**
 * Сколько чатов держим в памяти целиком.
 *
 * Сообщения грузятся лениво, по открытому чату. Держать их все нельзя: именно
 * из-за этого раньше старт и любая правка тащили за собой всю историю.
 * Два-три последних чата оставляем, чтобы возврат к предыдущему был мгновенным.
 */
const MAX_LOADED_CHATS = 3

/** Чаты, сообщения которых сейчас читаются из базы (защита от двойной загрузки) */
const loading = new Map<string, Promise<void>>()
/** Порядок последних загруженных чатов: последний — самый свежий (LRU) */
let loadedOrder: string[] = []

/**
 * Дебаунс записи в IndexedDB: ключ записи → таймер.
 * Ключи вида `conv:<id>`, `msg:<id>` и `msgs:<id>` — правка одного сообщения
 * больше не переписывает весь чат.
 */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Отложенные записи сообщений по чатам.
 * Важно объединять, а не отменять: иначе правка сообщения A, за которой
 * через 300 мс пришёл финал хода по сообщению B, потеряла бы запись A.
 */
const pendingMessages = new Map<string, { puts: Map<string, MessageRecord>; deletes: Set<string> }>()

function pendingFor(conversationId: string): { puts: Map<string, MessageRecord>; deletes: Set<string> } {
  const existing = pendingMessages.get(conversationId)
  if (existing) return existing
  const created = { puts: new Map<string, MessageRecord>(), deletes: new Set<string>() }
  pendingMessages.set(conversationId, created)
  return created
}

function runWrite(key: string, delay: number, write: () => void): void {
  const prev = pendingWrites.get(key)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    pendingWrites.delete(key)
    write()
  }, delay)
  pendingWrites.set(key, timer)
}

function cancelWrite(key: string): void {
  const prev = pendingWrites.get(key)
  if (prev) {
    clearTimeout(prev)
    pendingWrites.delete(key)
  }
}

function cancelAllWrites(): void {
  for (const timer of pendingWrites.values()) clearTimeout(timer)
  pendingWrites.clear()
  pendingMessages.clear()
}

/** Обёртка чата: пишем только её (сообщения — отдельными записями). */
function writeConversation(conversation: Conversation, immediate: boolean): void {
  const key = `conv:${conversation.id}`
  const write = () => {
    // чат мог быть удалён, пока таймер тикал
    if (!useConversations.getState().conversations.some((c) => c.id === conversation.id)) return
    void putConversationRecord(conversation)
  }
  if (immediate) {
    cancelWrite(key)
    write()
    return
  }
  runWrite(key, 700, write)
}

/** Сброс накопленных записей и удалений сообщений одного чата. */
function flushMessages(conversationId: string): void {
  const pending = pendingMessages.get(conversationId)
  if (!pending) return
  pendingMessages.delete(conversationId)
  if (!useConversations.getState().conversations.some((c) => c.id === conversationId)) return
  if (pending.puts.size) void putMessageRecords([...pending.puts.values()])
  if (pending.deletes.size) void deleteMessageRecords([...pending.deletes])
}

/** Изменившиеся сообщения — по одной записи каждое. */
function writeMessages(conversationId: string, records: MessageRecord[], immediate: boolean): void {
  if (!records.length) return
  const pending = pendingFor(conversationId)
  for (const record of records) {
    pending.deletes.delete(record.id)
    pending.puts.set(record.id, record)
  }
  const key = `msgs:${conversationId}`
  if (immediate) {
    cancelWrite(key)
    flushMessages(conversationId)
    return
  }
  runWrite(key, 700, () => flushMessages(conversationId))
}

function deleteMessages(conversationId: string, ids: string[], immediate: boolean): void {
  if (!ids.length) return
  const pending = pendingFor(conversationId)
  for (const id of ids) {
    pending.puts.delete(id)
    pending.deletes.add(id)
  }
  const key = `msgs:${conversationId}`
  if (immediate) {
    cancelWrite(key)
    flushMessages(conversationId)
    return
  }
  runWrite(key, 700, () => flushMessages(conversationId))
}

/**
 * Чат, ответ которого печатается прямо сейчас.
 * Пока ход не завершён, его сообщения держим в памяти обязательно: финал хода
 * дописывается именно в них (см. `commitTurn` в useChat).
 */
function streamingConversationId(): string | null {
  return useStreamDraft.getState().draft?.conversationId ?? null
}

/** Сколько чатов держим в памяти и какие именно (LRU). */
function pruneLoadedMessages(keepId: string): string[] {
  const protectedId = streamingConversationId()
  loadedOrder = [...loadedOrder.filter((id) => id !== keepId), keepId]
  const dropped: string[] = []
  while (loadedOrder.length > MAX_LOADED_CHATS) {
    const candidate = loadedOrder.find((id) => id !== protectedId)
    if (!candidate) break
    loadedOrder = loadedOrder.filter((id) => id !== candidate)
    dropped.push(candidate)
  }
  return dropped
}

interface ConversationsState {
  /** Обёртки чатов — то, что видит сайдбар и шапка */
  conversations: Conversation[]
  /** Сообщения загруженных чатов (только несколько последних, см. MAX_LOADED_CHATS) */
  messages: Record<string, ChatMessage[]>
  /** Чаты, сообщения которых читаются из базы прямо сейчас */
  loadingMessages: Record<string, boolean>
  /** Ошибка чтения базы (например, миграция не прошла) — показываем пользователю */
  loadError: string | null
  activeId: string | null
  loaded: boolean
  load: () => Promise<void>
  /** Ленивая загрузка сообщений чата; повторные вызовы ждут первую */
  ensureMessages: (id: string) => Promise<ChatMessage[]>
  create: (opts?: { model?: string; title?: string }) => Conversation
  select: (id: string | null) => void
  remove: (id: string) => Promise<void>
  rename: (id: string, title: string) => void
  togglePin: (id: string) => void
  setMessages: (id: string, messages: ChatMessage[], immediate?: boolean) => void
  patchConversation: (id: string, patch: Partial<Conversation>, immediate?: boolean) => void
  removeMessage: (conversationId: string, messageId: string) => void
  deleteAll: () => Promise<void>
}

export const useConversations = create<ConversationsState>((set, get) => ({
  conversations: [],
  messages: {},
  loadingMessages: {},
  loadError: null,
  activeId: null,
  loaded: false,

  load: async () => {
    try {
      const conversations = await loadConversationsFromDB()
      set((s) => ({
        conversations,
        loaded: true,
        loadError: null,
        // восстанавливаем последний открытый чат
        activeId: s.activeId && conversations.some((c) => c.id === s.activeId)
          ? s.activeId
          : (conversations[0]?.id ?? null),
      }))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const message = `Не удалось открыть историю чатов: ${reason}. Данные на месте — попробуйте перезапустить приложение.`
      set({ loaded: true, loadError: message })
      notify(message, 'error')
      return
    }

    // сообщения читаем только для открытого чата
    const activeId = get().activeId
    if (activeId) await get().ensureMessages(activeId)

    // след миграции в консоли диагностики: схема, число чатов и сообщений
    try {
      const stats = await dbStats()
      debugLog('info', 'IndexedDB', [
        `схема: ${stats.schema ?? '—'}`,
        `чатов: ${stats.conversations}`,
        `сообщений: ${stats.messages}`,
        `записей старого формата: ${stats.legacyConversations}`,
      ])
    } catch {
      /* диагностика не должна мешать запуску */
    }
  },

  /** Ленивая загрузка сообщений чата: в память попадает только он. */
  ensureMessages: async (id) => {
    const cached = get().messages[id]
    if (cached) return cached

    const inFlight = loading.get(id)
    if (inFlight) {
      await inFlight
      return get().messages[id] ?? []
    }

    const promise = (async () => {
      try {
        const messages = await loadMessagesFromDB(id)
        const dropped = pruneLoadedMessages(id)
        set((s) => {
          const nextMessages = { ...s.messages, [id]: messages }
          for (const gone of dropped) delete nextMessages[gone]
          const nextLoading = { ...s.loadingMessages }
          delete nextLoading[id]
          return { messages: nextMessages, loadingMessages: nextLoading }
        })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        set((s) => {
          const nextLoading = { ...s.loadingMessages }
          delete nextLoading[id]
          return { loadingMessages: nextLoading }
        })
        notify(`Не удалось прочитать сообщения чата: ${reason}`, 'error')
      } finally {
        loading.delete(id)
      }
    })()

    loading.set(id, promise)
    set((s) => ({ loadingMessages: { ...s.loadingMessages, [id]: true } }))
    await promise
    return get().messages[id] ?? []
  },

  create: (opts) => {
    const now = Date.now()
    const conversation: Conversation = {
      id: uid('conv'),
      title: opts?.title ?? 'Новый чат',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      model: opts?.model ?? '',
      preview: '',
      messageCount: 0,
    }
    loadedOrder = [...loadedOrder.filter((id) => id !== conversation.id), conversation.id]
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      messages: { ...s.messages, [conversation.id]: [] },
      activeId: conversation.id,
    }))
    writeConversation(conversation, true)
    return conversation
  },

  select: (id) => {
    set({ activeId: id })
    if (id) void get().ensureMessages(id)
  },

  remove: async (id) => {
    const { conversations, activeId, messages } = get()
    const remaining = conversations.filter((c) => c.id !== id)
    // отложенные записи удалённого чата не должны его воскресить
    cancelWrite(`conv:${id}`)
    cancelWrite(`msgs:${id}`)
    pendingMessages.delete(id)
    for (const message of messages[id] ?? []) cancelWrite(`msg:${message.id}`)
    loadedOrder = loadedOrder.filter((loaded) => loaded !== id)
    set((s) => {
      const nextMessages = { ...s.messages }
      delete nextMessages[id]
      return {
        conversations: remaining,
        messages: nextMessages,
        activeId: activeId === id ? (remaining[0]?.id ?? null) : activeId,
      }
    })
    await deleteConversationFromDB(id)
    const nextActive = get().activeId
    if (nextActive && nextActive !== id) void get().ensureMessages(nextActive)
  },

  rename: (id, title) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next: Conversation = { ...conv, title: title.trim() || 'Без названия', updatedAt: Date.now() }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    writeConversation(next, true)
  },

  togglePin: (id) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next: Conversation = { ...conv, pinned: !conv.pinned }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    writeConversation(next, true)
  },

  /**
   * Полная замена списка сообщений чата.
   *
   * В базу уходят только изменившиеся записи: сообщение, которого не касались,
   * остаётся тем же объектом — писать его не нужно. Обёртка чата обновляется
   * отдельно (подпись, число сообщений, время).
   *
   * Кадры стрима сюда не попадают (они живут в `streamDraft`), поэтому за ход
   * список обновляется один-два раза, а не на каждый чанк.
   */
  setMessages: (id, messages, immediate = false) => {
    const state = get()
    const conv = state.conversations.find((c) => c.id === id)
    if (!conv) return

    const previous = state.messages[id] ?? []
    const firstUser = messages.find((m) => m.role === 'user')
    const next = wrapperOf(
      {
        ...conv,
        title: conv.title === 'Новый чат' && firstUser ? deriveTitle(firstUser.content) : conv.title,
      },
      messages,
    )

    const dropped = pruneLoadedMessages(id)
    set((s) => {
      const nextMessages = { ...s.messages, [id]: messages }
      for (const gone of dropped) delete nextMessages[gone]
      return {
        conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
        messages: nextMessages,
      }
    })

    writeConversation(next, immediate)

    const { changed, removed } = diffMessages(id, previous, messages)
    writeMessages(id, changed, immediate)
    deleteMessages(id, removed, immediate)
  },

  patchConversation: (id, patch, immediate = false) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next: Conversation = { ...conv, ...patch }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    writeConversation(next, immediate)
  },

  removeMessage: (conversationId, messageId) => {
    const messages = get().messages[conversationId]
    if (!messages) return
    get().setMessages(
      conversationId,
      messages.filter((m) => m.id !== messageId),
      true,
    )
  },

  deleteAll: async () => {
    cancelAllWrites()
    loading.clear()
    loadedOrder = []
    set({ conversations: [], messages: {}, loadingMessages: {}, activeId: null })
    await clearConversationsInDB()
  },
}))

export function useActiveConversation(): Conversation | undefined {
  return useConversations((s) =>
    s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined,
  )
}

/** Сообщения конкретного чата: `undefined`, пока они не загружены. */
export function useConversationMessages(id: string | null | undefined): ChatMessage[] | undefined {
  return useConversations((s) => (id ? s.messages[id] : undefined))
}

/** Идёт ли чтение сообщений чата из IndexedDB. */
export function useMessagesLoading(id: string | null | undefined): boolean {
  return useConversations((s) => (id ? s.loadingMessages[id] === true : false))
}

/**
 * Снимок стрим-черновика прямо в БД, минуя стор.
 *
 * Во время стрима список чатов намеренно не обновляется (см. `streamDraft.ts`):
 * иначе каждый кадр менял бы ссылку `conversations` и тянул за собой рендер
 * сайдбара и шапки. Чтобы не терять частичный ответ при убийстве приложения,
 * черновик раз в ~0.7 с пишется ОДНОЙ записью — тем самым сообщением, которое
 * печатается. Тяжёлые поля инструментов в снимок не входят (см. `lightMessage`).
 */
export function persistStreamSnapshot(
  conversationId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): void {
  const state = useConversations.getState()
  if (!state.conversations.some((c) => c.id === conversationId)) return
  const messages = state.messages[conversationId] ?? []
  const order = messages.findIndex((m) => m.id === messageId)
  const base: ChatMessage =
    order === -1
      ? { id: messageId, role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming' }
      : { ...messages[order], ...patch }
  const record = lightMessage(
    messageRecord(conversationId, base, order === -1 ? messages.length : order),
  )
  runWrite(`msg:${messageId}`, 700, () => {
    if (!useConversations.getState().conversations.some((c) => c.id === conversationId)) return
    void putMessageRecords([record])
  })
}
