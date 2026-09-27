/**
 * Проверки экспорта .md-файлов и отправки через системный sheet «Поделиться».
 *
 * Проверяем чистые функции: санитизацию имени (запись только в exports/, без
 * `..` и слэшей), слаг, расширение по языку, разбор блоков кода, склейку
 * в один файл, структуру экспорта чата (front-matter, tool-раунды, лимиты,
 * вложения-placeholder'ы без base64) и redaction секретов.
 * Запуск: npm run checks
 */
import type { ChatMessage, Conversation } from '@/types'
import {
  conversationShareFile,
  conversationToShareMarkdown,
  exportMarkdown,
  extractCodeBlocks,
  fileExtensionForLanguage,
  fileNameForBlock,
  filesFromMarkdown,
  firstSignificantLine,
  joinFilesToMarkdown,
  joinedFileFromMarkdown,
  redactSecrets,
  sanitizeFileName,
  slugify,
  stampFileName,
  uniqueFileNames,
} from '@/lib/shareFiles'
import { check, finish } from './harness'

// 1. Санитизация имени: наружу отдаём имя, а не путь
check('слэши вырезаются', sanitizeFileName('/etc/passwd') === 'etc-passwd')
check('выход из папки через .. невозможен', sanitizeFileName('../../secret.md') === 'secret.md')
check('имя из одних точек отбрасывается', sanitizeFileName('..') === '')
check('запрещённые символы заменяются', sanitizeFileName('ТЗ: финал?.md') === 'ТЗ-финал.md')
check('ведущая точка убирается', sanitizeFileName('.hidden.md') === 'hidden.md')
check('кириллица сохраняется', sanitizeFileName('ТЗ.md') === 'ТЗ.md')
check('имя без расширения остаётся как есть', sanitizeFileName('промт') === 'промт')
check('длинное имя обрезается до 48 символов', sanitizeFileName(`${'я'.repeat(120)}.md`) === `${'я'.repeat(48)}.md`)
for (const evil of ['a/../../b.md', '../..', 'x/../y.md', '....md', '\\..\\win.md']) {
  const name = sanitizeFileName(evil)
  check(`в злом имени нет слэшей и ..: «${evil}» → «${name}»`, !name.includes('/') && !name.includes('..'))
}

// 2. Слаг от первой значащей строки
check('слаг из заголовка', slugify('ТЗ: генератор промтов!') === 'ТЗ-генератор-промтов')
check('пробелы превращаются в дефис', slugify('a   b') === 'a-b')
check('слаг обрезается до 48 символов', slugify('я'.repeat(80)).length === 48)
check('заголовок без # — первая значащая строка', firstSignificantLine('# ТЗ\n\nтекст') === 'ТЗ')
check('комментарий тоже годится', firstSignificantLine('// промт для модели') === 'промт для модели')
check('пустой текст — нет слага', firstSignificantLine('\n   \n') === '')

// 3. Расширение по языку блока
check('md → .md', fileExtensionForLanguage('md') === 'md')
check('markdown → .md', fileExtensionForLanguage('markdown') === 'md')
check('json → .json', fileExtensionForLanguage('json') === 'json')
check('tsx → .tsx', fileExtensionForLanguage('tsx') === 'tsx')
check('неизвестный язык → .md', fileExtensionForLanguage('brainfuck') === 'md')
check('пустой язык → .md', fileExtensionForLanguage('') === 'md')
check('инфо-строка с параметрами разбирается', fileExtensionForLanguage('ts title="x"') === 'ts')

// 4. Имя файла для блока
const fixedNow = new Date('2026-01-02T03:04:05')
check('имя блока — слаг + расширение', fileNameForBlock('md', '# Промт для ТЗ', fixedNow) === 'Промт-для-ТЗ.md')
check('без слага — <тип>-<дата>.md', fileNameForBlock('json', '   ', fixedNow) === 'json-2026-01-02-0304.md')
check('неизвестный язык без слага — md-дата', fileNameForBlock('', '', fixedNow) === 'md-2026-01-02-0304.md')
check('штамп даты без двоеточий', !stampFileName(fixedNow).includes(':'))

// 5. Разбор блоков кода из markdown
const markdown = ['Ответ:', '```md', '# ТЗ', 'текст', '```', '', '```json', '{"a":1}', '```'].join('\n')
const blocks = extractCodeBlocks(markdown)
check('два блока найдены', blocks.length === 2)
check('язык первого блока', blocks[0].language === 'md')
check('содержимое первого блока', blocks[0].code === '# ТЗ\nтекст')
check('содержимое второго блока', blocks[1].code === '{"a":1}')
check('~~~ тоже считается блоком', extractCodeBlocks('~~~ts\nlet a = 1\n~~~')[0]?.code === 'let a = 1')
check('незакрытый блок (стрим) тоже отдаём', extractCodeBlocks('```py\nprint(1)')[0]?.code === 'print(1)')
check('текст без блоков — пусто', extractCodeBlocks('просто текст').length === 0)

// 6. Файлы из сообщения
const twelve = Array.from({ length: 12 }, (_, i) => `\`\`\`md\n# Файл ${i + 1}\nтекст\n\`\`\``).join('\n\n')
check('12 md-блоков → 12 файлов', filesFromMarkdown(twelve, fixedNow).length === 12)
check('файлы непустые', filesFromMarkdown(twelve, fixedNow).every((f) => f.content.length > 0))
check('имена файлов уникальны', new Set(filesFromMarkdown(twelve, fixedNow).map((f) => f.name)).size === 12)
const plain = filesFromMarkdown('Обычный ответ без кода', fixedNow)
check('текст без блоков → один .md', plain.length === 1 && plain[0].name === 'Обычный-ответ-без-кода.md')
check('пустое сообщение → нет файлов', filesFromMarkdown('   ').length === 0)
check(
  'дубликаты имён получают хвост -2',
  uniqueFileNames([
    { name: 'a.md', content: '1' },
    { name: 'a.md', content: '2' },
  ])[1].name === 'a-2.md',
)

// 7. Склейка «одним файлом»
const joined = joinFilesToMarkdown(
  [
    { name: 'a.md', content: 'AAA' },
    { name: 'b.md', content: 'BBB' },
  ],
  'всё.md',
)
check('склейка содержит оба файла', joined.content.includes('AAA') && joined.content.includes('BBB'))
check(
  'разделители вида «# Файл 1: a.md»',
  joined.content.includes('# Файл 1: a.md') && joined.content.includes('# Файл 2: b.md'),
)
const joinedTwelve = joinedFileFromMarkdown(twelve, 'ответ', fixedNow)
check('«одним файлом» — ровно один .md', joinedTwelve.name === 'ответ-2026-01-02-0304.md')
check('в склеенном файле все 12 блоков', (joinedTwelve.content.match(/# Файл \d+:/g) ?? []).length === 12)


// 8. Экспорт чата: front-matter, роли, tool-раунды, вложения
const conversation: Conversation = {
  id: 'conv-1',
  title: 'ТЗ: генератор промтов',
  createdAt: 0,
  updatedAt: 0,
  pinned: false,
  model: 'deepseek-v4.1-flash',
  messages: [
    {
      id: 'm1',
      role: 'user',
      createdAt: 0,
      status: 'complete',
      content: 'Сделай ТЗ',
      attachments: [{ id: 'a1', name: 'макет.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAABBBB' }],
    } satisfies ChatMessage,
    {
      id: 'm2',
      role: 'assistant',
      createdAt: 0,
      status: 'complete',
      content: '```md\n# ТЗ\nтекст\n```',
      toolCalls: [
        {
          id: 't1',
          name: 'web_search',
          args: '{}',
          argsPretty: `{"q":"${'x'.repeat(600)}"}`,
          status: 'done',
          resultText: 'y'.repeat(2500),
          startedAt: 0,
        },
      ],
    } satisfies ChatMessage,
  ],
}
const chat = conversationToShareMarkdown(conversation, fixedNow)
check('front-matter: заголовок', chat.includes('title: "ТЗ: генератор промтов"'))
check('front-matter: дата ISO', chat.includes(`exported: ${fixedNow.toISOString()}`))
check('front-matter: модель', chat.includes('model: "deepseek-v4.1-flash"'))
check('front-matter: число сообщений', chat.includes('messages: 2'))
check('роли размечены', chat.includes('## Пользователь') && chat.includes('## Ассистент'))
check('вызов инструмента включён', chat.includes('### Вызов инструмента: web_search'))
check('результат инструмента включён', chat.includes('### Результат инструмента'))
check('аргументы обрезаны до 500 символов', !chat.includes('x'.repeat(501)) && chat.includes('…обрезано'))
check('результат обрезан до 2000 символов', !chat.includes('y'.repeat(2001)) && chat.includes('y'.repeat(2000)))
check(
  'вложения — placeholder, а не base64',
  chat.includes('](./attachment-1)') && !chat.includes('data:image/png') && !chat.includes('base64'),
)
check('список имён вложений есть', chat.includes('- attachment-1: макет.png'))
check('блоки кода в файле чата на месте', chat.includes('```md') && chat.includes('# ТЗ'))

// 9. Секреты не уезжают в файл
const secret = redactSecrets('api_key: "sk-abcdefgh12345678"\nAuthorization: Bearer abcdefgh123456\nключ sk-live-1234567890')
check('sk-ключи вырезаются', !secret.includes('sk-abcdefgh12345678') && !secret.includes('sk-live-1234567890'))
check('Bearer-токены вырезаются', !secret.includes('Bearer abcdefgh123456'))
const secretChat = conversationToShareMarkdown(
  {
    ...conversation,
    messages: [{ id: 'm', role: 'user', createdAt: 0, status: 'complete', content: 'sk-abcdefgh12345678' }],
  },
  fixedNow,
)
check('секреты не попадают в экспорт чата', !secretChat.includes('sk-abcdefgh12345678'))

// 10. Имя файла для кнопки «Поделиться чатом»
const chatFile = conversationShareFile(conversation, fixedNow)
check('имя файла чата: слаг-дата.md', chatFile.name === 'ТЗ-генератор-промтов-2026-01-02-0304.md')
check('содержимое файла чата — тот же markdown', chatFile.content === chat)
check('в имени файла чата нет слэшей', !chatFile.name.includes('/'))

// 11. Пустой набор файлов не создаёт файл (и не открывает sheet)
void exportMarkdown([])
  .then((result) => {
    check('пустой экспорт не открывает sheet', !result.ok && result.files.length === 0)
    finish()
  })
  .catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })

