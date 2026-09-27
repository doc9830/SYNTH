/**
 * Экспорт .md-файлов и отправка через системный sheet «Поделиться».
 *
 * Единственная точка входа — exportMarkdown(): пишет файлы в Cache/exports/,
 * берёт file://-URI через Filesystem.getUri() и отдаёт их в Share.share().
 * В браузере — Web Share API, а если он не умеет файлы — обычное скачивание.
 *
 * Куда отправить, выбирает пользователь в системном sheet'е. Ничего не уходит
 * автоматически, новых разрешений не требуется: пишем в кэш приложения
 * (WRITE_EXTERNAL_STORAGE / MANAGE_EXTERNAL_STORAGE не нужны), наружу отдаём
 * через FileProvider с authority `${applicationId}.fileprovider`
 * (см. android/app/src/main/AndroidManifest.xml и res/xml/file_paths.xml).
 */
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { ChatMessage, Conversation } from '@/types'
import { downloadText } from './exportChat'
import { isNativeApp } from './nativeShell'

/** Папка экспорта внутри кэша приложения. За её пределы писать нельзя. */
export const EXPORTS_DIR = 'exports'
/** MIME по умолчанию: .md — это текстовый markdown, а не application/octet-stream. */
export const MARKDOWN_MIME = 'text/markdown'
/** Файлы старше этого срока удаляем при следующем экспорте — кэш не растёт. */
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Крупные файлы пишем чанками: одна строка на мегабайты валит мост Capacitor. */
const CHUNK_CHARS = 500_000
/** Лимиты для tool-раундов в экспорте чата (полные страницы в файл не тянем). */
const TOOL_ARGS_LIMIT = 500
const TOOL_RESULT_LIMIT = 2000
/** Максимальная длина слага в имени файла. */
const SLUG_LIMIT = 48

/** Файл, который нужно отдать наружу. */
export interface ShareFile {
  name: string
  content: string
}

export type ShareMethod = 'share' | 'download' | 'cancelled'

export interface ShareOutcome {
  ok: boolean
  method: ShareMethod
  /** Готовый текст для уведомления */
  message: string
  /** Имена отданных файлов (без путей) */
  files: string[]
}

export interface CodeBlock {
  language: string
  code: string
}

/** Запрещённые в имени файла символы + управляющие. */
const BAD_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]+/g

/**
 * Безопасное имя файла: без слэшей, без `..`, без ведущих точек.
 *
 * Экспорт всегда пишется в `exports/`, поэтому наружу передаётся имя, а не
 * путь: так исключена запись за пределы папки. Пустая строка — имя непригодно.
 */
export function sanitizeFileName(raw: string, limit = SLUG_LIMIT): string {
  const cleaned = raw.replace(BAD_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim()
  const noDots = cleaned.replace(/^\.+/, '').trim()
  if (!noDots) return ''

  const match = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(noDots)
  const ext = match?.[2]?.toLowerCase() ?? ''
  const baseRaw = match?.[1] ?? noDots

  const base = baseRaw
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, limit)
    .replace(/[.\-]+$/, '')

  if (!base) return ''
  return ext ? `${base}.${ext}` : base
}

/**
 * Слаг из произвольной строки: пробелы → `-`, оставляем латиницу, кириллицу,
 * цифры, `-`, `_` и точки. Обрезаем до ~48 символов.
 */
export function slugify(text: string, limit = SLUG_LIMIT): string {
  return text
    .replace(/[^\p{L}\p{N}._\s-]+/gu, ' ')
    .replace(/\s+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, limit)
    .replace(/[.\-]+$/, '')
}

/** Дата в формате ГГГГ-ММ-ДД-ЧЧмм — хвост имени файла. */
export function stampFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Первая значащая строка: заголовок или первый комментарий без префикса. */
export function firstSignificantLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:\/\/+|#+|\/\*+|\*+|<!--|;+|--+)+/, '').trim()
    if (line) return line
  }
  return ''
}

const EXTENSIONS: Record<string, string> = {
  md: 'md',
  markdown: 'md',
  mdown: 'md',
  mkdn: 'md',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  js: 'js',
  javascript: 'js',
  mjs: 'js',
  cjs: 'js',
  node: 'js',
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'py',
  python: 'py',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  xml: 'xml',
  svg: 'svg',
  yml: 'yml',
  yaml: 'yml',
  toml: 'toml',
  ini: 'ini',
  conf: 'conf',
  sql: 'sql',
  sh: 'sh',
  bash: 'sh',
  zsh: 'sh',
  shell: 'sh',
  console: 'txt',
  txt: 'txt',
  text: 'txt',
  plaintext: 'txt',
  csv: 'csv',
  tsv: 'csv',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  rs: 'rs',
  rust: 'rs',
  java: 'java',
  kt: 'kt',
  kotlin: 'kt',
  swift: 'swift',
  c: 'c',
  h: 'h',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'hpp',
  cs: 'cs',
  csharp: 'cs',
  php: 'php',
  rb: 'rb',
  ruby: 'rb',
  lua: 'lua',
  dart: 'dart',
  r: 'r',
  gradle: 'gradle',
  dockerfile: 'dockerfile',
  env: 'env',
}

/**
 * Расширение файла по языку блока кода.
 * Язык неизвестен или это обычный текст → `.md` (текст пишем как markdown).
 */
export function fileExtensionForLanguage(language: string): string {
  const key = language.trim().toLowerCase().replace(/^\.+/, '').split(/[\s,{:]/)[0] ?? ''
  return EXTENSIONS[key] ?? 'md'
}

/**
 * Имя файла для блока кода: слаг от первой значащей строки + расширение языка.
 * Слага нет (пусто/только символы) → `<тип>-<ГГГГ-ММ-ДД-ЧЧмм>.md`.
 */
export function fileNameForBlock(language: string, code: string, now = new Date()): string {
  const slug = slugify(firstSignificantLine(code))
  if (slug) return `${slug}.${fileExtensionForLanguage(language)}`
  const type = slugify(language) || 'md'
  return `${type}-${stampFileName(now)}.md`
}

/**
 * Fenced-блоки кода из markdown (` ``` ` и `~~~`).
 *
 * Незакрытый блок тоже отдаём: во время стрима ответа закрывающая кавычка
 * ещё не пришла, а поделиться блоком уже хочется.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  let open: { fence: string; language: string; body: string[] } | null = null

  for (const line of markdown.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!open) {
      if (fence) {
        open = { fence: fence[1], language: fence[2].trim().split(/\s+/)[0] ?? '', body: [] }
      }
      continue
    }
    const closes =
      fence !== null && fence[1][0] === open.fence[0] && fence[1].length >= open.fence.length && !fence[2].trim()
    if (closes) {
      blocks.push({ language: open.language, code: open.body.join('\n') })
      open = null
      continue
    }
    open.body.push(line)
  }

  if (open) blocks.push({ language: open.language, code: open.body.join('\n') })
  return blocks
}

/** Имена в наборе уникальны: одинаковые слаги получают хвост `-2`, `-3`… */
export function uniqueFileNames(files: ShareFile[]): ShareFile[] {
  const used = new Map<string, number>()
  return files.map((file) => {
    const seen = (used.get(file.name) ?? 0) + 1
    used.set(file.name, seen)
    if (seen === 1) return file
    const dot = file.name.lastIndexOf('.')
    const base = dot > 0 ? file.name.slice(0, dot) : file.name
    const ext = dot > 0 ? file.name.slice(dot) : ''
    return { ...file, name: `${base}-${seen}${ext}` }
  })
}

/** Сообщение → файлы: каждый блок кода отдельным файлом, иначе весь текст в .md. */
export function filesFromMarkdown(markdown: string, now = new Date()): ShareFile[] {
  const blocks = extractCodeBlocks(markdown)
  if (blocks.length) {
    return uniqueFileNames(
      blocks.map((block) => ({ name: fileNameForBlock(block.language, block.code, now), content: block.code })),
    )
  }

  const text = markdown.trim()
  if (!text) return []
  const slug = slugify(firstSignificantLine(text))
  const name = slug ? `${slug}.md` : `текст-${stampFileName(now)}.md`
  return [{ name, content: text }]
}

/** Склейка набора блоков в один .md с разделителями `# Файл N: имя`. */
export function joinFilesToMarkdown(files: ShareFile[], name: string): ShareFile {
  const body = files.map((file, i) => `# Файл ${i + 1}: ${file.name}\n\n${file.content.trim()}`).join('\n\n---\n\n')
  return { name, content: `${body}\n` }
}

/** Убирает из экспорта то, что наружу отдавать нельзя: ключи и токены. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***')
    .replace(
      /("?\b(?:api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|token|password|secret)\b"?\s*[:=]\s*"?)([^"'\s,;}]{4,})/gi,
      '$1***',
    )
}



/** Обрезка длинного текста с пометкой, что он обрезан. */
function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…обрезано`
}

/** Значение для front-matter: экранируем кавычки, чтобы YAML не сломался. */
function yamlValue(value: string): string {
  return JSON.stringify(value || '—')
}

/**
 * Один блок сообщения в экспорте: роль, текст, tool-раунды и вложения.
 * Вложения — только placeholder'ы и список имён, никакого base64.
 */
function messageSection(message: ChatMessage, counter: { n: number }): string[] {
  const lines: string[] = [message.role === 'user' ? '## Пользователь' : '## Ассистент', '']

  const text = message.content.trim()
  if (text) lines.push(text, '')

  for (const call of message.toolCalls ?? []) {
    lines.push(`### Вызов инструмента: ${call.name}`, '')
    const args = cut((call.argsPretty || call.args || '').trim(), TOOL_ARGS_LIMIT)
    if (args) lines.push(args, '')

    const result = cut((call.resultText || call.summary || call.error || '').trim(), TOOL_RESULT_LIMIT)
    if (result) lines.push('### Результат инструмента', '', result, '')
  }

  if (message.error) lines.push(`> Ошибка: ${cut(message.error, TOOL_RESULT_LIMIT)}`, '')

  const attachments = message.attachments ?? []
  if (attachments.length) {
    const first = counter.n + 1
    for (const attachment of attachments) {
      counter.n += 1
      lines.push(`![${attachment.name}](./attachment-${counter.n})`, '')
    }
    lines.push('Вложения:', '')
    attachments.forEach((attachment, i) => {
      lines.push(`- attachment-${first + i}: ${attachment.name}`)
    })
    lines.push('')
  }

  return lines
}

/**
 * Чат → Markdown для отправки файлом: front-matter + роли + tool-раунды.
 * Сообщения передаём отдельно: они живут в своей записи IndexedDB и грузятся
 * лениво, у обёртки чата их нет. `now` вынесен параметром, чтобы проверки
 * были детерминированными.
 */
export function conversationToShareMarkdown(
  conversation: Conversation,
  messages: ChatMessage[],
  now = new Date(),
): string {
  const counter = { n: 0 }
  const lines: string[] = [
    '---',
    `title: ${yamlValue(conversation.title)}`,
    `exported: ${now.toISOString()}`,
    `model: ${yamlValue(conversation.model || '—')}`,
    `messages: ${messages.length}`,
    '---',
    '',
  ]

  for (const message of messages) {
    lines.push(...messageSection(message, counter), '')
  }

  return `${redactSecrets(lines.join('\n')).trimEnd()}\n`
}

/** Файл для кнопки «Поделиться чатом»: `<слаг-заголовка>-<ГГГГ-ММ-ДД-ЧЧмм>.md`. */
export function conversationShareFile(
  conversation: Conversation,
  messages: ChatMessage[],
  now = new Date(),
): ShareFile {
  const slug = slugify(conversation.title) || 'чат'
  return {
    name: `${slug}-${stampFileName(now)}.md`,
    content: conversationToShareMarkdown(conversation, messages, now),
  }
}

/** «Одним файлом»: те же блоки, но склеенные в один .md с разделителями. */
export function joinedFileFromMarkdown(markdown: string, baseName: string, now = new Date()): ShareFile {
  const files = filesFromMarkdown(markdown, now)
  const slug = slugify(baseName) || 'файлы'
  return joinFilesToMarkdown(files, `${slug}-${stampFileName(now)}.md`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Пользователь закрыл системный sheet — это не ошибка, отдельный исход. */
function isCancel(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase()
  return message.includes('cancel') || message.includes('отмен')
}

/** Есть ли нативный Share (APK). В браузере идём через Web Share API. */
function nativeShareAvailable(): boolean {
  return isNativeApp()
}

/**
 * Запись файла в Cache/exports/ и file://-URI для FileProvider.
 * Файлы больше ~1 МБ пишем чанками: так мост Capacitor не упирается в лимит.
 */
async function writeNativeFile(file: ShareFile): Promise<string> {
  const path = `${EXPORTS_DIR}/${file.name}`
  const bytes = new TextEncoder().encode(file.content).length

  if (bytes <= CHUNK_CHARS) {
    await Filesystem.writeFile({
      path,
      data: file.content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    })
  } else {
    await Filesystem.writeFile({
      path,
      data: file.content.slice(0, CHUNK_CHARS),
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    })
    for (let offset = CHUNK_CHARS; offset < file.content.length; offset += CHUNK_CHARS) {
      await Filesystem.appendFile({
        path,
        data: file.content.slice(offset, offset + CHUNK_CHARS),
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      })
    }
  }

  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  if (!uri.startsWith('file:')) {
    throw new Error(`система вернула не file://-ссылку (${uri.slice(0, 40)}…), отправить её нельзя`)
  }
  return uri
}

let cleanupDone = false

/**
 * Удаляет из `exports/` файлы старше 7 дней (кэш не должен расти).
 * За пределами этой папки ничего не удаляем. Возвращает число удалённых файлов.
 */
export async function cleanupOldExports(now = Date.now()): Promise<number> {
  if (!nativeShareAvailable()) return 0

  const result = await Filesystem.readdir({ path: EXPORTS_DIR, directory: Directory.Cache })
  // на Android элементы — объекты, но старые сборки плагина отдавали строки
  const entries = result.files as Array<{ name?: string }>
  let removed = 0

  for (const entry of entries) {
    const name = entry?.name
    if (!name) continue
    const path = `${EXPORTS_DIR}/${name}`
    try {
      const stat = await Filesystem.stat({ path, directory: Directory.Cache })
      if (stat.mtime && now - stat.mtime > EXPORT_TTL_MS) {
        await Filesystem.deleteFile({ path, directory: Directory.Cache })
        removed += 1
      }
    } catch {
      // файл мог исчезнуть между readdir и stat — это не повод валить экспорт
    }
  }

  return removed
}

/** Браузер: Web Share API с файлами, иначе обычное скачивание. */
async function shareInBrowser(files: ShareFile[]): Promise<ShareOutcome> {
  const names = files.map((file) => file.name)
  const blobs = files.map((file) => new File([file.content], file.name, { type: `${MARKDOWN_MIME};charset=utf-8` }))
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }

  if (typeof nav.share === 'function' && nav.canShare?.({ files: blobs })) {
    try {
      await nav.share({ files: blobs, title: files.length > 1 ? `${files.length} файла — SYNTH` : files[0].name })
      return {
        ok: true,
        method: 'share',
        message: files.length > 1 ? `Отправлено файлов: ${files.length}` : `Отправлен файл ${names[0]}`,
        files: names,
      }
    } catch (err) {
      if (isCancel(err)) return { ok: false, method: 'cancelled', message: 'Отправка отменена', files: names }
      // Web Share мог быть заявлен, но не сработать: не теряем данные, скачиваем
    }
  }

  for (const file of files) downloadText(file.name, file.content, MARKDOWN_MIME)
  return {
    ok: true,
    method: 'download',
    message: files.length > 1 ? `Скачано файлов: ${files.length}` : `Файл ${names[0]} скачан`,
    files: names,
  }
}

/** Android: пишем в кэш и открываем системный sheet «Поделиться». */
async function shareNative(files: ShareFile[]): Promise<ShareOutcome> {
  const names = files.map((file) => file.name)
  const uris: string[] = []

  try {
    for (const file of files) uris.push(await writeNativeFile(file))
  } catch (err) {
    return { ok: false, method: 'share', message: `Не удалось создать файл: ${errorMessage(err)}`, files: names }
  }

  try {
    await Share.share({
      title: files.length > 1 ? `${files.length} файла — SYNTH` : files[0].name,
      dialogTitle: files.length > 1 ? 'Куда отправить файлы?' : 'Куда отправить файл?',
      files: uris,
    })
    return {
      ok: true,
      method: 'share',
      message: files.length > 1 ? `Отправлено файлов: ${files.length}` : `Отправлен файл ${names[0]}`,
      files: names,
    }
  } catch (err) {
    if (isCancel(err)) return { ok: false, method: 'cancelled', message: 'Отправка отменена', files: names }
    return { ok: false, method: 'share', message: `Не удалось поделиться: ${errorMessage(err)}`, files: names }
  }
}

/**
 * Единственная точка входа: файлы → системный sheet «Поделиться».
 *
 * Имена санитизируются, пустые файлы не создаются, дубликаты имён получают
 * хвост `-2`. В APK файлы ложатся в Cache/exports/ и уходят через FileProvider,
 * в браузере — Web Share API или скачивание.
 */
export async function exportMarkdown(input: ShareFile[]): Promise<ShareOutcome> {
  const prepared = uniqueFileNames(
    input
      .map((file) => ({ name: sanitizeFileName(file.name), content: file.content.trim() }))
      .filter((file) => Boolean(file.name) && file.content.length > 0),
  )

  if (!prepared.length) {
    return { ok: false, method: 'share', message: 'Нечего отправлять: ни текста, ни блоков кода.', files: [] }
  }

  if (!nativeShareAvailable()) return shareInBrowser(prepared)

  if (!cleanupDone) {
    cleanupDone = true
    try {
      await cleanupOldExports()
    } catch {
      // папки exports/ ещё нет или кэш недоступен — удалять нечего
    }
  }

  return shareNative(prepared)
}

