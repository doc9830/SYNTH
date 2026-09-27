import { useMemo, useState, type ReactNode } from 'react'
import { attachmentSrc } from '@/lib/attachments'
import { copyText } from '@/lib/clipboard'
import { exportMarkdown, filesFromMarkdown, joinedFileFromMarkdown, slugify } from '@/lib/shareFiles'
import { describeStreamPhase } from '@/lib/streamPhase'
import { selectStreamPatch, useStreamDraft } from '@/lib/streamDraft'
import { notify } from '@/lib/toast'
import { canSpeak, useSpeech } from '@/lib/useSpeech'
import { cn, formatTime, truncate } from '@/lib/utils'
import type { ChatMessage } from '@/types'
import {
  IconAlert,
  IconCheck,
  IconCopy,
  IconFileText,
  IconPencil,
  IconPlay,
  IconRefresh,
  IconShare,
  IconStop,
  IconTrash,
  IconVolume,
} from './icons'
import { BrandMark } from './BrandMark'
import { ImageGrid } from './ImageGrid'
import { Markdown } from './Markdown'
import { StreamStatus, ThinkingPanel } from './ThinkingPanel'
import { ToolActivity } from './ToolActivity'

export interface MessageItemProps {
  message: ChatMessage
  /** true, если генерация идёт прямо сейчас в активном чате */
  busy: boolean
  isLast: boolean
  showReasoning: boolean
  showToolActivity: boolean
  onRegenerate: () => void
  /** Дописать оборванный ответ с того места, где он остановился */
  onContinue: () => void
  onEdit: (messageId: string, text: string) => void
  onDelete: (messageId: string) => void
}

function ActionButton({
  title,
  onClick,
  disabled,
  children,
  danger,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-lg p-1.5 text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-100',
        danger && 'hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-950/60 dark:hover:text-red-300',
      )}
    >
      {children}
    </button>
  )
}

/**
 * «Продолжить» — заметная кнопка (не только по наведению): ответ оборвался
 * (обрыв сети, таймаут тишины, остановка пользователем), но текст уже есть,
 * и его можно дописать. Продолжение добавляется в то же сообщение.
 */
function ContinueButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-neutral-300 bg-white px-2.5 py-1.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
    >
      <IconPlay size={14} />
      Продолжить
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <ActionButton
      title="Скопировать"
      onClick={async () => {
        const ok = await copyText(text)
        if (!ok) {
          notify('Не удалось скопировать текст.', 'error')
          return
        }
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      }}
    >
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </ActionButton>
  )
}

/**
 * «Озвучить» / «Стоп»: читает ответ системным синтезом речи (задача 06).
 * Кнопки нет вовсе, если движка/русского голоса нет — вместо неработающей
 * кнопки пользователь один раз видит пояснение (см. useSpeech.ensureProbe).
 */
function SpeakButton({ message }: { message: ChatMessage }) {
  const info = useSpeech((s) => s.info)
  const status = useSpeech((s) => s.status)
  const speakingId = useSpeech((s) => s.messageId)
  const toggle = useSpeech((s) => s.toggle)
  if (!canSpeak(info)) return null

  const active = speakingId === message.id && status !== 'idle'
  return (
    <ActionButton
      title={active ? 'Остановить озвучку' : 'Озвучить ответ'}
      onClick={() => void toggle(message.id, message.content)}
    >
      {active ? <IconStop size={16} /> : <IconVolume size={16} />}
    </ActionButton>
  )
}

/**
 * Кнопки «поделиться» у сообщения: каждый блок кода — файлом, и рядом
 * («а не вместо») вариант «одним файлом». Нет блоков — кнопок нет:
 * пустой файл не создаём.
 */
function ShareButtons({ message }: { message: ChatMessage }) {
  const [busy, setBusy] = useState(false)
  const files = useMemo(() => filesFromMarkdown(message.content), [message.content])
  if (!files.length) return null

  const many = files.length > 1

  const share = async (all: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const base =
        slugify(files[0].name.replace(/\.[A-Za-z0-9]{1,8}$/, '')) ||
        (message.role === 'user' ? 'запрос' : 'ответ')
      const payload = all ? files : [joinedFileFromMarkdown(message.content, base)]
      const result = await exportMarkdown(payload)
      if (result.method === 'cancelled') return
      notify(result.message, result.ok ? 'success' : 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ActionButton
        title={many ? `Поделиться файлами (${files.length})` : 'Поделиться файлом'}
        disabled={busy}
        onClick={() => void share(true)}
      >
        <span className="flex items-center gap-0.5">
          <IconShare size={16} />
          {many && <span className="text-[11px] tabular-nums">{files.length}</span>}
        </span>
      </ActionButton>
      {many && (
        <ActionButton
          title="Поделиться одним файлом (.md)"
          disabled={busy}
          onClick={() => void share(false)}
        >
          <IconFileText size={16} />
        </ActionButton>
      )}
    </>
  )
}

/** Сообщение пользователя: пузырь справа + вложения + редактирование на месте. */
function UserMessage({
  message,
  busy,
  onEdit,
  onDelete,
}: Pick<MessageItemProps, 'message' | 'busy' | 'onEdit' | 'onDelete'>) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const attachments = message.attachments ?? []

  const save = () => {
    const text = draft.trim()
    if (!text) return
    setEditing(false)
    onEdit(message.id, text)
  }

  return (
    <div className="group flex justify-end">
      {/* Пузырь заметно уже колонки чтения: видно, что это сообщение справа,
          а не текст во всю ширину экрана. */}
      <div className="flex max-w-[min(34rem,86%)] flex-col items-end gap-1">
        {attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {attachments.map((a) => (
              <img
                key={a.id}
                src={attachmentSrc(a)}
                alt={a.name}
                title={a.name}
                className="max-h-40 w-auto rounded-xl border border-neutral-300/70 object-cover dark:border-neutral-700/70"
              />
            ))}
          </div>
        )}

        {editing ? (
          <div className="w-full min-w-[16rem] rounded-2xl border border-neutral-300 bg-white p-2 dark:border-neutral-600 dark:bg-neutral-900">
            <textarea
              autoFocus
              value={draft}
              rows={Math.min(12, Math.max(2, draft.split('\n').length))}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditing(false)
                  setDraft(message.content)
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  save()
                }
              }}
              className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-neutral-800 outline-none dark:text-neutral-100"
            />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setDraft(message.content)
                }}
                className="rounded-lg px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={save}
                className="rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
              >
                Сохранить и переспросить
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl rounded-br-md border border-neutral-200/80 bg-neutral-100 px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap text-neutral-900 dark:border-neutral-700/70 dark:bg-neutral-800 dark:text-neutral-50">
            {message.content || <span className="opacity-70">(только вложение)</span>}
          </div>
        )}

        {!editing && (
          <div className="flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <span className="mr-1 text-[11px] text-neutral-400">{formatTime(message.createdAt)}</span>
            <CopyButton text={message.content} />
            <ShareButtons message={message} />
            <ActionButton
              title="Изменить и переспросить"
              disabled={busy}
              onClick={() => {
                setDraft(message.content)
                setEditing(true)
              }}
            >
              <IconPencil size={16} />
            </ActionButton>
            <ActionButton title="Удалить сообщение" danger disabled={busy} onClick={() => onDelete(message.id)}>
              <IconTrash size={16} />
            </ActionButton>
          </div>
        )}
      </div>
    </div>
  )
}


/** Ответ ассистента: reasoning, инструменты, markdown, картинки, ошибки. */
function AssistantMessage({
  message,
  busy,
  isLast,
  showReasoning,
  showToolActivity,
  onRegenerate,
  onContinue,
  onDelete,
}: MessageItemProps) {
  const toolCalls = message.toolCalls ?? []
  /** Читаемый сейчас фрагмент этого сообщения — null, если читается другое. */
  const speakingKey = useSpeech((s) => (s.messageId === message.id ? s.chunkKey : null))
  const images = toolCalls.flatMap((t) => t.images ?? [])
  const streaming = message.status === 'streaming'
  const runningTool = toolCalls.some((t) => t.status === 'running')
  const reasoningText = (message.reasoning ?? '').trim()
  /** Что модель делает сейчас: «Думаю…», «Пишу код…», «Ищу в интернете…» */
  const phase = describeStreamPhase(message)
  /** Живая строка статуса — когда мыслей нет (или они скрыты), но работа идёт */
  const showStatus = streaming && (!reasoningText || !showReasoning) && !runningTool
  /**
   * Ответ оборвался (ошибка или остановка), но текст уже есть — его можно
   * дописать. Для ошибки без текста продолжать нечего: там уместно «Заново».
   */
  const canContinue =
    !streaming &&
    !runningTool &&
    Boolean(message.content.trim()) &&
    (message.status === 'stopped' || message.status === 'error')

  return (
    <div className="group flex gap-3">
      <BrandMark size={28} className="mt-0.5 rounded-[9px]" />

      <div className="min-w-0 flex-1">
        {showReasoning && reasoningText && (
          <ThinkingPanel
            text={message.reasoning ?? ''}
            streaming={streaming}
            label={phase.label}
            elapsedMs={message.reasoningMs}
            answerStarted={Boolean(message.content.trim())}
          />
        )}

        {showStatus && <StreamStatus label={phase.label} icon={phase.icon} />}

        {showToolActivity && <ToolActivity records={toolCalls} />}

        {message.content && <Markdown content={message.content} highlight={speakingKey} />}

        {streaming && message.content && (
          <span className="caret-blink ml-0.5 inline-block h-4 w-[2px] bg-neutral-400 align-middle dark:bg-neutral-500" />
        )}

        {images.length > 0 && <ImageGrid images={images} />}

        {message.status === 'error' && message.error && (
          <div className="mt-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
            <div className="mb-1 flex items-center gap-2 font-medium">
              <IconAlert size={16} />
              Не удалось получить ответ
            </div>
            <div className="whitespace-pre-wrap">{message.error}</div>
            {message.errorDetails && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-red-700/80 dark:text-red-200/80">
                  Технические детали
                </summary>
                <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-red-100/70 p-2 font-mono text-[11px] dark:bg-red-950/60">
                  {truncate(message.errorDetails, 4000)}
                </pre>
              </details>
            )}
          </div>
        )}

        {message.status === 'stopped' && (
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Генерация остановлена</div>
        )}

        {canContinue && <ContinueButton disabled={busy} onClick={onContinue} />}

        {(message.content || toolCalls.length > 0 || message.status !== 'streaming') && (
          <div className="mt-1 flex flex-wrap items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <span className="mr-1 text-[11px] text-neutral-400">
              {formatTime(message.createdAt)}
              {message.model ? ` · ${message.model}` : ''}
              {message.usage?.totalTokens ? ` · ${message.usage.totalTokens} токенов` : ''}
            </span>
            <CopyButton text={message.content} />
            {message.content.trim() !== '' && <SpeakButton message={message} />}
            <ShareButtons message={message} />
            <ActionButton
              title="Сгенерировать заново"
              disabled={busy || runningTool}
              onClick={onRegenerate}
            >
              <IconRefresh size={16} />
            </ActionButton>
            {!isLast && (
              <ActionButton
                title="Удалить сообщение"
                danger
                disabled={busy}
                onClick={() => onDelete(message.id)}
              >
                <IconTrash size={16} />
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export function MessageItem(props: MessageItemProps) {
  /**
   * Кадры стрима приходят отдельным потоком, а не через стор чатов: подписан
   * только тот блок, который печатается сейчас. Остальные сообщения видят
   * `null` и не перерисовываются.
   */
  const patch = useStreamDraft(selectStreamPatch(props.message.id))
  const message: ChatMessage = patch ? { ...props.message, ...patch } : props.message

  if (message.role === 'user') {
    return (
      <UserMessage
        message={message}
        busy={props.busy}
        onEdit={props.onEdit}
        onDelete={props.onDelete}
      />
    )
  }
  return <AssistantMessage {...props} message={message} />
}
