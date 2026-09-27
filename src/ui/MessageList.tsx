import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Conversation } from '@/types'
import { cn } from '@/lib/utils'
import { useSettings } from '@/lib/settings'
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
  busy: boolean
  onRegenerate: () => void
  onEdit: (messageId: string, text: string) => void
  onDelete: (messageId: string) => void
  onSuggestion: (text: string) => void
  onOpenSettings: () => void
}

export function MessageList({
  conversation,
  busy,
  onRegenerate,
  onEdit,
  onDelete,
  onSuggestion,
  onOpenSettings,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const showReasoning = useSettings((s) => s.settings.ui.showReasoning)
  const showToolActivity = useSettings((s) => s.settings.ui.showToolActivity)
  const messages = conversation?.messages ?? []
  const conversationId = conversation?.id

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
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

  if (!conversation || messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-4 py-10">
        <div className="text-center">
          <BrandMark size={56} className="mx-auto mb-3 rounded-2xl shadow-lg shadow-violet-500/20" />
          <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Чем помочь?</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
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
                className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3 text-left transition hover:border-blue-300 hover:bg-blue-50/60 dark:border-slate-700/70 dark:bg-slate-900/50 dark:hover:border-blue-500/60 dark:hover:bg-slate-800/60"
              >
                <span className="mt-0.5 text-blue-600 dark:text-blue-400">
                  <Icon size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
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
          className="text-xs text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
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
            'absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-slate-300 bg-white/95 p-2 text-slate-600 shadow-lg backdrop-blur transition hover:bg-white dark:border-slate-600 dark:bg-slate-800/95 dark:text-slate-200',
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

