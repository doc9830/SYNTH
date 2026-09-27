import type { WireChatRequest } from './types'

/**
 * Совместимость тела запроса с разными OpenAI-совместимыми серверами.
 *
 * «OpenAI-совместимый» — это не стандарт, а договорённость: локальные серверы
 * (llama.cpp, Ollama, LM Studio, vLLM), шлюзы и новые модели OpenAI понимают
 * разные наборы полей. Отсюда типовые 400:
 *   - llama.cpp: `Unrecognized request argument supplied: stream_options`
 *   - новые модели OpenAI: `Unsupported parameter: 'max_tokens' … use
 *     'max_completion_tokens' instead`, `'temperature' does not support 0.3`
 *
 * Лечим это так же, как это делает человек: убираем или переименовываем поле,
 * повторяем запрос и запоминаем решение для этого подключения (baseUrl+model) —
 * со следующего раза запрос уходит сразу в понятном серверу виде.
 * Таблица правил живёт здесь, в одном месте, а не в разбросанных if-ах.
 */

/** Поля, которые провайдеры умеют не принимать. */
export type BodyFieldName = 'stream_options' | 'max_tokens' | 'temperature' | 'tool_choice'

/** Что сделать с полем. */
export type BodyFixAction =
  | { kind: 'drop' }
  | { kind: 'rename'; to: string }
  | { kind: 'set'; value: unknown }

export interface BodyFieldStrategy {
  /** Как узнать это поле в тексте ошибки провайдера */
  detect: RegExp
  /** Что пробовать по порядку: первый вариант подходит чаще всего */
  actions: BodyFixAction[]
  /** Что записать в журнал и отчёт */
  note: string
}

export const BODY_FIELD_STRATEGIES: Record<BodyFieldName, BodyFieldStrategy> = {
  stream_options: {
    detect: /stream_options|include_usage/i,
    actions: [{ kind: 'drop' }],
    note: 'убрать stream_options — llama.cpp и часть шлюзов не знают этого поля',
  },
  max_tokens: {
    detect: /max_tokens/i,
    actions: [{ kind: 'rename', to: 'max_completion_tokens' }],
    note: 'переименовать max_tokens → max_completion_tokens — так требуют новые модели OpenAI',
  },
  temperature: {
    detect: /temperature/i,
    actions: [
      { kind: 'set', value: 1 },
      { kind: 'drop' },
    ],
    note: 'отправить temperature = 1 (значение по умолчанию) вместо пользовательского',
  },
  tool_choice: {
    detect: /tool_choice/i,
    actions: [{ kind: 'drop' }],
    note: 'убрать tool_choice — сервер сам решит, вызывать ли инструменты',
  },
}

/** Порядок разбора: так ошибка с несколькими полями лечится предсказуемо. */
export const BODY_FIELD_ORDER: BodyFieldName[] = [
  'stream_options',
  'max_tokens',
  'temperature',
  'tool_choice',
]

/** Сколько раз за один ход разрешено «докрутить» тело запроса. */
export const MAX_BODY_FIX_ATTEMPTS = 3

/** Строковый идентификатор правки — так он и хранится в настройках. */
export type BodyFix = string

/** `drop:temperature`, `rename:max_tokens:max_completion_tokens`, `set:temperature:1`. */
export function fixId(field: BodyFieldName, action: BodyFixAction): BodyFix {
  if (action.kind === 'drop') return `drop:${field}`
  if (action.kind === 'rename') return `rename:${field}:${action.to}`
  return `set:${field}:${JSON.stringify(action.value)}`
}

/** Разбор сохранённой правки; незнакомая строка → undefined (старые сохранения). */
export function parseFixId(fix: BodyFix): { field: BodyFieldName; action: BodyFixAction } | undefined {
  const [kind, field, rest] = String(fix).split(':')
  if (!BODY_FIELD_ORDER.includes(field as BodyFieldName)) return undefined
  const name = field as BodyFieldName
  if (kind === 'drop') return { field: name, action: { kind: 'drop' } }
  if (kind === 'rename' && rest) return { field: name, action: { kind: 'rename', to: rest } }
  if (kind === 'set' && rest !== undefined) {
    try {
      return { field: name, action: { kind: 'set', value: JSON.parse(rest) } }
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Какие поля провайдер отклонил (по тексту ошибки). Порядок — табличный. */
export function parseBodyFieldRejections(text: string | null | undefined): BodyFieldName[] {
  const source = String(text ?? '')
  if (!source.trim()) return []
  return BODY_FIELD_ORDER.filter((field) => BODY_FIELD_STRATEGIES[field].detect.test(source))
}

/**
 * Поля из ошибки запроса: 400/422 и текст ответа. Прочие статусы (401, 404, 429)
 * к совместимости тела отношения не имеют — там ответ не изменится.
 */
export function rejectedFieldsFromError(input: {
  status?: number
  message?: string
  details?: string
}): BodyFieldName[] {
  if (input.status !== 400 && input.status !== 422) return []
  return parseBodyFieldRejections(`${input.message ?? ''}\n${input.details ?? ''}`)
}

/**
 * Применяет правки к телу запроса. Возвращает новый объект: исходное тело
 * дальше используется как есть (в журнале отладки видно, что ушло).
 */
export function applyBodyFixes(
  body: WireChatRequest,
  fixes: readonly BodyFix[],
): WireChatRequest {
  if (!fixes.length) return body
  const next: Record<string, unknown> = { ...body }
  for (const fix of fixes) {
    const parsed = parseFixId(fix)
    if (!parsed) continue
    const { field, action } = parsed
    if (action.kind === 'set') {
      next[field] = action.value
      continue
    }
    if (!(field in next)) continue
    if (action.kind === 'drop') {
      delete next[field]
      continue
    }
    next[action.to] = next[field]
    delete next[field]
  }
  return next as unknown as WireChatRequest
}

/**
 * Следующая правка для отклонённых полей: первое поле из таблицы, для которого
 * ещё есть неиспробованное действие. undefined → лечить нечем, показываем
 * пользователю реальный текст ответа провайдера.
 */
export function nextBodyFix(
  rejected: readonly BodyFieldName[],
  applied: readonly BodyFix[],
): BodyFix | undefined {
  for (const field of BODY_FIELD_ORDER) {
    if (!rejected.includes(field)) continue
    for (const action of BODY_FIELD_STRATEGIES[field].actions) {
      const fix = fixId(field, action)
      if (!applied.includes(fix)) return fix
    }
  }
  return undefined
}

/** Человекочитаемое описание правки — в журнал отладки и в отчёт. */
export function describeBodyFix(fix: BodyFix): string {
  const parsed = parseFixId(fix)
  if (!parsed) return `неизвестная правка: ${fix}`
  const note = BODY_FIELD_STRATEGIES[parsed.field].note
  return `поле ${parsed.field}: ${note}`
}

/**
 * Ключ «профиля подключения» для выученных правок: провайдер + адрес + модель.
 * Ключ нужен потому, что разные модели одного шлюза понимают разный набор
 * полей, и запоминать «убрать stream_options» на всё приложение нельзя.
 */
export function bodyProfileKey(input: {
  providerId: string
  baseUrl: string
  model: string
}): string {
  const base = input.baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  const provider = input.providerId.trim() || 'custom'
  return `${provider}|${base}|${input.model.trim()}`
}

