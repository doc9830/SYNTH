import { create } from 'zustand'
import type { ChatMessage, Conversation } from '@/types'
import {
  clearConversationsInDB,
  deleteConversationFromDB,
  loadConversationsFromDB,
  putConversation,
} from './db'
import { deriveTitle, uid } from './utils'

const ORDER = (a: Conversation, b: Conversation): number => {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return b.updatedAt - a.updatedAt
}

/** Дебаунс записи в IndexedDB во время стриминга. */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleWrite(conversation: Conversation, delay = 700): void {
  const prev = pendingWrites.get(conversation.id)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    pendingWrites.delete(conversation.id)
    void putConversation(conversation)
  }, delay)
  pendingWrites.set(conversation.id, timer)
}

function flushWrite(conversation: Conversation): void {
  const prev = pendingWrites.get(conversation.id)
  if (prev) {
    clearTimeout(prev)
    pendingWrites.delete(conversation.id)
  }
  void putConversation(conversation)
}

interface ConversationsState {
  conversations: Conversation[]
  activeId: string | null
  loaded: boolean
  load: () => Promise<void>
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
  activeId: null,
  loaded: false,

  load: async () => {
    const conversations = await loadConversationsFromDB()
    set((s) => ({
      conversations,
      loaded: true,
      // восстанавливаем последний открытый чат
      activeId: s.activeId && conversations.some((c) => c.id === s.activeId)
        ? s.activeId
        : (conversations[0]?.id ?? null),
    }))
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
      messages: [],
    }
    set((s) => ({
      conversations: [conversation, ...s.conversations],
      activeId: conversation.id,
    }))
    flushWrite(conversation)
    return conversation
  },

  select: (id) => set({ activeId: id }),

  remove: async (id) => {
    const { conversations, activeId } = get()
    const remaining = conversations.filter((c) => c.id !== id)
    set({
      conversations: remaining,
      activeId: activeId === id ? (remaining[0]?.id ?? null) : activeId,
    })
    const timer = pendingWrites.get(id)
    if (timer) {
      clearTimeout(timer)
      pendingWrites.delete(id)
    }
    await deleteConversationFromDB(id)
  },

  rename: (id, title) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next = { ...conv, title: title.trim() || 'Без названия', updatedAt: Date.now() }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    flushWrite(next)
  },

  togglePin: (id) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next = { ...conv, pinned: !conv.pinned }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    flushWrite(next)
  },

  /**
   * Полная замена сообщений чата.
   *
   * Вызывается только на «настоящих» изменениях списка: старт хода,
   * терминальное состояние хода, удаление сообщения. Кадры стрима сюда не
   * попадают (они живут в `streamDraft`), поэтому сортировка списка чатов
   * выполняется один-два раза за ход, а не на каждый чанк.
   */
  setMessages: (id, messages, immediate = false) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const firstUser = messages.find((m) => m.role === 'user')
    const next: Conversation = {
      ...conv,
      messages,
      updatedAt: Date.now(),
      title:
        conv.title === 'Новый чат' && firstUser
          ? deriveTitle(firstUser.content)
          : conv.title,
    }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    if (immediate) flushWrite(next)
    else scheduleWrite(next)
  },

  patchConversation: (id, patch, immediate = false) => {
    const conv = get().conversations.find((c) => c.id === id)
    if (!conv) return
    const next = { ...conv, ...patch }
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(ORDER),
    }))
    if (immediate) flushWrite(next)
    else scheduleWrite(next)
  },

  removeMessage: (conversationId, messageId) => {
    const conv = get().conversations.find((c) => c.id === conversationId)
    if (!conv) return
    const messages = conv.messages.filter((m) => m.id !== messageId)
    get().setMessages(conversationId, messages, true)
  },

  deleteAll: async () => {
    set({ conversations: [], activeId: null })
    await clearConversationsInDB()
  },
}))

export function useActiveConversation(): Conversation | undefined {
  return useConversations((s) =>
    s.activeId ? s.conversations.find((c) => c.id === s.activeId) : undefined,
  )
}

/**
 * Снимок стрим-черновика прямо в БД, минуя стор.
 *
 * Во время стрима список чатов намеренно не обновляется (см. `streamDraft.ts`):
 * иначе каждый кадр менял бы ссылку `conversations` и тянул за собой рендер
 * сайдбара и шапки. Чтобы не терять частичный ответ при убийстве приложения,
 * черновик изредка пишется в IndexedDB отдельной записью. Список чатов при
 * этом не сортируется — сортировка одна на ход, в терминальном состоянии.
 */
export function persistStreamSnapshot(
  conversationId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): void {
  const conv = useConversations.getState().conversations.find((c) => c.id === conversationId)
  if (!conv) return
  const messages = conv.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m))
  scheduleWrite({ ...conv, messages, updatedAt: Date.now() })
}
