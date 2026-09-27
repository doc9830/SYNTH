/**
 * Вырезание секретов из всего, что покидает устройство или попадает в лог:
 * экспорт чата и памяти, Debug Console, тексты ошибок в чате.
 *
 * Правило простое: лучше перестраховаться и затереть лишнее, чем показать ключ
 * в скриншоте, отправленном в чат поддержки. Функции чистые — их проверяют
 * `checks/share.check.ts` и `checks/secrets.check.ts`.
 */

/** Заметка, что значение вырезано. */
export const REDACTED = '***'

/**
 * Типовые формы ключей у известных провайдеров. Ограничение по длине важно:
 * фраза «ключ от квартиры, где деньги лежат» не должна превращаться в «***».
 */
const KEY_SHAPE_SOURCE = [
  '\\bsk-ant-[A-Za-z0-9_*.\\-]{8,}',
  '\\bsk-[A-Za-z0-9_*.\\-]{8,}',
  '\\b(?:AIza|ya29\\.|ghp_|gho_|ghs_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9._\\-]{10,}',
  '\\bBearer\\s+[A-Za-z0-9._\\-]{8,}',
].join('|')

/**
 * Для вырезания — с флагом «g»: без него `replace` затирает только первое
 * вхождение, а в сообщении или теле ответа ключей может быть несколько.
 */
const KEY_SHAPE_RE = new RegExp(KEY_SHAPE_SOURCE, 'gi')

/** Для проверок — без «g»: глобальный regexp в `test()` помнит `lastIndex`. */
const KEY_SHAPE_TEST_RE = new RegExp(KEY_SHAPE_SOURCE, 'i')

/**
 * Пары «имя=значение» с секретным именем: JSON, YAML, заголовки, query.
 * `\b` тут не используем: в JS граница слова считается по латинице, поэтому
 * после кириллического «пароль» её нет. Разделитель `[:=]` сразу после имени
 * защищает от ложных срабатываний («tokenizer:» не трогаем).
 */
const KEY_VALUE_RE =
  /((?:["']?(?:api[-_]?key|apikey|api[-_]?token|authorization|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|token|client[-_]?secret|private[-_]?key|password|passwd|pwd|secret|пароль)["']?)\s*[:=]\s*"?)([^"'\s,;&}]{4,})/gi

/** Токен в query-строке URL: `?key=…`, `&api_key=…`, `&signature=…`. */
const URL_TOKEN_RE = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|signature|sig)=)([^&\s"']{3,})/gi

/** Строка выглядит как ключ/токен, а не как обычный текст. */
export function looksLikeKey(text: string): boolean {
  return KEY_SHAPE_TEST_RE.test(text)
}

/** Маскирование ключа для логов: «sk-…abcd» — видно префикс и хвост, не сам ключ. */
export function maskKeyShort(key: string): string {
  const trimmed = (key ?? '').trim()
  if (!trimmed) return ''
  // Короткое значение нельзя угадать даже частично: оставляем только префикс.
  if (trimmed.length <= 8) return `${trimmed.slice(0, 1)}…`
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`
}

/** Убирает из текста ключи, токены и заголовки авторизации. */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(KEY_SHAPE_RE, (match) => {
      if (/^bearer\s/i.test(match)) return `Bearer ${REDACTED}`
      const prefix = /^(sk-ant-|sk-)/i.exec(match)?.[1]
      return prefix ? `${prefix}${REDACTED}` : REDACTED
    })
    .replace(URL_TOKEN_RE, `$1${REDACTED}`)
    .replace(KEY_VALUE_RE, `$1${REDACTED}`)
}

/** Рекурсивная очистка структур (payload запроса, ответ провайдера, дамп). */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /(api[-_]?key|authorization|x-api-key|token|secret|password|passwd|key)$/i.test(k)
        ? maskKeyShort(String(v ?? ''))
        : redactDeep(v)
    }
    return out
  }
  return value
}

