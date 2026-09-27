import { useMemo, useState } from 'react'
import { APP_NAME, APP_VERSION } from '@/lib/appInfo'
import { useConversations } from '@/lib/conversations'
import { providerLabel } from '@/lib/providerPresets'
import { useSettings } from '@/lib/settings'
import { notify } from '@/lib/toast'
import { cn, formatDay } from '@/lib/utils'
import {
  IconBug,
  IconCheck,
  IconMenu,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconX,
} from './icons'
import { BrandMark } from './BrandMark'

interface SidebarProps {
  open: boolean
  onClose: () => void
  onOpenSettings: () => void
  onOpenDebug: () => void
  /** Мастер подключения (Base URL + ключ + модель) */
  onOpenSetup: () => void
}

export function Sidebar({
  open,
  onClose,
  onOpenSettings,
  onOpenDebug,
  onOpenSetup,
}: SidebarProps) {
  const conversations = useConversations((s) => s.conversations)
  const activeId = useConversations((s) => s.activeId)
  const create = useConversations((s) => s.create)
  const select = useConversations((s) => s.select)
  const remove = useConversations((s) => s.remove)
  const rename = useConversations((s) => s.rename)
  const togglePin = useConversations((s) => s.togglePin)
  const deleteAll = useConversations((s) => s.deleteAll)
  const settings = useSettings((s) => s.settings)

  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true
      return c.messages.some((m) => m.content.toLowerCase().includes(q))
    })
  }, [conversations, query])

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setDraft(title)
  }

  const commitRename = () => {
    if (editingId) rename(editingId, draft)
    setEditingId(null)
  }

  const onNewChat = () => {
    create()
    setQuery('')
    onClose()
  }

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          'safe-top safe-bottom fixed inset-y-0 left-0 z-40 flex w-[86%] max-w-sm flex-col border-r border-slate-200 bg-slate-50 transition-transform duration-200 md:static md:z-auto md:w-72 md:max-w-none md:translate-x-0 dark:border-slate-800 dark:bg-slate-900/60',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-3 dark:border-slate-800">
          <div className="flex min-w-0 items-center gap-2 md:min-w-0">
            <BrandMark size={30} className="rounded-[9px]" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold tracking-wide text-slate-800 dark:text-slate-100">
                SYNTH
              </span>
              <span className="block truncate text-[10px] text-slate-500 dark:text-slate-400">
                {providerLabel(settings.providerId, settings.baseUrl)}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 text-slate-500 transition hover:bg-slate-200 md:hidden dark:hover:bg-slate-800"
            aria-label="Закрыть панель"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="flex items-center gap-2 px-3 pt-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-sky-500 px-3 py-2.5 text-sm font-medium text-white transition active:opacity-90"
          >
            <IconPlus size={16} />
            Новый чат
          </button>
        </div>

        <div className="px-3 py-2">
          <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900">
            <IconSearch size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по чатам"
              className="w-full bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-100"
                aria-label="Очистить поиск"
              >
                <IconX size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!filtered.length && (
            <p className="px-3 py-6 text-center text-xs text-slate-500 dark:text-slate-400">
              {query ? 'Ничего не найдено.' : 'Пока нет чатов — начните новый.'}
            </p>
          )}

          <ul className="flex flex-col gap-0.5">
            {filtered.map((conv) => {
              const active = conv.id === activeId
              const last = conv.messages[conv.messages.length - 1]
              return (
                <li key={conv.id}>
                  {editingId === conv.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        commitRename()
                      }}
                      className="flex items-center gap-1 rounded-xl bg-white px-2 py-1.5 ring-1 ring-blue-400 dark:bg-slate-900"
                    >
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Escape' && setEditingId(null)}
                        className="min-w-0 flex-1 bg-transparent text-sm text-slate-800 outline-none dark:text-slate-100"
                      />
                      <button
                        type="submit"
                        className="rounded-lg p-2 text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-950/60"
                        aria-label="Сохранить название"
                      >
                        <IconCheck size={15} />
                      </button>
                    </form>
                  ) : (
                    <div
                      className={cn(
                        'group relative flex items-start gap-2 rounded-xl px-2.5 py-2 transition',
                        active
                          ? 'bg-blue-100/80 dark:bg-blue-950/50'
                          : 'hover:bg-slate-200/70 dark:hover:bg-slate-800/70',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          select(conv.id)
                          onClose()
                        }}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="flex items-center gap-1.5">
                          {conv.pinned && <IconPin size={12} />}
                          <span
                            className={cn(
                              'truncate text-sm',
                              active
                                ? 'font-medium text-slate-900 dark:text-white'
                                : 'text-slate-700 dark:text-slate-200',
                            )}
                          >
                            {conv.title}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                          <span>{formatDay(conv.updatedAt)}</span>
                          {last && (
                            <span className="truncate opacity-70">
                              · {last.content.replace(/\s+/g, ' ').slice(0, 40)}
                            </span>
                          )}
                        </span>
                      </button>

                      <span
                        className={cn(
                          'flex shrink-0 items-center gap-0.5',
                          // на тач-устройствах ховера нет — кнопки действий видны всегда
                          active
                            ? 'opacity-100'
                            : 'opacity-100 md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => togglePin(conv.id)}
                          title={conv.pinned ? 'Открепить' : 'Закрепить'}
                          aria-label={conv.pinned ? 'Открепить' : 'Закрепить'}
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                        >
                          <IconPin size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => startRename(conv.id, conv.title)}
                          title="Переименовать"
                          aria-label="Переименовать"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                        >
                          <IconPencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.confirm(`Удалить чат «${conv.title}»?`)) return
                            await remove(conv.id)
                            notify('Чат удалён', 'success')
                          }}
                          title="Удалить"
                          aria-label="Удалить"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-red-100 hover:text-red-700 dark:hover:bg-red-950/60 dark:hover:text-red-300"
                        >
                          <IconTrash size={14} />
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>

        <div className="border-t border-slate-200 px-2 py-2 dark:border-slate-800">
          <button
            type="button"
            onClick={onOpenSetup}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-violet-700 transition hover:bg-violet-50 active:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/40"
          >
            <IconSparkles size={16} />
            Настроить подключение
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-700 transition hover:bg-slate-200/70 active:bg-slate-200/70 dark:text-slate-200 dark:hover:bg-slate-800/70"
          >
            <IconSettings size={16} />
            Настройки
          </button>
          <button
            type="button"
            onClick={onOpenDebug}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-slate-700 transition hover:bg-slate-200/70 active:bg-slate-200/70 dark:text-slate-200 dark:hover:bg-slate-800/70"
          >
            <IconBug size={16} />
            Debug Console
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm('Удалить всю историю чатов? Действие необратимо.')) return
              await deleteAll()
              notify('История очищена', 'success')
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm text-red-600 transition hover:bg-red-50 active:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <IconTrash size={16} />
            Удалить всю историю
          </button>
          <p className="flex items-center gap-2 px-3 pb-1 text-[11px] text-slate-400">
            <IconMenu size={13} />
            {APP_NAME} v{APP_VERSION} · история только на этом устройстве
          </p>
        </div>
      </aside>
    </>
  )
}
