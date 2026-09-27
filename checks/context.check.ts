/**
 * Проверка оценки контекста и обрезки истории по окну модели.
 * Запуск: npm run checks
 */
import {
  CONTEXT_PRESETS,
  budgetWithoutExtraSystem,
  contextPercent,
  estimateTokens,
  formatTokens,
  historyBudgetFor,
  inputBudget,
  messageTokens,
  trimHistory,
} from '@/lib/context'
import { measureContext, planContext } from '@/lib/contextPlan'
import {
  SUMMARY_MAX_CHARS,
  chunkMessages,
  dropCovered,
  parseSummary,
  prepareSummary,
  renderDialog,
  summaryBlockFor,
  summaryCovers,
} from '@/lib/contextSummary'
import {
  TOOL_HISTORY_ROUNDS,
  TRUNCATION_MARK,
  isToolRound,
  planToolRounds,
  resultTextOf,
  toolResultForContext,
  toolResultLink,
  toolResultOneLiner,
  toolRoundCost,
  truncateToolResult,
} from '@/lib/toolHistory'
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '@/lib/untrusted'
import { buildWireMessages, squeezeWire, wireTokens } from '@/lib/agent'
import { DEFAULT_SETTINGS, sanitizeContextWindow, type Settings } from '@/lib/settings'
import type { ChatMessage, ConversationSummary, ToolCallRecord } from '@/types'
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
/* ─────── 7. tool-раунды прошлых ходов в контексте (задача 04.1) ─────── */

/** Раунд: сообщение ассистента с вызовом инструмента и его результатом. */
function toolRound(
  index: number,
  result: string,
  name = 'web_search',
  args = '{"query":"цены iphone"}',
  text = '',
): ChatMessage {
  return {
    id: `round-${index}`,
    role: 'assistant',
    createdAt: index,
    content: text,
    status: 'complete',
    toolCalls: [
      {
        id: `call-${index}`,
        name,
        args,
        argsPretty: args,
        status: 'done',
        summary: 'Найдено источников: 3',
        resultText: result,
        startedAt: 1,
        finishedAt: 2,
      },
    ],
  }
}

const fiveRounds = [1, 2, 3, 4, 5].flatMap((i) => [msg('user', `вопрос ${i}`), toolRound(i, `результат ${i}`)])
const roundPlan = planToolRounds(fiveRounds)
check('разворачиваются только последние K tool-раундов', roundPlan.ids.size === TOOL_HISTORY_ROUNDS)
check('первый раунд в контекст не возвращается', !roundPlan.ids.has('round-1'))
check('последний раунд в контекст попадает', roundPlan.ids.has('round-5'))
check('K=0 — раунды не разворачиваются', planToolRounds(fiveRounds, 0).ids.size === 0)
check('пользовательские сообщения раундами не считаются', planToolRounds([msg('user', 'привет')]).ids.size === 0)
check('раундом считается только ответ с вызовами инструментов', isToolRound(toolRound(1, 'ок')) && !isToolRound(msg('assistant', 'просто текст')))
check(
  'стоимость раунда попадает в бюджет окна',
  toolRoundCost(planToolRounds(fiveRounds))(fiveRounds[9]) > 0,
)

const bigPage = `${UNTRUSTED_OPEN} · источник: read_url: example.com]\n${'стр'.repeat(4000)}\n${UNTRUSTED_CLOSE}\n\nКак отвечать: перескажи страницу.`
const cutPage = truncateToolResult(bigPage, 500)
check('длинный результат помечается как обрезанный', cutPage.includes(TRUNCATION_MARK))
check(
  'рамка внешних данных при усечении сохраняется целиком',
  cutPage.includes(UNTRUSTED_OPEN) && cutPage.includes(UNTRUSTED_CLOSE),
)
check('короткий результат остаётся как есть', truncateToolResult('цены: 79 990 ₽') === 'цены: 79 990 ₽')

const bigRecord: ToolCallRecord = {
  id: 'call-big',
  name: 'read_url',
  args: '{"url":"https://example.com/prices"}',
  argsPretty: '{\n  "url": "https://example.com/prices"\n}',
  status: 'done',
  summary: 'example.com — Прайс-лист (12 КБ текста)',
  resultText: `${'a'.repeat(20000)} 79 990 ₽`,
  startedAt: 1,
  finishedAt: 2,
}
const contextedPage = toolResultForContext(bigRecord, 1000)
check('крупный результат уходит в контекст выжимкой, а не целиком', contextedPage.length < 2000)
check('выжимка сохраняет сводку инструмента', contextedPage.includes('Прайс-лист'))
check('выжимка ссылается на источник', contextedPage.includes('https://example.com/prices'))
check('сокращённый результат помечен', contextedPage.includes(TRUNCATION_MARK))
check(
  'короткий результат уходит без изменений',
  toolResultForContext({ ...bigRecord, resultText: 'цены: 79 990 ₽' }, 1000) === 'цены: 79 990 ₽',
)
check(
  'ссылка берётся из источников, если её нет в аргументах',
  toolResultLink({
    ...bigRecord,
    args: '{}',
    sources: [{ title: 'x', url: 'https://a.b', snippet: '' }],
  }) === 'https://a.b',
)
check(
  'для поиска ссылкой считается запрос',
  toolResultLink({ ...bigRecord, args: '{"query":"цены iphone"}', sources: undefined }) ===
    'поиск: «цены iphone»',
)
check(
  'ошибка инструмента доходит до контекста текстом',
  resultTextOf({
    ...bigRecord,
    resultText: undefined,
    summary: undefined,
    status: 'error',
    error: 'нет сети',
  }).includes('нет сети'),
)

check('история инструментов в контексте включена по умолчанию', DEFAULT_SETTINGS.toolHistoryInContext === true)

/* ─── как эти раунды и сводка собираются в самом запросе (wire) ─── */

const chatSettings: Settings = { ...structuredClone(DEFAULT_SETTINGS), model: 'gpt-4o-mini' }
const priceHistory: ChatMessage[] = [
  msg('user', 'поищи цены на iphone'),
  toolRound(1, 'Найдено: iPhone 15 — 79 990 ₽, iPhone 16 — 99 990 ₽'),
  msg('assistant', 'iPhone 15 — 79 990 ₽, iPhone 16 — 99 990 ₽'),
  msg('user', 'покажи ещё раз те цены'),
]
const wire = await buildWireMessages(priceHistory, chatSettings)
const toolIndex = wire.findIndex((m) => m.role === 'tool')
const callIndex = wire.findIndex((m) => Boolean(m.tool_calls?.length))
check('tool-раунд прошлого хода разворачивается в контекст', toolIndex !== -1 && callIndex !== -1)
check('assistant с tool_calls идёт перед ответом инструмента', callIndex < toolIndex)
check('tool_call_id совпадает с id вызова', wire[toolIndex].tool_call_id === wire[callIndex].tool_calls?.[0].id)
check(
  '«покажи те цены ещё раз» получает уже найденные цены',
  wire.some((m) => String(m.content ?? '').includes('79 990 ₽')),
)
check('раунд без текста не теряется', wire[callIndex].content === null)

const wireOff = await buildWireMessages(priceHistory, chatSettings, { toolHistory: false })
check('выключенный флаг убирает tool-раунды из контекста', !wireOff.some((m) => m.role === 'tool'))
const wireOffSetting = await buildWireMessages(priceHistory, {
  ...chatSettings,
  toolHistoryInContext: false,
})
check('настройка «история инструментов» управляет разворачиванием', !wireOffSetting.some((m) => m.role === 'tool'))

const manyRounds = [1, 2, 3, 4, 5].flatMap((i) => [msg('user', `вопрос ${i}`), toolRound(i, `результат ${i}`)])
const wireMany = await buildWireMessages(manyRounds, chatSettings)
check(
  'в запрос уходят только K последних tool-раундов',
  wireMany.filter((m) => m.role === 'tool').length === TOOL_HISTORY_ROUNDS,
)
check(
  'стоимость tool-раундов входит в замер контекста',
  measureContext(chatSettings, manyRounds).used >
    measureContext(chatSettings, manyRounds, { toolHistory: false }).used,
)

const heavyHistory = [msg('user', 'вопрос'), toolRound(9, 'x'.repeat(8000)), msg('user', 'ещё вопрос')]
check(
  'полная страница в контекст не тянется — считается выжимка',
  toolRoundCost(planToolRounds(heavyHistory))(heavyHistory[1]) < estimateTokens('x'.repeat(8000)),
)
check(
  'доплата за tool-раунды не «возвращает» в окно больше сообщений',
  trimHistory(heavyHistory, 300, toolRoundCost(planToolRounds(heavyHistory))).droppedMessages >=
    trimHistory(heavyHistory, 300).droppedMessages,
)
const nearLimit = [
  msg('user', 'вопрос '.repeat(50)),
  toolRound(11, 'x'.repeat(3000)),
  msg('user', 'коротко'),
]
const plainKept = trimHistory(nearLimit, 700).history.length
const extraKept = trimHistory(nearLimit, 700, toolRoundCost(planToolRounds(nearLimit))).history.length
check('доплата за tool-результат вытесняет лишнее из окна', extraKept < plainKept)

/* ─── рост запроса внутри хода: сворачивание старых результатов (этап B) ─── */

/** Результат инструмента в рамке внешних данных — как настоящая длинная страница. */
const veryLongPage = `${UNTRUSTED_OPEN} · источник: read_url: example.com]\n${'стр'.repeat(4000)}\n${UNTRUSTED_CLOSE}\n\nКак отвечать: перескажи страницу.`
const heavyRounds = [1, 2, 3].flatMap((i) => [
  msg('user', `вопрос ${i}`),
  toolRound(30 + i, `${veryLongPage} ${i}`),
])
const heavyWire = await buildWireMessages(heavyRounds, chatSettings)
const heavyRecords = new Map<string, ToolCallRecord>()
for (const m of heavyRounds) {
  for (const call of m.toolCalls ?? []) heavyRecords.set(call.id, call)
}
const toolAt = heavyWire.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
const calledIdsBefore = (at: number) =>
  heavyWire.slice(0, at).flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))

const tokensBefore = wireTokens(heavyWire)
const squeezed = squeezeWire(heavyWire, tokensBefore - 500, heavyRecords)
// Свёрнутый результат — короткая выжимка; полный — сотни строк страницы.
const folded = toolAt.filter((i) => String(heavyWire[i].content).length < 1000)

check('ни один результат инструмента не потерялся', toolAt.length === heavyRounds.filter(isToolRound).length)
check(
  'каждый результат по-прежнему следует за своим вызовом',
  toolAt.every((i) => calledIdsBefore(i).includes(String(heavyWire[i].tool_call_id))),
)
check(
  'запрос сверх бюджета сворачивает старые результаты (свежий — нет)',
  squeezed > 0 && folded.length >= 1 && folded.length < toolAt.length,
)

// Жёсткий бюджет: сворачивается всё, что уже не свежее, но не последний раунд
const tightWire = await buildWireMessages(heavyRounds, chatSettings)
const tightSqueezed = squeezeWire(tightWire, 1, heavyRecords)
const tightFull = tightWire
  .map((m, i) => (m.role === 'tool' && String(m.content).length > 1000 ? i : -1))
  .filter((i) => i >= 0)
check(
  'при жёстком бюджете сворачиваются все старые результаты, а свежий остаётся',
  tightSqueezed === toolAt.length - 1 && tightFull.length === 1,
)
check('сжатый запрос заметно легче исходного', wireTokens(tightWire) < tokensBefore / 2)
check('свёрнутый результат стал заметно короче', folded.every((i) => String(heavyWire[i].content).length < 1000))
check('запрос вернулся в бюджет', wireTokens(heavyWire) <= tokensBefore - 500 + 400)
check(
  'рамка внешних данных в свёрнутом результате сохранена',
  folded.every(
    (i) =>
      String(heavyWire[i].content).includes(UNTRUSTED_OPEN) &&
      String(heavyWire[i].content).includes(UNTRUSTED_CLOSE),
  ),
)
check(
  'свежий раунд не трогаем: последний результат остался полным',
  String(heavyWire[toolAt[toolAt.length - 1]]?.content ?? '').length > 1000,
)

const roomyWire = await buildWireMessages(heavyRounds, chatSettings)
check(
  'в пределах бюджета запрос не переписывается',
  squeezeWire(roomyWire, wireTokens(roomyWire) + 500, heavyRecords) === 0,
)
check('без ограничения окна (бюджет 0) сжатия нет', squeezeWire(roomyWire, 0, heavyRecords) === 0)

const shortRecord: ToolCallRecord = { ...bigRecord, resultText: 'цены: 79 990 ₽' }
check(
  'однострочная выжимка ссылается на инструмент и его итог',
  toolResultOneLiner(shortRecord).startsWith('read_url(') &&
    toolResultOneLiner(shortRecord).includes('79 990 ₽'),
)
check(
  'однострочная выжимка короткая и без переводов строк',
  toolResultOneLiner(bigRecord).length < 400 && !toolResultOneLiner(bigRecord).includes('\n'),
)

/* ─────── 8. сводка выпавшей части диалога (задача 04.2) ─────── */

check(
  'ответ с обёрткой и префиксом превращается в текст сводки',
  parseSummary('```\nСводка: пользователь просил цены на iPhone\n```') ===
    'пользователь просил цены на iPhone',
)
check('пустой ответ даёт пустую сводку', parseSummary('   ') === '')
check('длинная сводка урезается', parseSummary('я'.repeat(5000)).length <= SUMMARY_MAX_CHARS + 1)

const rendered = renderDialog([msg('user', 'привет'), toolRound(1, 'цены: 79 990 ₽')])
check('пересказ диалога включает вопрос пользователя', rendered.text.includes('Пользователь: привет'))
check(
  'пересказ диалога включает вызов инструмента и его результат',
  rendered.text.includes('web_search') && rendered.text.includes('79 990 ₽'),
)
check(
  'при нехватке лимита ранние сообщения помечаются пропущенными',
  renderDialog([msg('user', 'a'.repeat(300)), msg('user', 'b'.repeat(300))], 200).skipped > 0,
)

check(
  'нарезка на запросы суммаризации режет по лимиту',
  chunkMessages([msg('user', 'a'.repeat(100)), msg('user', 'b'.repeat(100))], 150).length === 2,
)
check(
  'большое сообщение в чанк попадает целиком',
  chunkMessages([msg('user', 'a'.repeat(500))], 100).length === 1,
)

const droppedPart = [msg('user', 'старый вопрос'), msg('assistant', 'старый ответ')]
const partSummary = {
  text: 'раньше говорили о ценах',
  upToMessageId: droppedPart[0].id,
  covered: 1,
  updatedAt: 1,
}
check('уже сжатые сообщения повторно не сжимаются', dropCovered(droppedPart, partSummary).length === 1)
check(
  'незнакомая сводка приводит к пересжатию',
  dropCovered(droppedPart, { ...partSummary, upToMessageId: 'нет-такого' }).length === 2,
)
check('без сводки системный блок не добавляется', summaryBlockFor(undefined, droppedPart) === '')
const fullSummary = { ...partSummary, upToMessageId: droppedPart[1].id, covered: 2 }
check(
  'пока сжатые сообщения ещё в окне, сводка не отправляется',
  summaryBlockFor(fullSummary, droppedPart) === '',
)
const newer = [msg('user', 'новый вопрос')]
check(
  'выпавшая сводка уходит отдельным системным блоком',
  summaryBlockFor(fullSummary, newer).includes(fullSummary.text) &&
    summaryBlockFor(fullSummary, newer).includes('Сводка прежнего разговора'),
)
check(
  'summaryCovers совпадает с решением о блоке',
  summaryCovers(fullSummary, newer) === true && summaryCovers(fullSummary, droppedPart) === false,
)

/* ─── подготовка сводки перед ходом (без реальной сети) ─── */

const tiny: Settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  contextWindow: 512,
  network: { ...DEFAULT_SETTINGS.network, maxAttempts: 1 },
}
const longChat: ChatMessage[] = []
for (let i = 0; i < 6; i += 1) {
  longChat.push(msg('user', `вопрос ${i} `.repeat(20)), msg('assistant', `ответ ${i} `.repeat(20)))
}
longChat.push(msg('user', 'и последний вопрос'))

const tinyPlan = planContext(tiny, longChat)
check('узкое окно действительно выбрасывает старые сообщения', tinyPlan.dropped.length > 0)
check('выпавшие сообщения отдаются для сводки', tinyPlan.dropped[0].id === longChat[0].id)
check('гораздо больше одного сообщения доходит до сводки', tinyPlan.dropped.length > 3)

const upToDate = await prepareSummary({
  settings: tiny,
  summary: {
    text: 'сжато',
    upToMessageId: tinyPlan.dropped[tinyPlan.dropped.length - 1].id,
    covered: tinyPlan.dropped.length,
    updatedAt: 1,
  },
  plan: tinyPlan,
})
check('актуальная сводка зря не пересчитывается', upToDate.created === undefined)
check('при актуальной сводке она уходит в контекст как есть', upToDate.summary?.text === 'сжато')

const oneMessage = [msg('user', 'привет')]
const noDrop = await prepareSummary({ settings: tiny, plan: planContext(tiny, oneMessage) })
check('без выпавших сообщений сводка не создаётся', noDrop.created === undefined && noDrop.dropped.length === 0)

/* ─── один план на сводку и на запрос (этап A «Деградация агента») ─── */

const longSummary: ConversationSummary = {
  text: 'ранее обсуждали цены и сроки '.repeat(20),
  upToMessageId: 'msg-old',
  covered: 4,
  updatedAt: 1,
}
const planPlain = planContext(tiny, longChat)
const planWithSummary = planContext(tiny, longChat, { summary: longSummary })

check('блок сводки сужает место под историю', planWithSummary.budget < planPlain.budget)
check('сводка вытесняет из окна ещё сообщения', planWithSummary.dropped.length > planPlain.dropped.length)

const plannedWire = await buildWireMessages(longChat, tiny, { summary: longSummary, plan: planWithSummary })
const plannedText = plannedWire.map((m) => String(m.content ?? '')).join('\n')
check(
  'выпавшие по плану сообщения в запрос не уходят',
  planWithSummary.dropped.every((m) => !plannedText.includes(m.content)),
)
check('оставшееся по плану уходит в модель', planWithSummary.kept.every((m) => plannedText.includes(m.content)))
check(
  'в запрос уходит ровно тот блок сводки, по которому считали план',
  plannedWire.some((m) => m.role === 'system' && m.content === planWithSummary.summaryBlock),
)
check(
  'метр контекста считает выпавшее так же, как план запроса',
  measureContext(tiny, longChat, { summary: longSummary }).droppedMessages === planWithSummary.dropped.length,
)
check('без дополнительного системного блока бюджет не меняется', budgetWithoutExtraSystem(1000) === 1000)
check('дополнительный системный блок уменьшает бюджет', budgetWithoutExtraSystem(1000, longSummary.text) < 1000)

// Модель недоступна (запрос обрывается сразу) — чат обязан продолжить работу
const aborted = new AbortController()
aborted.abort()
const failSettings: Settings = { ...tiny, baseUrl: 'http://127.0.0.1:9/v1' }
const failed = await prepareSummary({
  settings: failSettings,
  signal: aborted.signal,
  plan: planContext(failSettings, longChat),
})
check('ошибка суммаризации не бросается наружу', failed.error !== undefined && failed.created === undefined)
check('при ошибке история просто обрезается', failed.dropped.length > 0 && failed.summary === undefined)

const summaryWire = await buildWireMessages([msg('user', 'новый вопрос')], chatSettings, {
  summary: { text: 'Ранее обсуждали цены на iPhone', upToMessageId: 'msg-old', covered: 4, updatedAt: 1 },
})
const summaryAt = summaryWire.findIndex((m) =>
  String(m.content ?? '').includes('Ранее обсуждали цены на iPhone'),
)
const firstUserAt = summaryWire.findIndex((m) => m.role === 'user')
check('сводка идёт системным блоком в начале контекста', summaryAt !== -1 && summaryAt < firstUserAt)
check(
  'сводка уходит как системное сообщение, а не как реплика пользователя',
  summaryWire[summaryAt].role === 'system',
)

const keptWire = await buildWireMessages([{ ...msg('user', 'привет'), id: 'last-user' }], chatSettings, {
  summary: { text: 'лишняя сводка', upToMessageId: 'last-user', covered: 1, updatedAt: 1 },
})
check(
  'сводка не дублирует сообщения, которые ещё в окне',
  !keptWire.some((m) => String(m.content ?? '').includes('лишняя сводка')),
)

finish()
