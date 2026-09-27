import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { pushBackHandler } from '@/lib/backStack'
import { copyText } from '@/lib/clipboard'
import { useConversations } from '@/lib/conversations'
import { conversationToMarkdown, safeFileName } from '@/lib/exportChat'
import { saveTextFile } from '@/lib/files'
import { issuesSignature, useNotices } from '@/lib/notices'
import type { Readiness } from '@/lib/readiness'
import { useSettings, type Settings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { useUpdateStore } from '@/lib/updateStore'
import { cn } from '@/lib/utils'
import type { Conversation } from '@/types'
import {
  IconAlert,
  IconBrain,
  IconBug,
  IconCopy,
  IconDots,
  IconDownload,
  IconMenu,
  IconRefresh,
  IconSettings,
  IconSliders,
  IconTrash,
  IconX,
} from './icons'
import { ContextMeter } from './ContextMeter'
import { ModelSelect } from './ModelSelect'

interface ChatHeaderProps {
  conversation: Conversation | undefined
  settings: Settings
  readiness: Readiness
  busy: boolean
  onOpenSidebar: () => void
  onOpenSettings: () => void
  onOpenDebug: () => void
  /** Шторка «Функции» (поиск, картинки, инструменты, память) */
  onOpenFeatures: () => void
  /** Шторка «Память»: записи, экспорт, очистка */
  onOpenMemory: () => void
}

export function ChatHeader({
  conversation,
  settings,
  readiness,
  busy,
  onOpenSidebar,
  onOpenSettings,
  onOpenDebug,
  onOpenFeatures,
  onOpenMemory,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * Позиция выпадающего меню. Меню рисуем порталом в body: в шапке есть
   * backdrop-blur, и внутри неё прокручиваемый блок с заливкой терял фон —
   * меню выглядело прозрачным (особенность WebView/Chromium).
   */
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; right: number } | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuPanelRef = useRef<HTMLDivElement>(null)
  const remove = useConversations((s) => s.remove)
  /** Шаг подтверждения удаления внутри меню (вместо системного confirm) */
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const update = useSettings((s) => s.update)
  const updateInfo = useUpdateStore((s) => s.info)
  const openUpdateDialog = useUpdateStore((s) => s.openDialog)
  const checkUpdates = useUpdateStore((s) => s.check)
  const checkingUpdate = useUpdateStore((s) => s.checking)

  // позицию меню считаем по кнопке (layout-effect успевает до отрисовки кадра)
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuAnchor(null)
      return
    }
    const rect = menuButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    // аппаратная «Назад» закрывает выпадающее меню чата
    const release = pushBackHandler(() => setMenuOpen(false))
    return () => {
      document.removeEventListener('keydown', onKey)
      release()
    }
  }, [menuOpen])

  // закрыли меню — сбрасываем шаг подтверждения удаления
  useEffect(() => {
    if (!menuOpen) setConfirmDelete(false)
  }, [menuOpen])

  /**
   * Удаление чата из меню шапки.
   *
   * Подтверждение — своё, панелью ниже, а не системным window.confirm: в WebView
   * системный диалог может не появиться, и нажатие выглядело «не сработавшим».
   * Результат виден в тосте — удаление больше не происходит молча.
   */
  const deleteChat = async () => {
    const target = conversation
    if (!target || deleting) return
    setDeleting(true)
    try {
      await remove(target.id)
      notify(`Чат «${target.title}» удалён`, 'success')
      setMenuOpen(false)
      setConfirmDelete(false)
    } catch (error) {
      notify(`Не удалось удалить чат: ${String(error)}`, 'error')
    } finally {
      setDeleting(false)
    }
  }

  const errors = readiness.issues.filter((i) => i.severity === 'error')
  const warnings = readiness.issues.filter((i) => i.severity === 'warning')

  // Верхнее предупреждение закрывается крестиком и не возвращается,
  // пока текст предупреждения не изменится.
  const warningsSignature = issuesSignature(warnings)
  const warningsHidden = useNotices((s) => s.dismissed.warnings) === warningsSignature
  const dismissNotice = useNotices((s) => s.dismiss)

  return (
    <header className="border-b border-neutral-200 bg-white/85 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/80">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="-ml-1 rounded-xl p-2.5 text-neutral-600 transition active:bg-neutral-200/70 md:hidden dark:text-neutral-300 dark:active:bg-neutral-800"
          aria-label="Открыть чаты"
        >
          <IconMenu size={20} />
        </button>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {conversation?.title ?? 'Новый чат'}
          </h2>
          <div className="flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
            <ModelSelect kind="chat" variant="chip" value={settings.model} onChange={(model) => update({ model })} />
            {busy && <span className="shrink-0 animate-pulse text-neutral-500 dark:text-neutral-400">генерирую…</span>}
            <ContextMeter messages={conversation?.messages ?? []} />
          </div>
        </div>

        {updateInfo ? (
          <button
            type="button"
            onClick={openUpdateDialog}
            title={`Доступно обновление ${updateInfo.version}`}
            className="flex items-center gap-1 rounded-xl border border-neutral-300 bg-neutral-100 px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-200 active:opacity-80 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
          >
            <IconDownload size={14} />
            <span className="hidden sm:inline">{updateInfo.version}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void checkUpdates({ manual: true })}
            disabled={checkingUpdate}
            title="Проверить обновления"
            aria-label="Проверить обновления"
            className="hidden items-center gap-1 rounded-xl border border-neutral-200 p-2 text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-50 sm:flex dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <IconRefresh size={14} className={checkingUpdate ? 'animate-spin' : undefined} />
          </button>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          className={cn(
            'hidden items-center gap-1 rounded-xl border px-2.5 py-1.5 text-xs transition sm:flex',
            errors.length
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
              : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800',
          )}
          title="Настройки подключения"
        >
          {errors.length > 0 ? <IconAlert size={14} /> : <IconSettings size={14} />}
          {errors.length ? 'Настроить' : 'Настройки'}
        </button>

        <div className="relative">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-lg p-2 text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            aria-label="Меню чата"
            aria-expanded={menuOpen}
          >
            <IconDots size={20} />
          </button>
        </div>
      </div>

      {/*
        Меню рисуем порталом в body, а не внутри шапки: у шапки есть backdrop-blur
        (свой контекст наложения), из-за которого заливка панели терялась и меню
        выглядело прозрачным, а часть пунктов попадала под ленту сообщений.
        Прозрачная подложка на весь экран закрывает меню по тапу, а сами пункты
        остаются обычными кнопками — нажатия срабатывают надёжно.
      */}
      {menuOpen &&
        menuAnchor &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[60] bg-transparent"
              onClick={() => setMenuOpen(false)}
              role="presentation"
            />
            <div
              ref={menuPanelRef}
              role="menu"
              style={{ top: menuAnchor.top, right: menuAnchor.right }}
              className="fixed z-[61] max-h-[70dvh] w-56 overflow-y-auto overscroll-contain rounded-xl border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
            >
              <MenuItem
                icon={<IconSliders size={15} />}
                label="Функции"
                onClick={() => {
                  setMenuOpen(false)
                  onOpenFeatures()
                }}
              />
              <MenuItem
                icon={<IconBrain size={15} />}
                label="Память"
                onClick={() => {
                  setMenuOpen(false)
                  onOpenMemory()
                }}
              />
              <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
              <MenuItem
                icon={<IconCopy size={15} />}
                label="Скопировать чат"
                disabled={!conversation?.messages.length}
                onClick={async () => {
                  setMenuOpen(false)
                  if (!conversation) return
                  const ok = await copyText(conversationToMarkdown(conversation))
                  notify(
                    ok ? 'Чат скопирован в Markdown' : 'Не удалось скопировать',
                    ok ? 'success' : 'error',
                  )
                }}
              />
              <MenuItem
                icon={<IconDownload size={15} />}
                label="Экспорт в .md"
                disabled={!conversation?.messages.length}
                onClick={async () => {
                  setMenuOpen(false)
                  if (!conversation) return
                  const result = await saveTextFile(
                    safeFileName(conversation.title),
                    conversationToMarkdown(conversation),
                  )
                  notify(result.message, result.ok ? 'success' : 'error')
                }}
              />
              <MenuItem
                icon={<IconSettings size={15} />}
                label="Настройки"
                onClick={() => {
                  setMenuOpen(false)
                  onOpenSettings()
                }}
              />
              <MenuItem
                icon={<IconBug size={15} />}
                label="Debug Console"
                onClick={() => {
                  setMenuOpen(false)
                  onOpenDebug()
                }}
              />
              <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
              {confirmDelete && conversation ? (
                <div className="px-3 py-2">
                  <p className="text-sm text-neutral-700 dark:text-neutral-200">
                    Удалить чат «{conversation.title}»?
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={deleting}
                      onClick={() => void deleteChat()}
                      className="flex-1 rounded-xl bg-red-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? 'Удаляю…' : 'Удалить'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      Отмена
                    </button>
                  </div>
                </div>
              ) : (
                <MenuItem
                  icon={<IconTrash size={15} />}
                  label="Удалить чат"
                  danger
                  disabled={!conversation}
                  onClick={() => setConfirmDelete(true)}
                />
              )}
            </div>
          </>,
          document.body,
        )}

      {warnings.length > 0 && !errors.length && !warningsHidden && (
        <div className="flex items-start gap-2 border-t border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 sm:px-4 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
          <IconAlert size={13} className="mt-0.5 shrink-0 text-neutral-400" />
          <span className="min-w-0 flex-1">
            {warnings.map((w) => w.message).join(' ')}{' '}
            <button type="button" onClick={onOpenSettings} className="underline underline-offset-2">
              Подробнее
            </button>
          </span>
          <button
            type="button"
            onClick={() => dismissNotice('warnings', warningsSignature)}
            className="-mt-0.5 -mr-1 shrink-0 rounded-lg p-1.5 text-neutral-400 transition hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label="Скрыть уведомление"
            title="Скрыть уведомление"
          >
            <IconX size={13} />
          </button>
        </div>
      )}
    </header>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
