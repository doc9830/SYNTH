import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useConversations } from '@/lib/conversations'
import { copyText } from '@/lib/clipboard'
import { conversationToMarkdown, downloadText, safeFileName } from '@/lib/exportChat'
import type { Readiness } from '@/lib/readiness'
import { useSettings, type Settings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { useUpdateStore } from '@/lib/updateStore'
import { cn } from '@/lib/utils'
import type { Conversation } from '@/types'
import {
  IconAlert,
  IconBug,
  IconCopy,
  IconDownload,
  IconGlobe,
  IconImage,
  IconMenu,
  IconRefresh,
  IconSettings,
  IconTrash,
} from './icons'
import { ModelSelect } from './ModelSelect'

interface ChatHeaderProps {
  conversation: Conversation | undefined
  settings: Settings
  readiness: Readiness
  busy: boolean
  onOpenSidebar: () => void
  onOpenSettings: () => void
  onOpenDebug: () => void
}

export function ChatHeader({
  conversation,
  settings,
  readiness,
  busy,
  onOpenSidebar,
  onOpenSettings,
  onOpenDebug,
}: ChatHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const remove = useConversations((s) => s.remove)
  const update = useSettings((s) => s.update)
  const updateInfo = useUpdateStore((s) => s.info)
  const openUpdateDialog = useUpdateStore((s) => s.openDialog)
  const checkUpdates = useUpdateStore((s) => s.check)
  const checkingUpdate = useUpdateStore((s) => s.checking)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  const errors = readiness.issues.filter((i) => i.severity === 'error')
  const warnings = readiness.issues.filter((i) => i.severity === 'warning')

  return (
    <header className="border-b border-slate-200 bg-white/85 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="-ml-1 rounded-xl p-2.5 text-slate-600 transition active:bg-slate-200/70 md:hidden dark:text-slate-300 dark:active:bg-slate-800"
          aria-label="Открыть чаты"
        >
          <IconMenu size={20} />
        </button>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {conversation?.title ?? 'Новый чат'}
          </h2>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <ModelSelect kind="chat" variant="chip" value={settings.model} onChange={(model) => update({ model })} />
            {busy && <span className="shrink-0 animate-pulse text-blue-500">генерирую…</span>}
            {settings.search.enabled && <IconGlobe size={11} className="shrink-0" />}
            {settings.image.enabled && <IconImage size={11} className="shrink-0" />}
          </div>
        </div>

        {updateInfo ? (
          <button
            type="button"
            onClick={openUpdateDialog}
            title={`Доступно обновление ${updateInfo.version}`}
            className="flex items-center gap-1 rounded-xl border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-xs text-violet-700 transition hover:bg-violet-100 active:opacity-80 dark:border-violet-700/60 dark:bg-violet-950/40 dark:text-violet-200"
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
            className="hidden items-center gap-1 rounded-xl border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-100 disabled:opacity-50 sm:flex dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
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
              : 'border-slate-200 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800',
          )}
          title="Настройки подключения"
        >
          {errors.length > 0 ? <IconAlert size={14} /> : <IconSettings size={14} />}
          {errors.length ? 'Настроить' : 'Настройки'}
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-lg p-2 text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Меню чата"
            aria-expanded={menuOpen}
          >
            <IconMenu size={20} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900">
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
                onClick={() => {
                  setMenuOpen(false)
                  if (!conversation) return
                  downloadText(safeFileName(conversation.title), conversationToMarkdown(conversation))
                  notify('Файл сохранён', 'success')
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
              <MenuItem
                icon={<IconTrash size={15} />}
                label="Удалить чат"
                danger
                disabled={!conversation || busy}
                onClick={async () => {
                  setMenuOpen(false)
                  if (!conversation) return
                  if (!window.confirm(`Удалить чат «${conversation.title}»?`)) return
                  await remove(conversation.id)
                }}
              />
            </div>
          )}
        </div>
      </div>

      {warnings.length > 0 && !errors.length && (
        <div className="border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900 sm:px-4 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
          {warnings.map((w) => w.message).join(' ')}{' '}
          <button type="button" onClick={onOpenSettings} className="underline">
            Подробнее
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
          : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
      )}
    >
      {icon}
      {label}
    </button>
  )
}
