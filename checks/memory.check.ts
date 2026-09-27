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
  containment,
  looksLikeSecret,
  memoryDump,
  memoryDuplicateReport,
  memoryStats,
  memoriesToMarkdown,
  parseFacts,
  parseMemoryDump,
  parseRememberCommand,
  searchMemory,
  shouldMerge,
  similarity,
  tokenize,
  useMemory,
  type AddMemoryInput,
} from '@/lib/memory'
import { stemRu } from '@/lib/stemRu'
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

// 7. морфология: формы одного слова — не разные факты
check('стеммер: падежи одного слова дают одну основу', stemRu('погоду') === stemRu('погода'))
check('стеммер: глаголы приводятся к общей основе', stemRu('работает') === stemRu('работать') && stemRu('работать') === stemRu('работа'))
check('стеммер: «ё» и «е» не создают разные слова', stemRu('живёт') === stemRu('живет'))
check('стеммер: короткие слова не режутся', stemRu('кофе') === 'кофе' && stemRu('год') === 'год')
check('стеммер: латиница не трогается', stemRu('TypeScript') === 'typescript')
check(
  'токенизация даёт одну основу для «погода»/«погоду»',
  tokenize('погода в Казани').join(' ') === tokenize('погоду в Казани').join(' '),
)
check('вложенность короткого факта считается', containment('работает в Казани', 'работает в Казани уже год') === 1)
check('сходство одинаковых фраз — 1', similarity('какая погода в Казани', 'какая погода в Казани') === 1)

// Поиск по памяти идёт по основам: запрос «погода» находит запись про «погоду».
const probeBefore = entries()
useMemory.setState({
  entries: [
    ...probeBefore,
    { ...probeBefore[0], id: 'probe-weather', text: 'пользователь следит за погодой в Казани', tags: [] },
  ],
})
check('поиск находит запись по другой форме слова', searchMemory('погода').some((e) => e.id === 'probe-weather'))
useMemory.setState({ entries: probeBefore })

/**
 * Тестовый набор пар фактов для порогов склейки (задача 05.1).
 * Левая часть — запись в памяти, правая — новый факт; `true` = должны слиться.
 * Набор фиксирует пороги (`SIMILARITY_MERGE` 0.66 и `CONTAINMENT_MERGE` 0.8
 * с минимум двумя общими основами): при 0.60 и ниже появляются лишние склейки
 * («живёт в Казани» / «работает в Казани» — Jaccard 0.50), а без вложенности
 * не сливались уточнения («работает в Казани» / «работает в Казани уже год»).
 * Реальную память по этому правилу считает `npm run memory:dupes`.
 */
const MERGE_CASES: Array<[string, string, boolean]> = [
  ['работает в Казани', 'работает в Казани уже год', true],
  ['пользователь живёт в Казани', 'пользователь живет в казани', true],
  ['предпочитает короткие ответы', 'предпочитает короткие ответы на русском', true],
  ['пишет код на TypeScript', 'пишет код на TypeScript и Rust', true],
  ['предпочитает краткие ответы', 'предпочитает краткие ответы без воды', true],
  ['работает удалённо', 'работает удалённо из дома', true],
  ['читает книги', 'читает книги по вечерам', true],
  ['люблю кофе', 'люблю кофе и собак', true],
  ['учит английский язык', 'учит английский язык каждый день', true],
  ['любит кофе', 'любит собак', false],
  ['работает программистом', 'отдыхает на даче', false],
  ['пишет на TypeScript', 'пишет на Python', false],
  ['пользователь живёт в Казани', 'пользователь живёт в Москве', false],
  ['проект называется SYNTH', 'проект называется Другое', false],
  ['использует Android', 'использует iOS', false],
  ['любит тёмную тему', 'любит светлую тему', false],
  ['у пользователя есть кот', 'у пользователя есть собака', false],
  ['работает в Казани', 'живёт в Казани', false],
  ['изучает Rust', 'изучает Go', false],
  ['говорит по-русски', 'говорит по-английски', false],
  ['фронтенд на React', 'бэкенд на Node', false],
  ['сервер в Финляндии', 'сервер в Германии', false],
  ['пользуется DeepSeek', 'пользуется OpenAI', false],
  ['у него аллергия на пыль', 'у него аллергия на пыльцу', false],
  ['занимается спортом', 'занимается музыкой', false],
  ['живёт в Казани', 'работал в Казани', false],
  ['дом в деревне', 'дача в деревне', false],
  ['пьёт чай без сахара', 'пьёт кофе без сахара', false],
]

const missedMerges: string[] = []
const wrongMerges: string[] = []
for (const [a, b, expected] of MERGE_CASES) {
  if (shouldMerge(a, b) === expected) continue
  const score = `Jaccard ${similarity(a, b).toFixed(2)}, вложенность ${containment(a, b).toFixed(2)}`
  if (expected) missedMerges.push(`«${a}» ~ «${b}» (${score})`)
  else wrongMerges.push(`«${a}» ~ «${b}» (${score})`)
}
/** Печатает проблемные пары и говорит, прошла ли проверка. */
function mergeSetReport(lines: string[]): boolean {
  if (lines.length) console.log(lines.join('\n'))
  return lines.length === 0
}

const mergeCases = MERGE_CASES.filter(([, , expected]) => expected).length
check(`уточнения сливаются (${mergeCases} пар из набора)`, mergeSetReport(missedMerges))
check(`разные факты не сливаются (${MERGE_CASES.length - mergeCases} пар из набора)`, mergeSetReport(wrongMerges))
check(
  'форма одного слова больше не даёт дубль, но разные факты не склеиваются',
  !shouldMerge('пользователь живёт в Казани и работает в Яндексе', 'пользователь живёт в Казани и учится в КФУ'),
)

// 8. отчёт по дублям: считаем, но ничего не удаляем
const duplicateReport = memoryDuplicateReport([
  ...entries(),
  { ...entries()[0], id: 'dup-1', text: 'Пользователь живёт в Казани и работает программистом давно' },
  { ...entries()[1], id: 'dup-2', text: 'Пользователь предпочитает короткие ответы' },
])
check('отчёт по дублям видит склейки', duplicateReport.merged === 2 && duplicateReport.kept === 2)
check('отчёт по дублям не удаляет записи', entries().length === 2)
check('отчёт по дублям перечисляет пары с оценками', duplicateReport.pairs.every((p) => p.score > 0))

// 9. экспорт памяти: секреты вырезаются, даже если запись пришла из старой версии
const legacyEntry = {
  ...entries()[0],
  id: 'legacy',
  text: 'ключ доступа sk-live-1234567890 остался от старой версии',
  tags: ['sk-ant-abcdefghijklmnop'],
}
const legacyMd = memoriesToMarkdown([legacyEntry])
const legacyJson = memoryDump([legacyEntry])
check('экспорт памяти в .md без ключа в тексте', !legacyMd.includes('sk-live-1234567890'))
check('экспорт памяти в .md без ключа в тегах', !legacyMd.includes('sk-ant-abcdefghijklmnop'))
check('экспорт памяти в .json без ключей', !legacyJson.includes('sk-live-1234567890') && !legacyJson.includes('sk-ant-abcdefghijklmnop'))
check('экспорт памяти остаётся валидным JSON', parseMemoryDump(legacyJson).length === 1)

// 10. очистка
try {
  await useMemory.getState().clear()
} catch {
  useMemory.setState({ entries: [] })
}
check('память очищается', entries().length === 0)

finish()
