/**
 * Проверка оценки контекста и обрезки истории по окну модели.
 * Запуск: npm run checks
 */
import {
  CONTEXT_PRESETS,
  contextPercent,
  estimateTokens,
  formatTokens,
  historyBudgetFor,
  inputBudget,
  measureContext,
  messageTokens,
  trimHistory,
} from '@/lib/context'
import { DEFAULT_SETTINGS, sanitizeContextWindow, type Settings } from '@/lib/settings'
import type { ChatMessage } from '@/types'
import { check, finish } from './harness'

/** Собирает сообщение без обязательных полей, чтобы не загромождать тесты. */
function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return {
    id: `${role}-${content.length}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    createdAt: Date.now(),
    status: 'complete',
  }
}

const settings: Settings = structuredClone(DEFAULT_SETTINGS)

// 1. оценка токенов
check('пустая строка — ноль токенов', estimateTokens('') === 0)
check('латиница: 4 символа ≈ 1 токен', estimateTokens('abcd') === 1)
check('кириллица дороже латиницы', estimateTokens('привет') > estimateTokens('123456'))
check('токенов не меньше, чем четверть символов', estimateTokens('hello world') >= 2)
check('сообщение считает накладные расходы', messageTokens(msg('user', 'привет')) > estimateTokens('привет'))

// 2. подписи размеров
check('тысячи подписываются как k', formatTokens(1024) === '1k')
check('32k округляется без хвоста', formatTokens(32768) === '32k')
check('полтора килобайта токенов с десятой', formatTokens(1536) === '1.5k')
check('мелкие числа без приставки', formatTokens(900) === '900')
check('ноль остаётся нулём', formatTokens(0) === '0')

// 3. бюджет входа
check('без max_tokens резерв не вычитается', inputBudget(8192, null) === 8192)
check('max_tokens резервирует место под ответ', inputBudget(8192, 2048) === 6144)
check('резерв не больше половины окна', inputBudget(4096, 100000) === 2048)
check('окно 0 — бюджет не считается', inputBudget(0, null) === 0)
check(
  'системный промпт уменьшает бюджет истории',
  historyBudgetFor({ ...settings, contextWindow: 8192 }, 'x'.repeat(4000)) <
    inputBudget(8192, null),
)

// 4. обрезка истории
const long = [
  msg('user', 'a'.repeat(4000)),
  msg('assistant', 'b'.repeat(4000)),
  msg('user', 'короткий вопрос'),
  msg('assistant', 'короткий ответ'),
]
const trimmed = trimHistory(long, 200)
check('обрезается только хвост истории', trimmed.history.length < long.length)
check('последнее сообщение всегда остаётся', trimmed.history.at(-1)?.content === 'короткий ответ')
check('история не начинается с ответа ассистента', trimmed.history[0].role === 'user')
check('отброшенные сообщения посчитаны', trimmed.droppedMessages > 0 && trimmed.droppedTokens > 0)
check('влезающая история не меняется', trimHistory(long, 100000).history.length === long.length)
check(
  'единственное длинное сообщение сохраняется даже при малом бюджете',
  trimHistory([msg('user', 'z'.repeat(9000))], 10).history.length === 1,
)

// 5. замер для интерфейса
const noLimit: Settings = structuredClone(settings)
noLimit.contextWindow = 0
const unlimited = measureContext(noLimit, long)
check('окно 0 — обрезки нет', unlimited.droppedMessages === 0 && unlimited.limit === 0)
check('окно 0 — процент заполнения нулевой', contextPercent(unlimited.used, unlimited.limit) === 0)

const narrow: Settings = structuredClone(settings)
narrow.contextWindow = 1024
const measured = measureContext(narrow, long)
check('с окном история режется', measured.droppedMessages > 0)
check('замер меньше полного диалога', measured.used < measured.full)
check('замер не превышает окно с запасом', measured.used <= narrow.contextWindow + 256)
check('проценты не выходят за 100', contextPercent(measured.limit * 3, measured.limit) === 100)

const exact: ChatMessage[] = [msg('assistant', 'ok')]
exact[0].usage = { promptTokens: 1234 }
check('точный usage провайдера попадает в замер', measureContext(narrow, exact).exact === 1234)

// 6. настройки: размер окна
check('пресеты окон заданы по возрастанию', CONTEXT_PRESETS.every((v, i) => i === 0 || v > CONTEXT_PRESETS[i - 1]))
check('пустое значение — окно по умолчанию', sanitizeContextWindow(undefined) === DEFAULT_SETTINGS.contextWindow)
check('строка с числом принимается', sanitizeContextWindow('128000') === 128000)
check('ноль — без ограничения', sanitizeContextWindow(0) === 0)
check('отрицательное значение — без ограничения', sanitizeContextWindow(-5) === 0)
check('мусор даёт значение по умолчанию', sanitizeContextWindow('много') === DEFAULT_SETTINGS.contextWindow)

finish()
