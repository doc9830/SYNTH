/**
 * Аудит секретов (задача 05.3): ключи и токены не должны покидать приложение
 * и попадать в отладочный вывод.
 *
 * Проверяем все места, где данные выходят «наружу»:
 *   · экспорт чата — «копировать чат» и .md-файл (`exportChat`, `shareFiles`);
 *   · экспорт памяти — .md и .json (`memoryDump`, `memoriesToMarkdown`);
 *   · Debug Console (`debugLog` → `useDebug`);
 *   · текст ошибки и подробности в сообщении чата (`turnErrorForChat`);
 *   · сами правила вырезания (`redactSecrets`, `redactDeep`, `maskKeyShort`).
 *
 * Отдельная проверка — что правила не переусердствуют: обычный текст с словами
 * «ключ» и «токен» не должен превращаться в звёздочки.
 * Запуск: npm run checks
 */
import { debugLog, useDebug } from '@/lib/debug'
import { conversationToMarkdown } from '@/lib/exportChat'
import { memoryDump, memoriesToMarkdown } from '@/lib/memory'
import { looksLikeKey, maskKeyShort, redactDeep, redactSecrets } from '@/lib/redact'
import { conversationToShareMarkdown } from '@/lib/shareFiles'
import type { ChatMessage, Conversation, MemoryEntry } from '@/types'
import { ApiError, turnErrorForChat } from '@/providers/openai/errors'
import { check, finish } from './harness'

const KEY = 'sk-live-1234567890abcdefghijkl'
const ANTHROPIC_KEY = 'sk-ant-api03-abcdefghijklmnopqrst'

// 1. Формы ключей: что считаем секретом, а что обычным текстом
check('OpenAI-ключ распознаётся', looksLikeKey(`мой ключ ${KEY}`))
check('Bearer-токен распознаётся', looksLikeKey('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9'))
check('ключ GitHub распознаётся', looksLikeKey('ghp_abcdefghijklmnopqrstuvwx'))
check('русский текст про ключ секретом не считается', !looksLikeKey('ключ от квартиры, где деньги лежат'))

// 2. Маскирование для логов: «sk-…abcd»
check('длинный ключ маскируется с хвостом', maskKeyShort(KEY) === 'sk-…ijkl')
check('короткий ключ маскируется целиком', maskKeyShort('sk-123') === 's…')
check('пустой ключ остаётся пустым', maskKeyShort('   ') === '')

// 3. Вырезание из текста
const redacted = redactSecrets(
  [
    `Authorization: Bearer ${KEY}`,
    `api_key="${KEY}"`,
    `https://api.example.com/v1/chat?api_key=${KEY}&model=gpt`,
    'https://files.example.com/dl?token=abcdef123456&x=1',
    '{"apiKey":"' + KEY + '","x":"ok"}',
    'github: ghp_abcdefghijklmnopqrstuvwx',
    ANTHROPIC_KEY,
    'пароль: hunter2secret',
  ].join('\n'),
)
check('ключ не остался в очищенном тексте', !redacted.includes(KEY) && !redacted.includes(ANTHROPIC_KEY))
check('токен GitHub не остался', !redacted.includes('ghp_abcdefghijklmnopqrstuvwx'))
check('параметр api_key в URL обезврежен', redacted.includes('api_key=***'))
check('параметр token в URL обезврежен', redacted.includes('token=***'))
check('остальные параметры URL сохранены', redacted.includes('model=gpt') && redacted.includes('x=1'))
check('имя поля «api_key» остаётся читаемым', redacted.includes('api_key'))
check('JSON-поле apiKey обезврежено', redacted.includes('"apiKey":"***"'))
check('пароль обезврежен', redacted.includes('пароль: ***'))
check('обычный текст не портится', redactSecrets('расскажи про ключи и токены') === 'расскажи про ключи и токены')
check('пустая строка не ломает очистку', redactSecrets('') === '')

// 4. Рекурсивная очистка структур (payload запроса и ответ провайдера)
const payload = redactDeep({
  url: `https://api.example.com/v1/models?key=${KEY}`,
  headers: { Authorization: `Bearer ${KEY}`, 'x-api-key': KEY, 'content-type': 'application/json' },
  body: { messages: [{ role: 'user', content: `вот мой ключ ${KEY}` }], apiKey: KEY },
}) as { headers: Record<string, string>; body: { messages: Array<{ content: string }> } }
check('значение заголовка Authorization замаскировано', payload.headers.Authorization === maskKeyShort(`Bearer ${KEY}`))
check('заголовок x-api-key замаскирован', payload.headers['x-api-key'] === maskKeyShort(KEY))
check('прочие заголовки не тронуты', payload.headers['content-type'] === 'application/json')
check('ключ внутри тела запроса вырезан', !JSON.stringify(payload).includes(KEY))
check('токен в URL внутри структуры вырезан', !JSON.stringify(payload).includes(KEY))

// 5. Debug Console: дамп на экране отладки без секретов
debugLog('request', 'chat/completions', [
  { url: `/api/chat?api_key=${KEY}`, headers: { authorization: `Bearer ${KEY}` } },
  `ответ провайдера: ключ ${KEY} отклонён`,
])
const debugDump = JSON.stringify(useDebug.getState().entries)
check('в дампе отладки нет ключа', !debugDump.includes(KEY))
check('в дампе отладки нет Bearer-токена с ключом', !debugDump.includes(`Bearer ${KEY}`))
check('в дампе отладки остались служебные поля', debugDump.includes('chat/completions'))


// 6. Экспорт чата: «копировать» и .md-файл
const conversation: Conversation = {
  id: 'c-1',
  title: 'Секреты',
  model: 'gpt-4o-mini',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  messageCount: 1,
  pinned: false,
  preview: 'вот ключ, сохрани',
}
const secretMessages: ChatMessage[] = [
  { id: 'm-1', role: 'user', createdAt: 0, status: 'complete', content: `вот ключ ${KEY}, сохрани` },
  {
    id: 'm-2',
    role: 'assistant',
    createdAt: 0,
    status: 'error',
    content: 'не получилось',
    error: `401 Unauthorized: ключ ${KEY} не принят. POST https://api.example.com/v1/chat?key=${KEY}`,
  },
]
const copyMd = conversationToMarkdown(conversation, secretMessages)
check('«копировать чат»: ни одного ключа в markdown', !copyMd.includes(KEY))
check('«копировать чат» сохраняет структуру', copyMd.includes('## Пользователь') && copyMd.includes('## Ассистент'))
check('«копировать чат» сохраняет текст ошибки', copyMd.includes('401 Unauthorized'))
check('в URL из ошибки ключ заменён на звёздочки', copyMd.includes('chat?key=***'))
const shareMd = conversationToShareMarkdown(conversation, secretMessages, new Date('2026-01-02T03:04:05'))
check('экспорт .md чата без ключей', !shareMd.includes(KEY))

// 7. Экспорт памяти: и .md, и .json
const legacyMemory: MemoryEntry = {
  id: 'legacy',
  text: `ключ ${KEY} остался от старой версии`,
  kind: 'note',
  tags: ['sk-ant-abc', 'казань'],
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  source: 'manual',
  hits: 0,
}
check('экспорт памяти .md без ключа', !memoriesToMarkdown([legacyMemory]).includes(KEY))
check('экспорт памяти .json без ключа', !memoryDump([legacyMemory]).includes(KEY))
check('экспорт памяти не теряет остальные теги', memoryDump([legacyMemory]).includes('казань'))

// 8. Ошибка в чате: текст и подробности
const apiError = new ApiError({
  message: `Провайдер вернул 401: ключ ${KEY} не подходит`,
  status: 401,
  endpoint: `https://api.example.com/v1/chat?api_key=${KEY}`,
  hint: `Проверьте ключ ${KEY} в личном кабинете`,
  details: `{"error":{"message":"Incorrect API key provided: ${KEY}","headers":{"authorization":"Bearer ${KEY}"}}}`,
})
const chatError = turnErrorForChat(apiError)
check('сообщение об ошибке без ключа', !chatError.error.includes(KEY))
check('подробности ошибки без ключа', !chatError.errorDetails.includes(KEY))
check('подробности ошибки остаются JSON', JSON.parse(chatError.errorDetails).status === 401)
check('подсказка по ошибке сохранена', chatError.error.includes('личном кабинете'))

finish()
