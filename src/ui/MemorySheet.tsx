import { useMemo, useRef, useState, type ReactNode } from 'react'
import { saveTextFile } from '@/lib/files'
import {
  MEMORY_KIND_LABELS,
  memoryDump,
  memoryStats,
  memoriesToMarkdown,
  parseMemoryDump,
  remember,
  searchMemory,
  sortEntries,
  useMemory,
} from '@/lib/memory'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { MemoryEntry } from '@/types'
import {
  IconCheck,
  IconDownload,
  IconPencil,
  IconPin,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
} from './icons'
import { Sheet } from './Sheet'

/**
 * Шторка «Память»: долговременная память устройства.
 *
 * Здесь видно и можно править всё, что приложение помнит о пользователе:
 * записи из команды «запомни», из инструмента remember и из авто-разбора.
 * Память живёт только в IndexedDB этого устройства — отсюда же её экспорт,
 * импорт и полная очистка.
 */
interface MemorySheetProps {
  open: boolean
  onClose: () => void
}

export function MemorySheet({ open, onClose }: MemorySheetProps) {
  const entries = useMemory((s) => s.entries)
  const loaded = useMemory((s) => s.loaded)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const stats = useMemo(() => memoryStats(entries), [entries])
  const list = useMemo(() => {
    const q = query.trim()
    return q ? searchMemory(q, 100) : sortEntries(entries)
  }, [entries, query])

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    setAdding(true)
    try {
      const entry = await remember(text, { source: 'manual' })
      if (entry) {
        setDraft('')
        notify('Записано в память', 'success')
      } else {
        notify('Не сохранил: слишком коротко или похоже на секрет (ключи и пароли не храним)', 'error')
      }
    } finally {
      setAdding(false)
    }
  }

  const saveEdit = async (id: string) => {
    const text = editingText.trim()
    if (!text) return
    await useMemory.getState().update(id, { text })
    setEditingId(null)
    setEditingText('')
  }

  const exportMemory = async (kind: 'md' | 'json') => {
    const stamp = new Date().toISOString().slice(0, 10)
    const result =
      kind === 'md'
        ? await saveTextFile(`memory-synth-${stamp}.md`, memoriesToMarkdown(), 'text/markdown')
        : await saveTextFile(`memory-synth-${stamp}.json`, memoryDump(), 'application/json')
    notify(result.message, result.ok ? 'success' : 'error')
  }

  const importMemory = async (file: File) => {
    try {
      const parsed = parseMemoryDump(await file.text())
      if (!parsed.length) {
        notify('В файле не нашлось подходящих записей', 'error')
        return
      }
      if (!window.confirm(`Импортировать записей: ${parsed.length}? Текущая память будет заменена.`)) return
      await useMemory.getState().replaceAll(parsed)
      notify(`Импортировано записей: ${parsed.length}`, 'success')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Не удалось прочитать файл', 'error')
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Память"
      description="Факты о вас, которые модель получает в новых чатах. Хранится только на этом устройстве; ключи и пароли не сохраняются."
      footer={
        <div className="flex flex-wrap gap-2">
          <MemoryAction icon={<IconDownload size={14} />} label="Экспорт .md" onClick={() => void exportMemory('md')} />
          <MemoryAction icon={<IconDownload size={14} />} label="Экспорт .json" onClick={() => void exportMemory('json')} />
          <MemoryAction
            icon={<IconUpload size={14} />}
            label="Импорт"
            onClick={() => fileRef.current?.click()}
          />
          <MemoryAction
            icon={<IconTrash size={14} />}
            label="Очистить"
            danger
            disabled={!stats.count}
            onClick={async () => {
              if (!window.confirm(`Удалить все записи памяти (${stats.count})? Действие необратимо.`)) return
              await useMemory.getState().clear()
              notify('Память очищена', 'success')
            }}
          />
        </div>
      }
    >
      <div className="space-y-4">
        <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-300">
          Записей: {stats.count}
          {stats.pinned ? ` · закреплено: ${stats.pinned}` : ''} · {stats.chars} символов
          {!loaded && ' · загрузка…'}
          <br />
          Команда «запомни, что …» в чате, инструмент модели и авто-разбор после ответа складывают факты сюда.
        </p>

        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void add()
              }
            }}
            placeholder="Новый факт: «я живу в Казани»"
            className="min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={adding || !draft.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white transition active:opacity-80 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            <IconPlus size={15} />
            Добавить
          </button>
        </div>

        {stats.count > 0 && (
          <div className="flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-700 dark:bg-neutral-800/60">
            <IconSearch size={15} className="shrink-0 text-neutral-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по памяти"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-sm text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} className="text-[11px] text-neutral-400">
                Сбросить
              </button>
            )}
          </div>
        )}

        {!stats.count && (
          <p className="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            Память пока пуста. Скажите в чате «запомни, что …» или добавьте факт вручную выше.
          </p>
        )}

        {stats.count > 0 && !list.length && (
          <p className="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
            По запросу «{query}» ничего не найдено.
          </p>
        )}

        <ul className="space-y-2">
          {list.map((entry) => (
            <MemoryRow
              key={entry.id}
              entry={entry}
              editing={editingId === entry.id}
              editingText={editingText}
              onStartEdit={() => {
                setEditingId(entry.id)
                setEditingText(entry.text)
              }}
              onCancelEdit={() => {
                setEditingId(null)
                setEditingText('')
              }}
              onEditText={setEditingText}
              onSaveEdit={() => void saveEdit(entry.id)}
            />
          ))}
        </ul>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void importMemory(file)
          e.target.value = ''
        }}
      />
    </Sheet>
  )
}

/** Кнопка нижней панели шторки памяти. */
function MemoryAction({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition disabled:opacity-40',
        danger
          ? 'border-neutral-300 text-red-600 active:bg-red-50 dark:border-neutral-700 dark:text-red-400 dark:active:bg-red-950/40'
          : 'border-neutral-300 text-neutral-700 active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:active:bg-neutral-800',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** Одна запись памяти: текст, метки и действия (закрепить/правка/удалить). */
function MemoryRow({
  entry,
  editing,
  editingText,
  onStartEdit,
  onCancelEdit,
  onEditText,
  onSaveEdit,
}: {
  entry: MemoryEntry
  editing: boolean
  editingText: string
  onStartEdit: () => void
  onCancelEdit: () => void
  onEditText: (text: string) => void
  onSaveEdit: () => void
}) {
  const update = useMemory((s) => s.update)
  const remove = useMemory((s) => s.remove)
  const sourceLabel =
    entry.source === 'auto'
      ? 'авто'
      : entry.source === 'tool'
        ? 'инструмент'
        : entry.source === 'manual'
          ? 'вручную'
          : 'из чата'

  if (editing) {
    return (
      <li className="rounded-2xl border border-neutral-300 p-2.5 dark:border-neutral-600">
        <textarea
          value={editingText}
          onChange={(e) => onEditText(e.target.value)}
          rows={3}
          autoFocus
          className="w-full resize-y rounded-xl bg-transparent text-sm text-neutral-800 outline-none dark:text-neutral-100"
        />
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelEdit}
            className="rounded-lg px-2.5 py-1 text-xs text-neutral-500 dark:text-neutral-400"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={onSaveEdit}
            disabled={!editingText.trim()}
            className="inline-flex items-center gap-1 rounded-lg bg-neutral-900 px-2.5 py-1 text-xs text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            <IconCheck size={13} />
            Сохранить
          </button>
        </div>
      </li>
    )
  }

  return (
    <li className="rounded-2xl border border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm break-words text-neutral-800 dark:text-neutral-100">
            {entry.pinned && <IconPin size={12} className="mt-[-2px] mr-1 inline text-neutral-500" />}
            {entry.text}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-500 dark:text-neutral-400">
            <span className="rounded-full bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
              {MEMORY_KIND_LABELS[entry.kind]}
            </span>
            <span>{sourceLabel}</span>
            <span>· {new Date(entry.updatedAt).toLocaleDateString('ru-RU')}</span>
            {entry.tags.map((tag) => (
              <span key={tag} className="rounded-full bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                #{tag}
              </span>
            ))}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5">
          <RowAction
            title={entry.pinned ? 'Открепить' : 'Закрепить: всегда в контексте'}
            onClick={() => void update(entry.id, { pinned: !entry.pinned })}
          >
            <IconPin size={14} className={entry.pinned ? 'text-neutral-900 dark:text-neutral-100' : undefined} />
          </RowAction>
          <RowAction title="Изменить" onClick={onStartEdit}>
            <IconPencil size={14} />
          </RowAction>
          <RowAction title="Удалить" danger onClick={() => void remove(entry.id)}>
            <IconTrash size={14} />
          </RowAction>
        </span>
      </div>
    </li>
  )
}

function RowAction({
  children,
  title,
  onClick,
  danger,
}: {
  children: ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'rounded-lg p-1.5 text-neutral-500 transition active:bg-neutral-100 dark:text-neutral-400 dark:active:bg-neutral-800',
        danger && 'hover:text-red-600 dark:hover:text-red-400',
      )}
    >
      {children}
    </button>
  )
}
