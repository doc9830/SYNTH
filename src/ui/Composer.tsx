import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileToAttachment, isImageFile } from '@/lib/attachments'
import { getModelCapabilities } from '@/lib/utils'
import { notify } from '@/lib/toast'
import type { ImageAttachment } from '@/types'
import { cn } from '@/lib/utils'
import { IconImage, IconPaperclip, IconSend, IconStop, IconUpload, IconX } from './icons'
import { Sheet } from './Sheet'

/** Черновики по чатам: переключение чата не должно терять набранный текст. */
const drafts = new Map<string, string>()

interface ComposerProps {
  conversationId: string | null
  busy: boolean
  /** можно ли отправлять (проверка настроек) */
  canSend: boolean
  disabledReason?: string
  toolsHint: string[]
  sendOnEnter: boolean
  model: string
  onSend: (text: string, attachments: ImageAttachment[]) => void
  onStop: () => void
}

export function Composer({
  conversationId,
  busy,
  canSend,
  disabledReason,
  toolsHint,
  sendOnEnter,
  model,
  onSend,
  onStop,
}: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const caps = getModelCapabilities(model)

  // подгрузка/сохранение черновика при переключении чата
  useEffect(() => {
    setText(conversationId ? (drafts.get(conversationId) ?? '') : '')
    setAttachments([])
  }, [conversationId])

  useEffect(() => {
    if (conversationId) drafts.set(conversationId, text)
  }, [conversationId, text])

  // автовысота textarea
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [text])

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return

    if (!caps.vision) {
      notify(
        `Модель ${model} не принимает изображения на вход. Выберите vision-модель в настройках (например, gemini-2.5-flash или gpt-4o).`,
        'error',
      )
      return
    }

    setAdding(true)
    try {
      for (const file of list.slice(0, 4)) {
        if (!isImageFile(file)) {
          notify(`Файл «${file.name}» не изображение (поддерживаются jpg, png, webp).`, 'error')
          continue
        }
        try {
          const attachment = await fileToAttachment(file)
          setAttachments((prev) => [...prev, attachment].slice(0, 4))
        } catch (err) {
          notify(err instanceof Error ? err.message : 'Не удалось обработать изображение.', 'error')
        }
      }
    } finally {
      setAdding(false)
    }
  }

  const submit = () => {
    const value = text.trim()
    if (!value || busy || !canSend) return
    onSend(value, attachments)
    setText('')
    setAttachments([])
    if (conversationId) drafts.set(conversationId, '')
    requestAnimationFrame(() => areaRef.current?.focus())
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const combo = sendOnEnter
      ? e.key === 'Enter' && !e.shiftKey
      : e.key === 'Enter' && (e.metaKey || e.ctrlKey)
    if (combo) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  return (
    <div
      className="relative border-t border-slate-200 bg-white/85 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-slate-800 dark:bg-slate-950/80 sm:px-6"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-blue-400 bg-blue-50/80 text-sm font-medium text-blue-700 dark:bg-blue-950/70 dark:text-blue-200">
          Отпустите, чтобы прикрепить изображение
        </div>
      )}

      <div className="mx-auto max-w-3xl">
        {!canSend && disabledReason && (
          <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
            {disabledReason}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div key={a.id} className="relative">
                <img
                  src={a.dataUrl}
                  alt={a.name}
                  className="h-16 w-16 rounded-xl border border-slate-300 object-cover dark:border-slate-700"
                />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-slate-900/85 p-0.5 text-white transition hover:bg-red-600"
                  aria-label="Убрать изображение"
                  title="Убрать изображение"
                >
                  <IconX size={13} />
                </button>
              </div>
            ))}
            {adding && <span className="self-center text-xs text-slate-500">Обработка…</span>}
          </div>
        )}

        <div
          className={cn(
            'flex items-end gap-2 rounded-2xl border bg-white p-2 shadow-sm transition dark:bg-slate-900',
            canSend
              ? 'border-slate-300 focus-within:border-blue-400 dark:border-slate-700 dark:focus-within:border-blue-500/70'
              : 'border-amber-300 dark:border-amber-900/60',
          )}
        >
          <button
            type="button"
            onClick={() => setAttachOpen(true)}
            disabled={!canSend}
            title={caps.vision ? 'Прикрепить изображение' : `Модель ${model} не поддерживает изображения на входе`}
            aria-label="Прикрепить изображение"
            className="rounded-xl p-2.5 text-slate-500 transition active:bg-slate-200/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-400 dark:active:bg-slate-800"
          >
            {caps.vision ? <IconPaperclip size={19} /> : <IconImage size={19} />}
          </button>

          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            placeholder={canSend ? 'Спросите что-нибудь…' : 'Сначала заполните настройки подключения'}
            disabled={!canSend}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="max-h-[260px] min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed dark:text-slate-100"
          />

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="Остановить генерацию"
              className="rounded-xl bg-slate-800 p-2 text-white transition hover:bg-slate-900 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
            >
              <IconStop size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend || !text.trim()}
              title="Отправить"
              className="rounded-xl bg-blue-600 p-2 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconSend size={18} />
            </button>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-slate-400">
          <span>
            {sendOnEnter
              ? 'Enter — отправить, Shift+Enter — новая строка'
              : 'Ctrl/Cmd+Enter — отправить'}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {toolsHint.map((t) => (
              <span
                key={t}
                className="rounded-full border border-slate-200 px-2 py-0.5 text-slate-500 dark:border-slate-700 dark:text-slate-400"
              >
                {t}
              </span>
            ))}
          </span>
        </div>
      </div>

      <Sheet
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        title="Прикрепить"
        description="Изображения уходят только в выбранную модель — на сторонние серверы они не загружаются."
      >
        <div className="space-y-1">
          <AttachRow
            icon={<IconImage size={18} />}
            label="Камера"
            hint="Снять фото и отправить модели"
            onClick={() => {
              setAttachOpen(false)
              cameraRef.current?.click()
            }}
          />
          <AttachRow
            icon={<IconPaperclip size={18} />}
            label="Галерея"
            hint="Выбрать до 4 изображений"
            onClick={() => {
              setAttachOpen(false)
              galleryRef.current?.click()
            }}
          />
          <AttachRow
            icon={<IconUpload size={18} />}
            label="Файл"
            hint="png, jpg, webp"
            onClick={() => {
              setAttachOpen(false)
              fileRef.current?.click()
            }}
          />
        </div>
      </Sheet>

      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

/** Строка меню вложений: крупная область нажатия под палец. */
function AttachRow({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode
  label: string
  hint: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition active:bg-slate-100 dark:active:bg-slate-800"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-slate-800 dark:text-slate-100">{label}</span>
        <span className="block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>
      </span>
    </button>
  )
}

