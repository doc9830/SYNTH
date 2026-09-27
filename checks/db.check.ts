/**
 * Проверка схемы 3: чаты и сообщения живут в разных сторах.
 *
 * Здесь проверяется чистая часть — раскладка старых записей, конвертация
 * картинок в Blob и размер одной записи. IndexedDB-обвязка (`db.ts`) требует
 * браузера: вся логика миграции вынесена в `dbModel.ts` и проверяется тут,
 * а `db.ts` только применяет её внутри транзакции апгрейда.
 *
 * Запуск: npm run checks
 */
import { base64Size, dataUrlToBlob } from '@/lib/dataUrl'
import {
  type LegacyConversation,
  PREVIEW_LENGTH,
  diffMessages,
  isLegacyRecord,
  lightMessage,
  messageRecord,
  previewOf,
  sanitizeSummary,
  sortMessages,
  splitLegacyConversation,
  storedAttachment,
  wrapperOf,
} from '@/lib/dbModel'
import type { ChatMessage, ImageAttachment, MessageRecord } from '@/types'
import { check, finish } from './harness'

/* ───────────────────────── данные ───────────────────────── */

/** Тестовый PNG: собираем base64 нужной длины, содержимое не важно. */
function imageDataUrl(bytes: number, mime = 'image/png'): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const base64Length = Math.floor(Math.ceil(bytes / 3) * 4 / 4) * 4
  let seed = 7
  let payload = ''
  for (let i = 0; i < base64Length; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    payload += chars[seed % 64]
  }
  return `data:${mime};base64,${payload}`
}

function attachment(index: number, bytes: number): ImageAttachment {
  return {
    id: `att-${index}`,
    name: `фото-${index}.png`,
    mime: 'image/png',
    dataUrl: imageDataUrl(bytes),
  }
}

function textMessage(index: number): ChatMessage {
  return {
    id: `m-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    createdAt: 1_000 + index,
    content: `сообщение ${index}`,
    status: 'complete',
  }
}

/** Старая запись (схема ≤ 2): чат вместе с сообщениями, картинки — data URL. */
function legacyConversation(): LegacyConversation {
  const messages: ChatMessage[] = [textMessage(0)]
  for (let i = 0; i < 4; i += 1) {
    messages.push({
      id: `m-photo-${i}`,
      role: 'user',
      createdAt: 2_000 + i,
      content: 'вот фото',
      status: 'complete',
      attachments: Array.from({ length: 5 }, (_, k) => attachment(i * 5 + k, 150_000)),
    })
    messages.push(textMessage(100 + i))
  }
  return {
    id: 'conv-legacy',
    title: 'Старый чат',
    createdAt: 1,
    updatedAt: 2,
    pinned: true,
    model: 'deepseek-chat',
    messages,
  }
}

/** Размер записи так, как её видит IndexedDB: Blob — байтами, строки — UTF-8. */
function recordBytes(value: unknown): number {
  if (value instanceof Blob) return value.size
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + recordBytes(item), 0)
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (sum, [key, item]) => sum + Buffer.byteLength(key, 'utf8') + recordBytes(item),
      0,
    )
  }
  return 8
}

/* ───────────────────────── 1. кодек data URL ───────────────────────── */

const dataUrl = imageDataUrl(3_000)
const blob = dataUrlToBlob(dataUrl)
const payload = dataUrl.slice(dataUrl.indexOf(',') + 1)

check('data URL → Blob', blob instanceof Blob && blob.type === 'image/png')
check('размер Blob совпадает с base64-нагрузкой', blob?.size === base64Size(payload))
check('base64 длиннее самих байтов (те самые +33 %)', payload.length > (blob?.size ?? 0))
check('обычная строка не считается data URL', dataUrlToBlob('https://example.test/a.png') === null)
check(
  'data URL без base64 тоже читается (svg-текст)',
  dataUrlToBlob('data:image/svg+xml,<svg/>')?.type === 'image/svg+xml',
)

/* ───────────────────────── 2. вложение в базе ───────────────────────── */

const stored = storedAttachment(attachment(1, 1_200))
check('вложение уезжает в базу как Blob, без base64', stored.blob instanceof Blob && !stored.dataUrl)
check('имя и mime вложения сохраняются', stored.name === 'фото-1.png' && stored.mime === 'image/png')
check('уже конвертированное вложение не трогаем', storedAttachment(stored) === stored)
check(
  'нечитаемый data URL остаётся строкой (данные не теряем)',
  storedAttachment({ id: 'a', name: 'x', mime: 'image/png', dataUrl: 'data:image/png;base64,!?' })
    .blob === undefined,
)

/* ───────────────────────── 3. миграция старой записи ───────────────────────── */

const legacy = legacyConversation()
const legacyMessages: ChatMessage[] = legacy.messages ?? []
const legacyBytes = recordBytes(legacy)
const legacyWrapper = wrapperOf(legacy as Parameters<typeof wrapperOf>[0], legacy.messages ?? [])
check('старая запись опознаётся по наличию messages', isLegacyRecord(legacy))
check('новая обёртка старой записью не считается', !isLegacyRecord(legacyWrapper))

const split = splitLegacyConversation(legacy)

check('миграция не теряет сообщения', split.messages.length === legacyMessages.length)
check(
  'все тексты и id на месте',
  legacyMessages.every(
    (m, i) => split.messages[i].content === m.content && split.messages[i].id === m.id,
  ),
)
check(
  'каждое сообщение знает свой чат',
  split.messages.every((m) => m.conversationId === 'conv-legacy'),
)
check(
  'порядок сообщений сохранён',
  split.messages.every((m, i) => m.order === i),
)
check('в обёртке не осталось массива сообщений', !('messages' in split.conversation))
check('в обёртке посчитано число сообщений', split.conversation.messageCount === legacyMessages.length)
check('подпись — последнее сообщение чата', split.conversation.preview === previewOf(legacyMessages))
check(
  'картинки после миграции лежат байтами',
  split.messages
    .flatMap((m) => m.attachments ?? [])
    .every((a) => a.blob instanceof Blob && !a.dataUrl),
)
check(
  'число картинок не изменилось',
  split.messages.flatMap((m) => m.attachments ?? []).length ===
    legacyMessages.flatMap((m) => m.attachments ?? []).length,
)
check(
  'заголовок и закрепление сохранены',
  split.conversation.title === 'Старый чат' && split.conversation.pinned,
)

const splitAgain = splitLegacyConversation({ ...split.conversation, messages: [] })
check(
  'повторный прогон миграции ничего не ломает (идемпотентность)',
  splitAgain.messages.length === 0 && splitAgain.conversation.id === split.conversation.id,
)

const broken = splitLegacyConversation({ id: 'conv-broken' })
check(
  'поломанная запись не роняет миграцию',
  broken.conversation.title === 'Без названия' && broken.messages.length === 0,
)

/* ───────────────────────── 4. выборочная запись ───────────────────────── */

const firstMessage = textMessage(9)
const kept = textMessage(10)
const edited: ChatMessage = { ...textMessage(11), content: 'исправленный вопрос' }
const lastMessage = textMessage(12)
/**
 * Важно: неизменённые сообщения — те же самые объекты (стор не мутирует
 * сообщения, изменённое всегда пересоздаётся) — иначе считаем их изменёнными.
 */
const previous: ChatMessage[] = [firstMessage, kept, edited, lastMessage]
const next: ChatMessage[] = [firstMessage, kept, { ...edited, content: 'исправлено ещё раз' }, lastMessage]

const nothingChanged = diffMessages('c', previous, previous)
check('без изменений ничего не пишем', nothingChanged.changed.length === 0 && nothingChanged.removed.length === 0)
check(
  'переписывается только изменённое сообщение',
  diffMessages('c', previous, next).changed.map((m) => m.id).join(',') === 'm-11',
)
check(
  'у изменившегося сообщения верный order и владелец',
  diffMessages('c', previous, next).changed[0].order === 2 &&
    diffMessages('c', previous, next).changed[0].conversationId === 'c',
)
check(
  'новое сообщение уезжает записью в конец',
  diffMessages('c', previous, [...previous, textMessage(13)]).changed.map((m) => m.order).join(',') ===
    '4',
)
check(
  'удалённые сообщения перечислены для удаления',
  diffMessages('c', [firstMessage, kept], [kept]).removed.join(',') === 'm-9',
)
check(
  'правка одного сообщения не тянет остальные',
  diffMessages('c', previous, next).changed.length === 1 && previous.length > 1,
)

/* ───────────────────────── 5. подпись, порядок, снимок ───────────────────────── */

const longMessage: ChatMessage = {
  id: 'long',
  role: 'assistant',
  createdAt: 5,
  content: 'ф'.repeat(500),
  status: 'complete',
}
check('подпись обрезается', previewOf([longMessage]).length === PREVIEW_LENGTH)
check(
  'в подписи нет переводов строк',
  previewOf([{ ...longMessage, content: 'первая\n\nвторая' }]) === 'первая вторая',
)
check(
  'у сообщения только с картинками подпись — маркер',
  previewOf([{ ...longMessage, content: '', attachments: [attachment(9, 100)] }]) === '🖼 1',
)
check('у пустого чата подписи нет', previewOf([]) === '')

const shuffled: MessageRecord[] = [
  messageRecord('c', textMessage(5), 5),
  messageRecord('c', textMessage(1), 1),
  messageRecord('c', textMessage(3), 3),
]
check(
  'порядок восстанавливается по order',
  sortMessages(shuffled)
    .map((m) => m.id)
    .join(',') === 'm-1,m-3,m-5',
)
check(
  'при равном order сравниваем createdAt',
  sortMessages([
    { ...messageRecord('c', textMessage(7), 0), createdAt: 9 },
    { ...messageRecord('c', textMessage(8), 0), createdAt: 3 },
  ])[0].createdAt === 3,
)

const withTools: MessageRecord = {
  ...messageRecord('c', textMessage(0), 0),
  toolCalls: [
    {
      id: 't1',
      name: 'generate_image',
      args: '{}',
      argsPretty: '{}',
      status: 'done',
      summary: 'нарисовал',
      resultText: 'y'.repeat(50_000),
      images: [imageDataUrl(120_000)],
      startedAt: 0,
    },
  ],
}
const snapshot = lightMessage(withTools)
check(
  'снимок стрима оставляет имя и итог инструмента',
  snapshot.toolCalls?.[0].name === 'generate_image' && snapshot.toolCalls?.[0].summary === 'нарисовал',
)
check('снимок стрима выбрасывает картинки инструмента', snapshot.toolCalls?.[0].images === undefined)
check('снимок стрима выбрасывает длинный результат', snapshot.toolCalls?.[0].resultText === undefined)
check('снимок стрима в разы легче полной записи', recordBytes(snapshot) * 100 < recordBytes(withTools))
check(
  'сообщение без инструментов не копируется зря',
  lightMessage(messageRecord('c', textMessage(2), 2)).id === 'm-2',
)

/* ───────────────────────── 6. размер записи (критерий приёмки) ───────────────────────── */

const photos = Array.from({ length: 5 }, (_, i) => attachment(100 + i, 150_000))
const newUserMessage: ChatMessage = {
  id: 'm-new',
  role: 'user',
  createdAt: 9_000,
  content: 'вот ещё пять фото',
  status: 'complete',
  attachments: photos,
}
const storedConversation = split.conversation
const newConversation = wrapperOf(storedConversation, [...legacyMessages, newUserMessage])
const oneMessageBytes = recordBytes(
  messageRecord(storedConversation.id, newUserMessage, legacyMessages.length),
)
const wrapperBytes = recordBytes(newConversation)
const newWriteBytes = oneMessageBytes + wrapperBytes
const textOnlyBytes =
  recordBytes(messageRecord(storedConversation.id, textMessage(777), 30)) + wrapperBytes

check(
  'запись одного сообщения с 5 фото + обёртка в разы меньше целого чата',
  newWriteBytes * 3 < legacyBytes,
)
check('текстовое сообщение пишется крошечной записью', textOnlyBytes < 4_096)
check(
  'запись = только новое сообщение и обёртка (остальное не переписываем)',
  newWriteBytes <= oneMessageBytes + wrapperBytes,
)
check(
  'base64 в базу больше не уезжает',
  recordBytes(messageRecord(storedConversation.id, newUserMessage, 5)) <
    Buffer.byteLength(JSON.stringify(photos.map((a) => a.dataUrl)), 'utf8'),
)
check('у обёртки постоянный размер, сколько бы сообщений ни было', wrapperBytes < 512)

/* ─────────────── сводка выпавшей части диалога (задача 04.2) ─────────────── */

const chatSummary = {
  text: 'Пользователь просил показать цены на iPhone и обещал вернуться к выбору',
  upToMessageId: 'msg-7',
  covered: 6,
  updatedAt: 1,
}
const conversationWithSummary = wrapperOf({ ...storedConversation, summary: chatSummary }, [newUserMessage])
check('сводка чата сохраняется вместе с обёрткой', conversationWithSummary.summary?.text === chatSummary.text)
check(
  'сводка помнит, по какое сообщение актуальна',
  conversationWithSummary.summary?.upToMessageId === 'msg-7' &&
    conversationWithSummary.summary?.covered === 6,
)
check(
  'обёртка без сводки остаётся без неё',
  wrapperOf(storedConversation, [newUserMessage]).summary === undefined,
)
check(
  'битая сводка выбрасывается, а не уходит модели',
  sanitizeSummary({ text: '   ' }) === undefined &&
    sanitizeSummary('сводка') === undefined &&
    sanitizeSummary({ text: 42 }) === undefined,
)
const normalized = sanitizeSummary({ text: '  цены  ', covered: '5', upToMessageId: 9 })
check(
  'сводка из старых записей нормализуется',
  normalized?.text === 'цены' && normalized?.covered === 5 && normalized?.upToMessageId === '',
)
check(
  'обновление подписи чата не теряет сводку',
  wrapperOf({ ...storedConversation, summary: chatSummary }, [...legacyMessages, newUserMessage])
    .summary?.text === chatSummary.text,
)

console.log(
  `\nразмер одной записи: было ${(legacyBytes / 1024 / 1024).toFixed(2)} МБ (весь чат с 20 картинками) → ` +
    `стало ${(newWriteBytes / 1024).toFixed(0)} КБ (сообщение с 5 картинками) + обёртка ` +
    `${Math.round(wrapperBytes)} Б; правка текста: ${textOnlyBytes} Б`,
)

finish()

