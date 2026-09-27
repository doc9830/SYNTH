import { create } from 'zustand'
import type { ChatMessage } from '@/types'

/**
 * Кадр стрима: ещё не завершённый ответ ассистента.
 *
 * Живёт отдельно от стора чатов. Если писать каждый кадр в `conversations`,
 * меняется ссылка на список чатов — и перерисовывается всё приложение
 * (сайдбар, шапка, весь список сообщений). Здесь же обновляется только тот
 * блок сообщения, который печатается прямо сейчас.
 */
export interface StreamDraft {
  conversationId: string
  messageId: string
  /** Незакрытые поля сообщения: content, reasoning, toolCalls, usage, status… */
  patch: Partial<ChatMessage>
}

interface StreamDraftState {
  draft: StreamDraft | null
}

export const useStreamDraft = create<StreamDraftState>(() => ({ draft: null }))

/** Опубликовать кадр стрима (вызывается из `useChat`, вне React). */
export function publishStreamDraft(
  conversationId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): void {
  useStreamDraft.setState({ draft: { conversationId, messageId, patch } })
}

/** Убрать черновик: ход завершился, финал уже в списке сообщений. */
export function clearStreamDraft(messageId?: string): void {
  const current = useStreamDraft.getState().draft
  if (!current) return
  if (messageId && current.messageId !== messageId) return
  useStreamDraft.setState({ draft: null })
}

/**
 * Селектор для компонента сообщения: патч только для «своего» id.
 * Всем остальным возвращается один и тот же `null` — лишних рендеров нет.
 */
export function selectStreamPatch(
  messageId: string,
): (state: StreamDraftState) => Partial<ChatMessage> | null {
  return (state) => (state.draft && state.draft.messageId === messageId ? state.draft.patch : null)
}
