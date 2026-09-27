import { useCallback, useRef, useState } from 'react'
import type { ChatMessage, ImageAttachment } from '@/types'
import { runAgent } from './agent'
import { persistStreamSnapshot, useConversations } from './conversations'
import { autoExtractMemories, parseRememberCommand, remember, shouldExtract } from './memory'
import { getSettings, type Settings } from './settings'
import { clearStreamDraft, publishStreamDraft } from './streamDraft'
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
 * Не чаще раза в 0.7 с сохраняем черновик стрима в БД (страховка от kill):
 * в стор сообщений кадры больше не пишутся, а частичный текст терять не хочется.
 * 0.7 с — та же частота, с какой раньше дебаунсился setMessages.
 */
const SNAPSHOT_INTERVAL_MS = 700

/** Поля черновика, которые уезжают в сообщение: и в кадр стрима, и в финал хода. */
function draftFields(draft: AssistantDraft): Partial<ChatMessage> {
  return {
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
  /** Когда последний раз черновик стрима сохранялся в БД (см. SNAPSHOT_INTERVAL_MS) */
  const snapshotAtRef = useRef(0)

  /**
   * Публикация кадра стрима.
   *
   * Кадр уходит в отдельный маленький стор (`streamDraft`), а НЕ в список
   * сообщений: иначе на каждый чанк менялась бы ссылка `conversations` — и
   * вместе с ней перерисовывались сайдбар, шапка и весь список сообщений.
   *
   * Список чатов пересортировывается только в терминальном состоянии хода
   * (см. `commitTurn`).
   */
  const flushDraft = useCallback((conversationId: string, assistantId: string) => {
    const draft = draftRef.current
    if (!draft) return
    const fields = draftFields(draft)
    publishStreamDraft(conversationId, assistantId, fields)

    const now = Date.now()
    if (now - snapshotAtRef.current < SNAPSHOT_INTERVAL_MS) return
    snapshotAtRef.current = now
    persistStreamSnapshot(conversationId, assistantId, fields)
  }, [])

  /**
   * Терминальное состояние хода: единственная запись финала в список сообщений
   * (завершён / ошибка / отменён) — здесь же пересортировка списка чатов.
   */
  const commitTurn = useCallback(
    (conversationId: string, assistantId: string, draft: AssistantDraft) => {
      const store = useConversations.getState()
      if (!store.conversations.some((c) => c.id === conversationId)) return
      const current = store.messages[conversationId] ?? []
      const fields = draftFields(draft)
      const messages = current.map((m) => (m.id === assistantId ? { ...m, ...fields } : m))
      // immediate: финал сразу в IndexedDB, без дебаунса
      store.setMessages(conversationId, messages, true)
      clearStreamDraft(assistantId)
    },
    [],
  )

  /** Дописывает текст стрима в черновик (в UI попадает через `flushDraft`, в стор чатов — только в финале хода). */
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
      snapshotAtRef.current = 0
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
      try {
        // Ход перешёл в терминальное состояние: финал в стор + сразу в IndexedDB.
        commitTurn(conversationId, assistantId, draft)

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
      } finally {
        // Черновик живёт только пока идёт ход: не оставляем «висящий» кадр,
        // если разбор памяти или запись в стор упали.
        clearStreamDraft(assistantId)
        draftRef.current = null
        abortRef.current = null
        snapshotAtRef.current = 0
        setIsStreaming(false)
      }
    },
    [flushDraft, commitTurn, patchAssistant, appendDraft, closeThinking, cancelPendingFlush],
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

      // сообщения чата могли ещё не загрузиться (леневая загрузка из IndexedDB)
      const loaded = await useConversations.getState().ensureMessages(conversationId)
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
      const history = [...loaded, userMessage]

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
    if (!store.activeId) return
    const messages = await store.ensureMessages(store.activeId)

    const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user')
    if (lastUserIndex === -1) return

    const history = messages.slice(0, lastUserIndex + 1)
    const assistantMessage = emptyAssistant(uid('msg'))
    store.setMessages(store.activeId, [...history, assistantMessage], true)
    await runTurn(store.activeId, history, assistantMessage.id)
  }, [isStreaming, runTurn])

  /** Изменить текст сообщения пользователя и перезапустить ответ. */
  const editAndResend = useCallback(
    async (messageId: string, newText: string) => {
      if (isStreaming) return
      const store = useConversations.getState()
      const conversationId = store.activeId
      if (!conversationId || !newText.trim()) return
      const messages = await store.ensureMessages(conversationId)

      const index = messages.findIndex((m) => m.id === messageId)
      if (index === -1) return

      const updated: ChatMessage = { ...messages[index], content: newText.trim() }
      const history = [...messages.slice(0, index), updated]
      const assistantMessage = emptyAssistant(uid('msg'))
      store.setMessages(conversationId, [...history, assistantMessage], true)
      await runTurn(conversationId, history, assistantMessage.id)
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

