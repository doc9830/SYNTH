/**
 * Проверка долговременной памяти: команда «запомни», секреты, дедуп, контекст, экспорт, очистка.
 * Запуск: npm run checks
 *
 * В Node нет IndexedDB, поэтому записи в стор идут под try/catch: состояние меняется до обращения
 * к базе, а логику проверяем по состоянию стора.
 */
import {
  MEMORY_KIND_LABELS,
  buildMemoryContext,
  looksLikeSecret,
  memoryDump,
  memoryStats,
  memoriesToMarkdown,
  parseFacts,
  parseMemoryDump,
  parseRememberCommand,
  searchMemory,
  useMemory,
  type AddMemoryInput,
} from '@/lib/memory'
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings'
import { check, finish } from './harness'

/** add() пишет в IndexedDB — в Node её нет, ошибку базы глотаем. */
const add = async (text: string, input?: AddMemoryInput) => {
  try {
    return await useMemory.getState().add(text, input)
  } catch {
    return null
  }
}
const entries = () => useMemory.getState().entries

// 1. команда «запомни»
check('«запомни, что …» распознаётся', parseRememberCommand('запомни, что я живу в Казани') === 'я живу в Казани')
check('«запомни: …» распознаётся', parseRememberCommand('запомни: я пишу на TypeScript') === 'я пишу на TypeScript')
check('«чтобы» не съедается как «что»', parseRememberCommand('запомни чтобы купить хлеба на ужин') === 'чтобы купить хлеба на ужин')
check('«remember …» распознаётся', parseRememberCommand('remember I prefer short answers') === 'I prefer short answers')
check('обычный текст — не команда', parseRememberCommand('расскажи про Казань') === null)
check('слишком короткий хвост не принимаем', parseRememberCommand('запомни, что ок') === null)

// 2. секреты не сохраняются
check('API-ключ похож на секрет', looksLikeSecret('мой ключ sk-abcdefghijklmnop'))
check('пароль похож на секрет', looksLikeSecret('пароль от почты: hunter2'))
check('обычный факт секретом не считается', !looksLikeSecret('пользователь живёт в Казани'))
check('вид записи «заметка» подписан', MEMORY_KIND_LABELS.note === 'заметка')

// 3. запись фактов
await add('Пользователь живёт в Казани и работает программистом', { kind: 'fact', tags: ['город', 'работа'] })
await add('Пользователь предпочитает короткие ответы на русском', { kind: 'preference' })
await add('ключ доступа sk-aaaaaaaaaaaaaaaaaaaa')
await add('ок')
check('сохранены только осмысленные факты', entries().length === 2)
check('секрет не попал в память', !entries().some((e) => e.text.includes('sk-')))
check('теги записи сохранены', entries().some((e) => e.tags.includes('город')))
check('вид «предпочтение» сохранён', entries().some((e) => e.kind === 'preference'))

await add('Пользователь живёт в Казани и работает программистом уже давно')
check('похожая запись склеена, а не добавлена дважды', entries().length === 2)

const stats = memoryStats(entries())
check('статистика считает записи', stats.count === 2)
check('статистика считает символы', stats.chars > 40)

// 4. поиск и блок контекста
const found = searchMemory('Казани')
check('поиск по памяти находит запись', found.length >= 1 && found[0].text.includes('Казани'))
check('поиск по чужому запросу ничего не находит', searchMemory('бюджет на маркетинг').length === 0)

const offMemory: Settings = structuredClone(DEFAULT_SETTINGS)
check('память выключена — блок контекста пуст', buildMemoryContext(offMemory, 'где я живу?') === '')

const onMemory: Settings = structuredClone(DEFAULT_SETTINGS)
onMemory.memory.enabled = true
const ctx = buildMemoryContext(onMemory, 'напомни, где я живу?')
check('память включена — факты попадают в промпт', ctx.includes('Казани'))
check('блок контекста не превышает лимит', ctx.length <= onMemory.memory.maxChars + 400)

const tiny: Settings = structuredClone(onMemory)
tiny.memory.maxInjected = 1
tiny.memory.maxChars = 200
check('лимит записей соблюдается', buildMemoryContext(tiny, 'что я предпочитаю?').length <= 600)

// 5. экспорт и импорт (бэкап)
const json = memoryDump(entries())
const restored = parseMemoryDump(json)
check('JSON-дамп восстанавливается без потерь', restored.length === 2 && restored.some((e) => e.text.includes('Казани')))
check('битый дамп не ломает импорт', parseMemoryDump('не json').length === 0)

const md = memoriesToMarkdown(entries())
check('markdown-экспорт содержит факт', md.includes('Казани') && md.startsWith('#'))
check('markdown-экспорт помечает вид записи', md.includes('preference'))

// 6. извлечение фактов из ответа модели
const raw =
  '```json\n[{"text":"пользователь пишет на TypeScript","kind":"fact","tags":["стек"]},' +
  '{"text":"sk-abcdefghijklmnopqrst","kind":"fact"},{"text":"ок","kind":"fact"}]\n```'
const facts = parseFacts(raw)
check('извлечён только годный факт', facts.length === 1 && facts[0].text.includes('TypeScript'))
check('теги факта нормализованы', facts[0].tags.length === 1)
check('мусорный ответ модели не ломает разбор', parseFacts('никакого массива').length === 0)

// 7. очистка
try {
  await useMemory.getState().clear()
} catch {
  useMemory.setState({ entries: [] })
}
check('память очищается', entries().length === 0)

finish()
