import { useCallback, useRef, useState } from 'react'
import type { ChatMessage, ImageAttachment } from '@/types'
import { runAgent } from './agent'
import { useConversations } from './conversations'
import { autoExtractMemories, parseRememberCommand, remember, shouldExtract } from './memory'
import { getSettings, type Settings } from './settings'
import { notify } from './toast'
import { uid } from './utils'

interface AssistantDraft {
  content: string
  reasoning: string
  /** Сколько модель размышляла (мс) — показываем в свёрнутом блоке мыслей */
  reasoningMs?: number
  toolCalls: NonNullable<ChatMessage['toolCalls']>
  model?: string
  usage?: ChatMessage['usage']
  status: ChatMessage['status']
  error?: string
  errorDetails?: string
}

function newDraft(): AssistantDraft {
  return { content: '', reasoning: '', toolCalls: [], status: 'streaming' }
}

function emptyAssistant(id: string): ChatMessage {
  return { id, role: 'assistant', createdAt: Date.now(), content: '', status: 'streaming' }
}

/**
 * Оркестрация чата: отправка, стриминг, tool loop, остановка,
 * regenerate и редактирование сообщений.
 */
export function useChat() {
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const draftRef = useRef<AssistantDraft | null>(null)
  const rafRef = useRef<number | null>(null)
  const timeoutRef = useRef<number | null>(null)
  /** Сколько суммарно модель размышляла (мс) — суммируем отрезки между tool-вызовами */
  const reasoningMsRef = useRef(0)
  /** Начало текущего отрезка размышлений */
  const reasoningStartedRef = useRef<number | null>(null)

  /** Переносит текущий черновик ассистента в стор (без записи в БД). */
  const flushDraft = useCallback((conversationId: string, assistantId: string) => {
    const draft = draftRef.current
    const store = useConversations.getState()
    const conv = store.conversations.find((c) => c.id === conversationId)
    if (!conv || !draft) return
    const messages = conv.messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            content: draft.content,
            reasoning: draft.reasoning,
            reasoningMs: draft.reasoningMs,
            toolCalls: draft.toolCalls,
            model: draft.model,
            usage: draft.usage,
            status: draft.status,
            error: draft.error,
            errorDetails: draft.errorDetails,
          }
        : m,
    )
    store.setMessages(conversationId, messages)
  }, [])

  /** Дописывает текст стрима в черновик (в стор попадает через flushDraft). */
  const appendDraft = useCallback((field: 'content' | 'reasoning', text: string) => {
    const draft = draftRef.current
    if (!draft) return
    if (field === 'content') draft.content += text
    else draft.reasoning += text
  }, [])

  /** Отменяет отложенную отрисовку черновика (перед финальной записью). */
  const cancelPendingFlush = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  /** Слияние патча в черновик с отложенной отрисовкой (раз в кадр). */
  const patchAssistant = useCallback(
    (conversationId: string, assistantId: string, patch: Partial<AssistantDraft>) => {
      if (draftRef.current) Object.assign(draftRef.current, patch)
      if (rafRef.current !== null || timeoutRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        flushDraft(conversationId, assistantId)
      })
      // Страховка: в фоновой вкладке и в неактивном WebView rAF не срабатывает —
      // гарантируем живое обновление текста не реже ~8 раз в секунду.
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = null
        }
        flushDraft(conversationId, assistantId)
      }, 120)
    },
    [flushDraft],
  )

  /** Закрывает текущий отрезок размышлений: пошёл текст ответа или вызов инструмента. */
  const closeThinking = useCallback(() => {
    if (reasoningStartedRef.current !== null) {
      reasoningMsRef.current += Date.now() - reasoningStartedRef.current
      reasoningStartedRef.current = null
    }
  }, [])

  const runTurn = useCallback(
    async (conversationId: string, history: ChatMessage[], assistantId: string) => {
      const settings: Settings = getSettings()
      const controller = new AbortController()
      abortRef.current = controller
      draftRef.current = newDraft()
      reasoningMsRef.current = 0
      reasoningStartedRef.current = null
      setIsStreaming(true)

      const result = await runAgent({
        history,
        settings,
        signal: controller.signal,
        callbacks: {
          onDelta: (t) => {
            closeThinking()
            appendDraft('content', t)
            patchAssistant(conversationId, assistantId, { reasoningMs: reasoningMsRef.current })
          },
          onReasoning: (t) => {
            if (reasoningStartedRef.current === null) reasoningStartedRef.current = Date.now()
            appendDraft('reasoning', t)
            patchAssistant(conversationId, assistantId, {})
          },
          onTools: (records) => {
            closeThinking()
            patchAssistant(conversationId, assistantId, {
              toolCalls: records,
              reasoningMs: reasoningMsRef.current,
            })
          },
          onModel: (m) => patchAssistant(conversationId, assistantId, { model: m }),
          onUsage: (u) => patchAssistant(conversationId, assistantId, { usage: u }),
        },
      })

      cancelPendingFlush()

      const status: ChatMessage['status'] = result.error
        ? 'error'
        : result.stopped
          ? 'stopped'
          : 'complete'

      closeThinking()
      const draft: AssistantDraft = {
        content: result.content,
        reasoning: result.reasoning,
        reasoningMs: reasoningMsRef.current || undefined,
        toolCalls: result.toolCalls,
        model: result.model ?? settings.model,
        usage: result.usage !== undefined ? result.usage : undefined,
        status,
        error: result.error
          ? [result.error.message, result.error.hint].filter(Boolean).join('\n\n')
          : undefined,
        errorDetails: result.error
          ? JSON.stringify(
              {
                status: result.error.status,
                endpoint: result.error.endpoint,
                code: result.error.code,
                details: result.error.details,
              },
              null,
              2,
            )
          : undefined,
      }
      draftRef.current = draft
      flushDraft(conversationId, assistantId)

      // финальное состояние — сразу в IndexedDB
      const store = useConversations.getState()
      const conv = store.conversations.find((c) => c.id === conversationId)
      if (conv) store.setMessages(conversationId, conv.messages, true)

      // Долговременная память: фоновый разбор хода отдельным нестримовым запросом.
      // Ошибки внутри глушатся — на чат это никак не влияет.
      if (result.content && !result.error && shouldExtract(settings, history)) {
        void autoExtractMemories({
          settings,
          conversationId,
          messages: [
            ...history,
            {
              id: `${assistantId}-extract`,
              role: 'assistant',
              createdAt: Date.now(),
              content: result.content,
              status: 'complete',
            },
          ],
        })
      }

      draftRef.current = null
      abortRef.current = null
      setIsStreaming(false)
    },
    [flushDraft, patchAssistant, appendDraft, closeThinking, cancelPendingFlush],
  )

  /** Отправить сообщение (при необходимости создаёт новый чат). */
  const send = useCallback(
    async (text: string, attachments: ImageAttachment[] = []) => {
      if (isStreaming) return
      const settings = getSettings()
      let conversationId = useConversations.getState().activeId

      if (
        !conversationId ||
        !useConversations.getState().conversations.some((c) => c.id === conversationId)
      ) {
        conversationId = useConversations.getState().create({ model: settings.model }).id
      }

      const conv = useConversations.getState().conversations.find((c) => c.id === conversationId)
      if (!conv) return

      // Команда «запомни, что …» — пишем в память детерминированно, без модели.
      // Сообщение всё равно уходит в чат: склейка похожих записей не даст дубля.
      if (settings.memory.enabled) {
        const command = parseRememberCommand(text)
        if (command) {
          void remember(command, { source: 'user', conversationId }).then((entry) => {
            notify(
              entry ? `Запомнил: ${entry.text}` : 'Похоже на секрет — в память не записываю',
              entry ? 'success' : 'error',
            )
          })
        }
      }

      const userMessage: ChatMessage = {
        id: uid('msg'),
        role: 'user',
        createdAt: Date.now(),
        content: text.trim(),
        attachments: attachments.length ? attachments : undefined,
        status: 'complete',
      }
      const assistantMessage = emptyAssistant(uid('msg'))
      const history = [...conv.messages, userMessage]

      useConversations.getState().setMessages(conversationId, [...history, assistantMessage], true)
      await runTurn(conversationId, history, assistantMessage.id)
    },
    [isStreaming, runTurn],
  )

  /** Прервать генерацию (запрос и выполняющийся инструмент). */
  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  /** Сгенерировать ответ заново для последнего сообщения пользователя. */
  const regenerate = useCallback(async () => {
    if (isStreaming) return
    const store = useConversations.getState()
    const conv = store.conversations.find((c) => c.id === store.activeId)
    if (!conv) return

    const lastUserIndex = conv.messages.map((m) => m.role).lastIndexOf('user')
    if (lastUserIndex === -1) return

    const history = conv.messages.slice(0, lastUserIndex + 1)
    const assistantMessage = emptyAssistant(uid('msg'))
    store.setMessages(conv.id, [...history, assistantMessage], true)
    await runTurn(conv.id, history, assistantMessage.id)
  }, [isStreaming, runTurn])

  /** Изменить текст сообщения пользователя и перезапустить ответ. */
  const editAndResend = useCallback(
    async (messageId: string, newText: string) => {
      if (isStreaming) return
      const store = useConversations.getState()
      const conv = store.conversations.find((c) => c.id === store.activeId)
      if (!conv) return

      const index = conv.messages.findIndex((m) => m.id === messageId)
      if (index === -1 || !newText.trim()) return

      const updated: ChatMessage = { ...conv.messages[index], content: newText.trim() }
      const history = [...conv.messages.slice(0, index), updated]
      const assistantMessage = emptyAssistant(uid('msg'))
      store.setMessages(conv.id, [...history, assistantMessage], true)
      await runTurn(conv.id, history, assistantMessage.id)
    },
    [isStreaming, runTurn],
  )

  /** Удалить сообщение из истории. */
  const removeMessage = useCallback((messageId: string) => {
    const store = useConversations.getState()
    if (store.activeId) store.removeMessage(store.activeId, messageId)
  }, [])

  return { send, stop, regenerate, editAndResend, removeMessage, isStreaming }
}

