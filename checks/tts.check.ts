/**
 * Проверка озвучки: разбор markdown на фрагменты, сопоставление для подсветки,
 * тексты сообщений о недоступности TTS, видимость кнопки и поведение нажатия
 * (задача 06).
 *
 * Запуск: npm run checks
 *
 * Чистая логика проверяется напрямую (`src/lib/ttsText.ts`, тексты `src/lib/tts.ts`),
 * а поведение кнопки — на поддельном `speechSynthesis`: настоящий системный движок
 * в Node не воспроизводится.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { useSpeech } from '@/lib/useSpeech'
import { useToasts } from '@/lib/toast'
import {
  MAX_CHUNK,
  blockMatches,
  normalizeForMatch,
  speechChunks,
  stripInline,
} from '@/lib/ttsText'
import { describeTtsNetwork, describeTtsUnavailable, ttsSupported } from '@/lib/tts'
import { check, finish } from './harness'

const texts = (markdown: string) => speechChunks(markdown).map((c) => c.text)
const keys = (markdown: string) => speechChunks(markdown).map((c) => c.key)

// ── Абзацы и переносы ──────────────────────────────────────────────────

check('пустой ответ — читать нечего', speechChunks('').length === 0)
check('только пробелы — читать нечего', speechChunks('   \n\n  \t ').length === 0)
check('абзацы разделяются пустой строкой', texts('Первый абзац.\n\nВторой абзац.').length === 2)
check(
  'строки одного абзаца склеиваются',
  texts('строка один\nстрока два')[0] === 'строка один строка два',
)
check(
  'переносы и лишние пробелы схлопываются',
  texts('слово   с    пробелами')[0] === 'слово с пробелами',
)

// ── Инлайн-разметка ────────────────────────────────────────────────────

check('жирный текст читается без звёздочек', texts('Это **важно** и всё.')[0] === 'Это важно и всё.')
check('курсив без подчёркиваний', texts('Это _важно_ и всё.')[0] === 'Это важно и всё.')
check('зачёркивание без тильд', texts('Это ~~старое~~ слово.')[0] === 'Это старое слово.')
check('ссылка читается текстом', texts('[документ](https://a.b/c) готов')[0] === 'документ готов')
check('картинка читается подписью', texts('![схема](pic.png)')[0] === 'схема')
check('инлайн-код без бэктиков', texts('Файл `main.ts` создан.')[0] === 'Файл main.ts создан.')
check('html-тег не произносится', texts('Текст <br/> дальше')[0] === 'Текст дальше')
check('экранирование markdown снимается', texts('Знак \\* звёздочка')[0] === 'Знак * звёздочка')
check('сущности раскрываются', texts('a &amp; b')[0] === 'a & b')
check('snake_case не портится', stripInline('имя memory_store_fact тут') === 'имя memory_store_fact тут')

// ── Блоки: код, заголовки, списки, цитаты, таблицы ─────────────────────

check('блок кода не читается', speechChunks('```ts\nconst a = 1\n```').length === 0)
check(
  'текст вокруг блока кода читается',
  texts('До кода.\n\n```\nconst a = 1\n```\n\nПосле кода.').join('|') === 'До кода.|После кода.',
)
check('незакрытый блок кода не читается', speechChunks('```\nconst a = 1').length === 0)
check('заголовок читается без решёток', texts('## Итоги месяца')[0] === 'Итоги месяца')
check('пункт списка без маркера', texts('- первый пункт')[0] === 'первый пункт')
check('нумерованный список без номера', texts('1. первый пункт')[0] === 'первый пункт')
check('цитата без угольника', texts('> цитата дня')[0] === 'цитата дня')
check('линия-разделитель не читается', speechChunks('---').length === 0)
check('строка таблицы читается ячейками', texts('| a | b |')[0] === 'a — b')
check('шапка таблицы (разделитель) не читается', speechChunks('| --- | :--: |').length === 0)

// ── Ключи подсветки ────────────────────────────────────────────────────

check('ключ нормализован (нижний регистр, ё→е)', keys('Он пошёл вперёд!')[0] === 'он пошел вперед')
check(
  'ключ без пунктуации',
  normalizeForMatch('Раз, два — три.') === 'раз два три',
)
check('ключи непустые', speechChunks('## Заголовок\n\nТекст.').every((c) => c.key.length > 0))
check('ключ совпадает с нормализованным текстом', keys('Привет, мир!')[0] === 'привет мир')

// ── Подсветка: сопоставление блока и фрагмента ─────────────────────────

check('точное совпадение подсвечивается', blockMatches('Привет, мир!', 'привет мир'))
check('совпадение без пунктуации', blockMatches('Привет — мир', 'привет мир'))
check('регистр и ё не мешают', blockMatches('Всё пошло вперёд', normalizeForMatch('всё пошло вперед')))
check('короткий фрагмент не подсвечивает всё подряд', !blockMatches('привет мир и все', 'привет'))
/** Длинный абзац режется на фрагменты — каждый должен вернуть подсветку. */
const longBlock = `Начало длинного абзаца про всё ${'слово '.repeat(120)}конец.`
const longBlockParts = speechChunks(longBlock)
check(
  'длинный абзац: каждый фрагмент подсвечивает этот абзац',
  longBlockParts.length > 1 &&
    longBlockParts.every((c) => blockMatches(longBlock, c.key)) &&
    longBlockParts[1].key !== normalizeForMatch(longBlock),
)
check(
  'длинный абзац: фрагменты не совпадают с чужим текстом',
  !longBlockParts.some((c) => blockMatches('Совсем другой абзац про всё остальное', c.key)),
)
check('чужой текст не подсвечивается', !blockMatches('Совсем другой текст', 'привет мир'))
check('пустой ключ ничего не подсвечивает', !blockMatches('Привет, мир!', ''))

// ── Длинные абзацы и отзывчивость «стоп» ───────────────────────────────

const longSentence = `${'слово '.repeat(200)}конец`.trim()
const longChunks = speechChunks(longSentence)
check('очень длинный абзац режется на части', longChunks.length > 1)
check(
  'каждый фрагмент не длиннее предела',
  longChunks.every((c) => c.text.length <= MAX_CHUNK),
)
check(
  'ничего не потерялось при нарезке',
  longChunks.map((c) => c.text).join(' ') === longSentence,
)

const twoSentences = `${'А'.repeat(250)}. ${'Б'.repeat(250)}.`
check('длинные предложения не склеиваются в один фрагмент', speechChunks(twoSentences).length === 2)

// ── Сообщения о недоступности ──────────────────────────────────────────

check('движка нет — понятное сообщение', Boolean(describeTtsUnavailable({ available: false })))
check('нет русского голоса — понятное сообщение', Boolean(describeTtsUnavailable({ available: false, reason: 'no-ru-voice' })))
check('таймаут инициализации — понятное сообщение', Boolean(describeTtsUnavailable({ available: false, reason: 'init-timeout' })))
check('движок доступен — сообщений нет', describeTtsUnavailable({ available: true }) === null)
check(
  'сетевой голос предупреждает один раз',
  Boolean(describeTtsNetwork({ available: true, needsNetwork: true })) &&
    describeTtsNetwork({ available: true, needsNetwork: false }) === null,
)
check('в Node синтеза речи нет (нет window)', !ttsSupported())

// ── Видимость озвучки в интерфейсе ─────────────────────────────────────
//
// Пользователь не находил озвучку: строка кнопок у сообщения показывалась
// только по наведению (на телефоне наведения нет), а сама кнопка «Озвучить»
// молча исчезала, если движка или русского голоса не было. Собранный интерфейс
// в Node не воспроизводится, поэтому держим это проверками по исходникам.

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), 'utf8')

const messageItem = source('ui/MessageItem.tsx')
check(
  'кнопка «Озвучить» больше не исчезает: при недоступности она приглушена',
  messageItem.includes("className={ready || active ? undefined : 'opacity-50'}") &&
    !messageItem.includes('if (!canSpeak(info)) return null'),
)
check(
  'кнопка есть, пока на платформе вообще есть синтез речи',
  messageItem.includes('if (!ttsSupported()) return null'),
)
check(
  'строки кнопок помечены классом msg-actions (обе)',
  (messageItem.match(/className="msg-actions [^"]*opacity-0[^"]*"/g) ?? []).length === 2,
)

const css = source('index.css')
check(
  'на устройствах без курсора строка кнопок видна сразу',
  /@media \(hover: none\) \{\s*\.msg-actions \{\s*opacity: 1;/.test(css),
)

const speechStore = source('lib/useSpeech.ts')
check(
  'нажатие на приглушённую кнопку объясняет причину, а не молчит',
  speechStore.includes('describeTtsUnavailable(get().info') && speechStore.includes('ensureProbe(true)'),
)
check(
  'результат проверки движка попадает в диагностику',
  speechStore.includes('debugLog('),
)
check(
  'проверку движка можно повторить (голос поставили после запуска)',
  /ensureProbe: \(force = false\)/.test(speechStore),
)

const entry = source('main.tsx')
check(
  'в APK service worker не регистрируется — иначе отдаётся старый бандл',
  entry.includes('looksNativeShell()') && /else \{\s*registerSW\(\{ immediate: true \}\)/.test(entry),
)

// ── Нажатие кнопки озвучки (веб-ветка, с поддельным speechSynthesis) ────
//
// Проверяем то, на что жалуются пользователи: «кнопки нет». Кнопка есть всегда,
// а по нажатию должно быть либо чтение, либо понятное объяснение — но никогда
// молчание. Поддельный `window` ставим здесь, поэтому проверки выше, которые
// считают, что синтеза речи нет, уже отработали.

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  voice: unknown
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  constructor(text: string) {
    this.text = text
  }
}

const voices: { name: string; lang: string }[] = []
let spoken: string[] = []

/** Пауза: настоящее событие `onend` приходит асинхронно, как и в браузере. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fakeSynth = {
  cancel: () => {
    /* нет очереди: озвучка мгновенная */
  },
  speak: (utterance: FakeUtterance) => {
    spoken.push(utterance.text)
    setTimeout(() => utterance.onend?.(), 1)
  },
  getVoices: () => voices,
  addEventListener: () => {
    /* голоса появляются только по нашей команде */
  },
  removeEventListener: () => {
    /* см. выше */
  },
}

const fakeGlobal = globalThis as Record<string, unknown>
fakeGlobal.window = globalThis
fakeGlobal.location = { protocol: 'https:', hostname: 'example.com', href: 'https://example.com/' }
fakeGlobal.SpeechSynthesisUtterance = FakeUtterance
fakeGlobal.speechSynthesis = fakeSynth

check('в браузере синтез речи считается доступным', ttsSupported())

await useSpeech.getState().ensureProbe()
const noVoice = useSpeech.getState().info
check(
  'пустой список голосов — «нет русского голоса», а не «движка нет»',
  noVoice?.available === false && noVoice.reason === 'no-ru-voice',
)

const toastsBefore = useToasts.getState().items.length
spoken = []
await useSpeech.getState().toggle('msg-1', 'Первый абзац.\n\nВторой абзац.')
check('без русского голоса нажатие ничего не читает', spoken.length === 0)
check(
  'нажатие объясняет причину, а не молчит',
  useToasts
    .getState()
    .items.slice(toastsBefore)
    .some((toast) => /русск/i.test(toast.message)),
)
check('состояние кнопки осталось спокойным', useSpeech.getState().status === 'idle')

// Голос поставили в настройках Android и вернулись в приложение: чтение должно
// начаться с этого же нажатия, без перезапуска.
voices.push({ name: 'ru-offline', lang: 'ru-RU' })
spoken = []
await useSpeech.getState().toggle('msg-1', 'Первый абзац.\n\nВторой абзац.')
await delay(60)
check('после появления голоса фрагменты прочитаны', spoken.length === 2)
check(
  'чтение дошло до конца и отпустило кнопку',
  useSpeech.getState().status === 'idle' && useSpeech.getState().messageId === null,
)

spoken = []
fakeSynth.speak = (utterance: FakeUtterance) => {
  spoken.push(utterance.text)
  setTimeout(() => utterance.onend?.(), 30)
}
const longText = `${'слово '.repeat(60)}конец`
void useSpeech.getState().toggle('msg-2', longText)
await delay(5)
check('чтение длинного ответа началось', useSpeech.getState().status !== 'idle')
await useSpeech.getState().stop()
await delay(60)
check(
  '«стоп» обрывает чтение и не читает остаток',
  useSpeech.getState().status === 'idle' && spoken.length === 1,
)

finish()
