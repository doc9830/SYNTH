import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatMessage, Conversation } from '@/types'
import { cn } from '@/lib/utils'
import { useSettings } from '@/lib/settings'
import { useStreamDraft } from '@/lib/streamDraft'
import { IconChevronDown, IconGlobe, IconImage, IconSparkles } from './icons'
import { BrandMark } from './BrandMark'
import { MessageItem } from './MessageItem'

const SUGGESTIONS: Array<{ icon: 'sparkles' | 'globe' | 'image'; title: string; text: string }> = [
  {
    icon: 'sparkles',
    title: 'Объяснить сложное просто',
    text: 'Объясни простыми словами, как работает HTTPS, и приведи бытовую аналогию.',
  },
  {
    icon: 'globe',
    title: 'Поискать в интернете',
    text: 'Найди в интернете и кратко перескажи главные новости технологий за последние сутки.',
  },
  {
    icon: 'image',
    title: 'Сгенерировать картинку',
    text: 'Сгенерируй иллюстрацию: минималистичный логотип для приложения заметок, синий градиент, плоский стиль.',
  },
  {
    icon: 'sparkles',
    title: 'Помочь с кодом',
    text: 'Напиши на TypeScript функцию debounce с типами и объясни, как её использовать в React.',
  },
]

const SUGGESTION_ICONS = {
  sparkles: IconSparkles,
  globe: IconGlobe,
  image: IconImage,
}

interface MessageListProps {
  conversation: Conversation | undefined
  /** Сообщения открытого чата (грузятся лениво, отдельно от обёртки чата) */
  messages: ChatMessage[]
  /** Сообщения ещё читаются из IndexedDB */
  loading: boolean
  busy: boolean
  onRegenerate: () => void
  onEdit: (messageId: string, text: string) => void
  onDelete: (messageId: string) => void
  onSuggestion: (text: string) => void
  onOpenSettings: () => void
}

export function MessageList({
  conversation,
  messages,
  loading,
  busy,
  onRegenerate,
  onEdit,
  onDelete,
  onSuggestion,
  onOpenSettings,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** То же значение, но для подписки на кадры стрима — без переподписки на каждый рендер */
  const atBottomRef = useRef(true)
  const showReasoning = useSettings((s) => s.settings.ui.showReasoning)
  const showToolActivity = useSettings((s) => s.settings.ui.showToolActivity)
  const conversationId = conversation?.id

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }

  // при смене чата — сразу к низу, без анимации
  useLayoutEffect(() => {
    if (!conversationId) return
    scrollToBottom('auto')
    setAtBottom(true)
  }, [conversationId])

  // автопрокрутка при стриминге, если пользователь не отлистал историю вверх
  useEffect(() => {
    if (atBottom) scrollToBottom('auto')
  }, [messages, atBottom])

  /**
   * Кадры стрима идут не через стор сообщений, а отдельным потоком
   * (`streamDraft`) — подписываемся на него напрямую, чтобы список не
   * перерисовывался на каждый чанк, но прокрутка продолжала следовать за текстом.
   */
  useEffect(() => {
    if (!conversationId) return undefined
    return useStreamDraft.subscribe((state) => {
      if (!state.draft || state.draft.conversationId !== conversationId) return
      if (atBottomRef.current) scrollToBottom('auto')
    })
  }, [conversationId])

  // сообщения ещё едут из базы — «чем помочь?» показывать рано, иначе экран мигнёт
  if (loading && !messages.length) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <span className="text-sm text-neutral-500 dark:text-neutral-400">Загружаю историю…</span>
      </div>
    )
  }

  if (!conversation || messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-10">
        <div className="text-center">
          <BrandMark size={56} className="mx-auto mb-3 rounded-2xl shadow-lg" />
          <h1 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">Чем помочь?</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Модель умеет искать в интернете и рисовать картинки — просто попросите.
          </p>
        </div>

        <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => {
            const Icon = SUGGESTION_ICONS[s.icon]
            return (
              <button
                key={s.title}
                type="button"
                onClick={() => onSuggestion(s.text)}
                className="flex items-start gap-3 rounded-2xl border border-neutral-200 bg-white/70 p-3 text-left transition hover:border-neutral-300 hover:bg-neutral-100/70 dark:border-neutral-700/70 dark:bg-neutral-900/50 dark:hover:border-neutral-600 dark:hover:bg-neutral-800/60"
              >
                <span className="mt-0.5 text-neutral-500 dark:text-neutral-400">
                  <Icon size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                    {s.text}
                  </span>
                </span>
              </button>
            )
          })}
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          className="text-xs text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
        >
          Настроить подключение и инструменты (API key, модель, поиск)
        </button>
      </div>
    )
  }

  const lastMessageId = messages[messages.length - 1]?.id

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-3 py-4 sm:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 pb-6">
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              busy={busy}
              isLast={m.id === lastMessageId}
              showReasoning={showReasoning}
              showToolActivity={showToolActivity}
              onRegenerate={onRegenerate}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            scrollToBottom()
            setAtBottom(true)
          }}
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-neutral-300 bg-white/95 p-2 text-neutral-600 shadow-lg backdrop-blur transition hover:bg-white dark:border-neutral-600 dark:bg-neutral-800/95 dark:text-neutral-200',
            busy && 'animate-pulse',
          )}
          title="К последнему сообщению"
          aria-label="К последнему сообщению"
        >
          <IconChevronDown size={18} />
        </button>
      )}
    </div>
  )
}

