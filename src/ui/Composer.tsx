import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileToAttachment, isImageFile } from '@/lib/attachments'
import { PRIMARY_FEATURES, isFeatureOn, setFeature, type Feature } from '@/lib/features'
import { useSettings } from '@/lib/settings'
import { getModelCapabilities } from '@/lib/utils'
import { notify } from '@/lib/toast'
import type { ImageAttachment } from '@/types'
import { cn } from '@/lib/utils'
import { IconImage, IconPaperclip, IconSend, IconSliders, IconStop, IconUpload, IconX } from './icons'
import { Sheet } from './Sheet'

/** Черновики по чатам: переключение чата не должно терять набранный текст. */
const drafts = new Map<string, string>()

interface ComposerProps {
  conversationId: string | null
  busy: boolean
  /** можно ли отправлять (проверка настроек) */
  canSend: boolean
  disabledReason?: string
  sendOnEnter: boolean
  model: string
  /** Открыть шторку «Функции»: там остальные переключатели */
  onOpenFeatures: () => void
  onSend: (text: string, attachments: ImageAttachment[]) => void
  onStop: () => void
}

export function Composer({
  conversationId,
  busy,
  canSend,
  disabledReason,
  sendOnEnter,
  model,
  onOpenFeatures,
  onSend,
  onStop,
}: ComposerProps) {
  const settings = useSettings((s) => s.settings)
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
      className="relative border-t border-neutral-200 bg-white/85 px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80 sm:px-6"
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
        <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-3xl border-2 border-dashed border-neutral-400 bg-neutral-100/90 text-sm font-medium text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800/90 dark:text-neutral-200">
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
                  className="h-16 w-16 rounded-xl border border-neutral-300 object-cover dark:border-neutral-700"
                />
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="absolute -top-1.5 -right-1.5 rounded-full bg-neutral-900/85 p-0.5 text-white transition hover:bg-red-600"
                  aria-label="Убрать изображение"
                  title="Убрать изображение"
                >
                  <IconX size={13} />
                </button>
              </div>
            ))}
            {adding && <span className="self-center text-xs text-neutral-500">Обработка…</span>}
          </div>
        )}

        <div
          className={cn(
            'flex items-end gap-2 rounded-3xl border bg-white p-2 shadow-sm transition dark:bg-neutral-800/70',
            canSend
              ? 'border-neutral-300 focus-within:border-neutral-400 dark:border-neutral-700 dark:focus-within:border-neutral-500'
              : 'border-amber-300 dark:border-amber-900/60',
          )}
        >
          <button
            type="button"
            onClick={() => setAttachOpen(true)}
            disabled={!canSend}
            title={caps.vision ? 'Прикрепить изображение' : `Модель ${model} не поддерживает изображения на входе`}
            aria-label="Прикрепить изображение"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-neutral-500 transition active:bg-neutral-200/70 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-400 dark:active:bg-neutral-800"
          >
            {caps.vision ? <IconPaperclip size={19} /> : <IconImage size={19} />}
          </button>

          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            placeholder={canSend ? 'Спросите что-нибудь…' : 'Сначала заполните настройки подключения'}
            disabled={!canSend}
            title={sendOnEnter ? 'Enter — отправить, Shift+Enter — новая строка' : 'Ctrl/Cmd+Enter — отправить'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            className="max-h-[260px] min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed dark:text-neutral-100"
          />

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              title="Остановить генерацию"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-neutral-800 text-white transition hover:bg-neutral-900 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white"
            >
              <IconStop size={18} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend || !text.trim()}
              title="Отправить"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-900 text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
            >
              <IconSend size={18} />
            </button>
          )}
        </div>

        <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {PRIMARY_FEATURES.map((feature) => (
            <FeatureChip
              key={feature.id}
              feature={feature}
              on={isFeatureOn(settings, feature)}
              onToggle={() => setFeature(feature, !isFeatureOn(settings, feature))}
            />
          ))}
          <button
            type="button"
            onClick={onOpenFeatures}
            title="Все функции: память, инструменты, вид ленты"
            className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-neutral-300 px-2.5 text-[11.5px] text-neutral-600 transition active:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-300 dark:active:bg-neutral-800"
          >
            <IconSliders size={13} />
            Настроить
          </button>
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
      className="flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition active:bg-neutral-100 dark:active:bg-neutral-800"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-neutral-800 dark:text-neutral-100">{label}</span>
        <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>
      </span>
    </button>
  )
}


/**
 * Чип быстрого переключения функции под полем ввода.
 * Включённая функция залита, выключенная — только контур: видно с одного взгляда.
 */
function FeatureChip({
  feature,
  on,
  onToggle,
}: {
  feature: Feature
  on: boolean
  onToggle: () => void
}) {
  const Icon = feature.icon
  return (
    <button
      type="button"
      onClick={onToggle}
      title={`${feature.label}. ${feature.hint}`}
      aria-pressed={on}
      className={cn(
        'inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition active:opacity-80',
        on
          ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-200 dark:bg-neutral-200 dark:text-neutral-900'
          : 'border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300',
      )}
    >
      <Icon size={13} />
      {feature.chip}
    </button>
  )
}

