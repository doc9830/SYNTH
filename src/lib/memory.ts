import { chatOnce } from '@/api'
import type { ChatMessage, MemoryEntry, MemoryKind } from '@/types'
import { create } from 'zustand'
import {
  clearMemoriesInDB,
  deleteMemoryFromDB,
  loadMemoriesFromDB,
  putMemoryToDB,
  replaceMemoriesInDB,
} from './db'
import { debugLog } from './debug'
import type { Settings } from './settings'
import { uid } from './utils'

/**
 * Долговременная память.
 *
 * Идея: у приложения нет серверной памяти, но она и не нужна — модель умеет
 * писать саммари. Поэтому память устроена как локальная база коротких фактов:
 *
 *   1. ЗАПИСЬ. Три независимых канала:
 *      · команда пользователя «запомни, что …» (детерминированно, без модели);
 *      · инструмент `remember` — модель сама решает сохранить факт;
 *      · авто-извлечение: после ответа отдельный нестримовый запрос просит
 *        модель вытащить устойчивые факты из последних сообщений.
 *      Все три канала идут через `add()` — он дедуплицирует по сходству
 *      (Jaccard по значимым токенам) и объединяет близкие записи.
 *
 *   2. ЧТЕНИЕ. Перед запросом к модели считается блок памяти:
 *      закреплённые записи + самые релевантные текущему сообщению
 *      (пересечение токенов + свежесть + частота использования), с жёстким
 *      лимитом символов. Блок приклеивается к системному промпту.
 *      Плюс инструменты `recall` (поиск по памяти) и `forget`.
 *
 *   3. ГРАНИЦЫ. Память живёт только в IndexedDB устройства. Записи похожие на
 *      секреты (ключи, пароли, карты) не сохраняются вообще; длинные обрезаются;
 *      есть лимит числа записей и полная очистка в UI.
 */

/** Максимальная длина одной записи (обрезка). */
const MAX_ENTRY_CHARS = 400
/** Не сохраняем совсем короткие «факты» — обычно это мусор. */
const MIN_ENTRY_CHARS = 6
const MAX_TAGS = 4
const MAX_TAG_CHARS = 24
/** Сколько записей держим: при переполнении удаляем самые старые незакреплённые. */
const MAX_ENTRIES = 500
/** Сколько фактов максимум принимаем из одного авторазбора. */
const MAX_FACTS_PER_TURN = 6
/** Авторазбор не чаще, чем раз в минуту — экономим запросы. */
const AUTO_EXTRACT_MIN_INTERVAL = 60_000
/** Из скольких последних сообщений извлекаем факты. */
const AUTO_EXTRACT_MESSAGES = 12
/** Порог сходства для склейки записей. */
const SIMILARITY_MERGE = 0.66

/** Записи, которые нельзя хранить: там почти наверняка секрет. */
const SECRET_RE =
  /(api[-_ ]?key|apikey|secret|token|токен|пароль|passwd|password|sk-[a-zA-Z0-9_-]{12,}|bearer\s|номер\s+карт|card\s*number|cvv|cvc)/i

/** Служебные слова ru/en — не участвуют в сравнении и ранжировании. */
const STOP_WORDS = new Set([
  'the','and','for','that','this','with','you','are','was','were','have','has','from','not','but','его',
  'это','этот','эта','эти','как','что','чтобы','или','если','когда','тоже','также','очень','более',
  'менее','надо','нужно','можно','нельзя','есть','был','была','было','были','быть','будет','буду',
  'для','про','без','при','над','под','через','между','после','перед','потом','теперь','сейчас',
  'где','куда','зачем','почему','кто','чей','мой','моя','мои','наш','ваш','свой','свои','себя','они',
  'она','оно','его','её','ему','них','нас','вас','мне','тебя','скажи','может','хочу','дай',
  'спасибо','привет','пока','всегда','никогда','иногда','обычно','примерно','конечно','вообще',
])

/** Записи похожие на секреты не сохраняем. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_RE.test(text)
}

/** Чистим текст: пробелы, обрезка, первая буква заглавная для аккуратного списка. */
function cleanText(raw: string): string {
  const text = raw
    .replace(/\s+/g, ' ')
    .replace(/^[-–—•*\s]+/, '')
    .trim()
  return text.length > MAX_ENTRY_CHARS ? `${text.slice(0, MAX_ENTRY_CHARS - 1)}…` : text
}

function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags) {
    const value = String(tag ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}-]+/gu, '')
      .slice(0, MAX_TAG_CHARS)
    if (value && !out.includes(value)) out.push(value)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

const KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'instruction', 'note']

function cleanKind(raw: unknown): MemoryKind {
  return KINDS.includes(raw as MemoryKind) ? (raw as MemoryKind) : 'fact'
}

/** Значимые токены: слова от 3 символов без стоп-слов. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP_WORDS.has(t))
}

/** Сходство двух записей: Jaccard по значимым токенам (0..1). */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (!left.size || !right.size) return 0
  let common = 0
  for (const token of left) if (right.has(token)) common += 1
  return common / (left.size + right.size - common)
}

/* ─────────────────────────── Хранилище записей ─────────────────────────── */

export interface AddMemoryInput {
  kind?: MemoryKind
  tags?: string[]
  source?: MemoryEntry['source']
  conversationId?: string
  pinned?: boolean
}

interface MemoryState {
  entries: MemoryEntry[]
  loaded: boolean
  loading: boolean
  load: () => Promise<void>
  add: (raw: string, input?: AddMemoryInput) => Promise<MemoryEntry | null>
  update: (
    id: string,
    patch: Partial<Pick<MemoryEntry, 'text' | 'tags' | 'pinned' | 'kind'>>,
  ) => Promise<void>
  remove: (id: string) => Promise<void>
  clear: () => Promise<void>
  replaceAll: (entries: MemoryEntry[]) => Promise<void>
  bumpHits: (ids: string[]) => void
}

/** Записи, которые часто используются — пишем их счётчик в БД с задержкой. */
const hitsTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleHitsWrite(entry: MemoryEntry): void {
  const prev = hitsTimers.get(entry.id)
  if (prev) clearTimeout(prev)
  hitsTimers.set(
    entry.id,
    setTimeout(() => {
      hitsTimers.delete(entry.id)
      void putMemoryToDB(entry)
    }, 5000),
  )
}

export const useMemory = create<MemoryState>((set, get) => ({
  entries: [],
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const entries = await loadMemoriesFromDB()
      set({ entries, loaded: true })
    } catch (err) {
      // память — вспомогательная функция: сбой БД не должен ломать приложение
      debugLog('error', 'Не удалось загрузить память', [err])
      set({ loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  add: async (raw, input = {}) => {
    const text = cleanText(raw)
    if (text.length < MIN_ENTRY_CHARS) return null
    if (looksLikeSecret(text)) {
      debugLog('info', 'Запись похожа на секрет — не сохраняем', [text.slice(0, 40)])
      return null
    }

    const tags = cleanTags(input.tags)
    const entries = get().entries
    // склейка близких записей: обновляем более подробную формулировку
    const twin = entries.find((e) => similarity(e.text, text) >= SIMILARITY_MERGE)
    const now = Date.now()

    if (twin) {
      const next: MemoryEntry = {
        ...twin,
        text: text.length > twin.text.length ? text : twin.text,
        kind: twin.kind === 'note' ? cleanKind(input.kind) : twin.kind,
        tags: [...new Set([...twin.tags, ...tags])].slice(0, MAX_TAGS),
        pinned: twin.pinned || Boolean(input.pinned),
        updatedAt: now,
      }
      set({ entries: sortEntries(entries.map((e) => (e.id === twin.id ? next : e))) })
      await putMemoryToDB(next)
      return next
    }

    const entry: MemoryEntry = {
      id: uid('mem'),
      text,
      kind: cleanKind(input.kind),
      tags,
      pinned: Boolean(input.pinned),
      createdAt: now,
      updatedAt: now,
      source: input.source ?? 'manual',
      conversationId: input.conversationId,
      hits: 0,
    }

    const next = sortEntries([entry, ...entries])
    const pruned = pruneEntries(next)
    set({ entries: pruned })
    await putMemoryToDB(entry)
    for (const dropped of next.filter((e) => !pruned.some((p) => p.id === e.id))) {
      await deleteMemoryFromDB(dropped.id)
    }
    debugLog('info', 'Запись добавлена', [{ id: entry.id, source: entry.source, kind: entry.kind }])
    return entry
  },

  update: async (id, patch) => {
    const current = get().entries.find((e) => e.id === id)
    if (!current) return
    const next: MemoryEntry = {
      ...current,
      ...patch,
      text: patch.text !== undefined ? cleanText(patch.text) || current.text : current.text,
      tags: patch.tags ? cleanTags(patch.tags) : current.tags,
      updatedAt: Date.now(),
    }
    set({ entries: sortEntries(get().entries.map((e) => (e.id === id ? next : e))) })
    await putMemoryToDB(next)
  },

  remove: async (id) => {
    const timer = hitsTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      hitsTimers.delete(id)
    }
    set({ entries: get().entries.filter((e) => e.id !== id) })
    await deleteMemoryFromDB(id)
  },

  clear: async () => {
    for (const timer of hitsTimers.values()) clearTimeout(timer)
    hitsTimers.clear()
    set({ entries: [] })
    await clearMemoriesInDB()
  },

  replaceAll: async (entries) => {
    const cleaned = pruneEntries(sortEntries(entries.filter((e) => !looksLikeSecret(e.text))))
    set({ entries: cleaned })
    await replaceMemoriesInDB(cleaned)
  },

  bumpHits: (ids) => {
    if (!ids.length) return
    const set0 = new Set(ids)
    const entries = get().entries.map((e) =>
      set0.has(e.id) ? { ...e, hits: e.hits + 1, updatedAt: e.updatedAt } : e,
    )
    set({ entries })
    for (const entry of entries) if (set0.has(entry.id)) scheduleHitsWrite(entry)
  },
}))

/** Свежие и закреплённые — выше в списке. */
export function sortEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

/** Переполнение: удаляем самые старые незакреплённые записи. */
function pruneEntries(entries: MemoryEntry[]): MemoryEntry[] {
  if (entries.length <= MAX_ENTRIES) return entries
  const pinned = entries.filter((e) => e.pinned)
  const rest = entries.filter((e) => !e.pinned)
  return [...pinned, ...rest.slice(0, Math.max(0, MAX_ENTRIES - pinned.length))]
}

/* ─────────────────────────── Чтение: контекст ─────────────────────────── */

/** Оценка релевантности записи текущему сообщению. */
function relevance(entry: MemoryEntry, queryTokens: Set<string>, now: number): number {
  let score = entry.pinned ? 3 : 0
  const entryTokens = new Set(tokenize(`${entry.text} ${entry.tags.join(' ')}`))
  let overlap = 0
  for (const token of queryTokens) if (entryTokens.has(token)) overlap += 1
  score += overlap * 1.4
  const days = (now - entry.updatedAt) / 86_400_000
  score += Math.max(0, 1 - days / 30)
  score += Math.min(entry.hits, 5) * 0.05
  return score
}

/** Отбирает записи для контекста: закреплённые + релевантные, с лимитом символов. */
export function selectForContext(
  entries: MemoryEntry[],
  query: string,
  settings: Settings,
): MemoryEntry[] {
  const limit = Math.max(1, settings.memory.maxInjected)
  const maxChars = Math.max(200, settings.memory.maxChars)
  const now = Date.now()
  const queryTokens = new Set(tokenize(query))
  const ranked = [...entries].sort(
    (a, b) => relevance(b, queryTokens, now) - relevance(a, queryTokens, now),
  )

  const picked: MemoryEntry[] = []
  let used = 0
  for (const entry of ranked) {
    if (picked.length >= limit) break
    const cost = entry.text.length + 3
    if (used + cost > maxChars) continue
    picked.push(entry)
    used += cost
  }
  return picked
}

/**
 * Блок памяти для системного промпта. Пустая строка — памяти нет или она выключена.
 * Формулировка намеренно императивная: модели нужно объяснить, что это факты,
 * а не догадки.
 */
export function buildMemoryContext(
  settings: Settings,
  query: string,
  opts: { track?: boolean } = {},
): string {
  if (!settings.memory.enabled) return ''
  const entries = useMemory.getState().entries
  if (!entries.length) return ''

  const picked = selectForContext(entries, query, settings)
  if (!picked.length) return ''

  // track: false — предпросмотр в интерфейсе (замер контекста) не должен
  // накручивать статистику использования записей
  if (opts.track !== false) useMemory.getState().bumpHits(picked.map((e) => e.id))

  return [
    'Долговременная память о пользователе (факты из прошлых сессий, хранятся на его устройстве).',
    'Учитывай их как уже известное, не переспрашивай заново и не упоминай сам факт памяти без надобности:',
    ...picked.map((e) => `- ${e.text}`),
  ].join('\n')
}

/** Поиск по памяти по свободному запросу (инструмент `recall`). */
export function searchMemory(query: string, limit = 6): MemoryEntry[] {
  const entries = useMemory.getState().entries
  if (!entries.length) return []
  const tokens = new Set(tokenize(query))
  if (!tokens.size) return entries.slice(0, limit)
  return entries
    .map((entry) => {
      const entryTokens = new Set(tokenize(`${entry.text} ${entry.tags.join(' ')}`))
      let overlap = 0
      for (const token of tokens) if (entryTokens.has(token)) overlap += 1
      return { entry, score: overlap + (entry.pinned ? 0.5 : 0) }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry)
}

/* ────────────────────────── Запись: извлечение ────────────────────────── */

/**
 * Команда «запомни, что …» в сообщении пользователя.
 *
 * Важно: `\b` здесь не работает — в JS граница слова считается по латинице
 * (`\w`), а после кириллического «и» её нет. Поэтому после глагола требуем
 * явный разделитель: запятую, двоеточие, пробел или конец строки.
 */
const REMEMBER_RE =
  /^\s*(?:запомни(?:те)?|remember|не\s+забудь)(?:[\s.,:;!?—–-]+|$)(?:что[\s,]+)?(.+)$/is

/** Возвращает текст факта, если сообщение — команда запомнить. */
export function parseRememberCommand(text: string): string | null {
  const match = REMEMBER_RE.exec(text.trim())
  const fact = match?.[1]?.trim()
  return fact && fact.length >= MIN_ENTRY_CHARS ? fact : null
}

/** Сохраняет факт (общая точка входа для команды, инструмента и UI). */
export async function remember(
  text: string,
  input: AddMemoryInput = {},
): Promise<MemoryEntry | null> {
  return useMemory.getState().add(text, input)
}

const EXTRACT_SYSTEM = [
  'Ты — модуль долговременной памяти диалогового ассистента.',
  'Из фрагмента переписки извлеки только долговременные факты о ПОЛЬЗОВАТЕЛЕ, полезные в будущих сессиях:',
  'имя, город и часовой пояс, язык общения, профессия, стек технологий, проекты, устойчивые',
  'предпочтения к стилю ответов, повторяющиеся требования и ограничения.',
  'НЕ извлекай: разовые задачи, содержание ответов ассистента, ссылки, новости, очевидности из вопроса.',
  'НЕ извлекай секреты: ключи, пароли, номера карт, персональные документы.',
  'Формулируй факт одной короткой фразой от третьего лица: «пользователь живёт в Казани».',
  'Ответ — ТОЛЬКО JSON-массив объектов вида',
  '{"text": "...", "kind": "fact|preference|project|instruction", "tags": ["..."]}.',
  'Если устойчивых фактов нет — верни пустой массив [].',
].join('\n')

interface ExtractedFact {
  text: string
  kind: MemoryKind
  tags: string[]
}

/** Разбирает ответ модели: терпим к ```json и тексту вокруг массива. */
export function parseFacts(raw: string): ExtractedFact[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: ExtractedFact[] = []
  for (const item of parsed) {
    const record = item as { text?: unknown; kind?: unknown; tags?: unknown }
    const text = cleanText(String(record?.text ?? ''))
    if (text.length < MIN_ENTRY_CHARS || looksLikeSecret(text)) continue
    out.push({ text, kind: cleanKind(record?.kind), tags: cleanTags(record?.tags) })
    if (out.length >= MAX_FACTS_PER_TURN) break
  }
  return out
}

/** Диалог → компактный текст для извлечения фактов. */
function renderDialog(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content.slice(0, 1200)}`)
    .join('\n\n')
    .slice(-6000)
}

let extractInFlight = false
let lastExtractAt = 0

/** Нужно ли вообще запускать извлечение (экономим запросы). */
export function shouldExtract(settings: Settings, messages: ChatMessage[]): boolean {
  if (!settings.memory.enabled || !settings.memory.autoExtract) return false
  return messages.some((m) => m.role === 'user' && m.content.trim().length > 20)
}

/**
 * Авто-извлечение фактов из завершившегося хода.
 * Fire-and-forget: ошибки глушим, интерфейс они не касаются.
 */
export async function autoExtractMemories(input: {
  settings: Settings
  conversationId: string
  messages: ChatMessage[]
}): Promise<MemoryEntry[]> {
  const { settings } = input
  if (!settings.memory.enabled || !settings.memory.autoExtract) return []
  if (extractInFlight || Date.now() - lastExtractAt < AUTO_EXTRACT_MIN_INTERVAL) return []

  const dialog = renderDialog(input.messages.slice(-AUTO_EXTRACT_MESSAGES))
  if (dialog.length < 140) return []

  extractInFlight = true
  try {
    const raw = await chatOnce(settings, {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Диалог для анализа:\n\n${dialog}` },
      ],
      temperature: 0,
      maxTokens: 700,
    })
    const facts = parseFacts(raw)
    const saved: MemoryEntry[] = []
    for (const fact of facts) {
      const entry = await remember(fact.text, {
        kind: fact.kind,
        tags: fact.tags,
        source: 'auto',
        conversationId: input.conversationId,
      })
      if (entry) saved.push(entry)
    }
    debugLog('info', `Память: извлечено фактов — ${saved.length}`, [
      { facts: facts.length, saved: saved.length },
    ])
    return saved
  } catch (err) {
    debugLog('error', 'Память: авто-извлечение не удалось', [err])
    return []
  } finally {
    lastExtractAt = Date.now()
    extractInFlight = false
  }
}

/* ───────────────────────────── Экспорт и статистика ───────────────────── */

/** Память → Markdown (экспорт из UI). */
export function memoriesToMarkdown(entries: MemoryEntry[] = useMemory.getState().entries): string {
  const lines = ['# Память SYNTH', '', `Записей: ${entries.length}`, '']
  for (const entry of entries) {
    lines.push(`- ${entry.pinned ? '📌 ' : ''}${entry.text}`)
    const meta = [entry.kind, new Date(entry.updatedAt).toLocaleDateString('ru-RU')]
    if (entry.tags.length) meta.push(entry.tags.map((t) => `#${t}`).join(' '))
    lines.push(`  _${meta.join(' · ')}_`)
  }
  return `${lines.join('\n')}\n`
}

/** Быстрая статистика для настроек: сколько записей и объём текста. */
export function memoryStats(entries: MemoryEntry[] = useMemory.getState().entries): {
  count: number
  pinned: number
  chars: number
} {
  return {
    count: entries.length,
    pinned: entries.filter((e) => e.pinned).length,
    chars: entries.reduce((sum, e) => sum + e.text.length, 0),
  }
}

/** Импорт памяти из JSON-дампа (кнопка «Восстановить» в UI). */
export function parseMemoryDump(raw: string): MemoryEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const now = Date.now()
  const out: MemoryEntry[] = []
  for (const item of parsed) {
    const record = item as Partial<MemoryEntry>
    const text = cleanText(String(record?.text ?? ''))
    if (text.length < MIN_ENTRY_CHARS || looksLikeSecret(text)) continue
    out.push({
      id: typeof record.id === 'string' && record.id ? record.id : uid('mem'),
      text,
      kind: cleanKind(record.kind),
      tags: cleanTags(record.tags),
      pinned: Boolean(record.pinned),
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : now,
      source: record.source ?? 'manual',
      conversationId: typeof record.conversationId === 'string' ? record.conversationId : undefined,
      hits: typeof record.hits === 'number' ? record.hits : 0,
    })
  }
  return out
}

/** Полный дамп памяти для экспорта/бэкапа. */
export function memoryDump(entries: MemoryEntry[] = useMemory.getState().entries): string {
  return JSON.stringify(entries, null, 2)
}

/** Подписи видов записей — для UI. */
export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'факт',
  preference: 'предпочтение',
  project: 'проект',
  instruction: 'указание',
  note: 'заметка',
}

