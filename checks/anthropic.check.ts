/**
 * Проверка типа подключения «Anthropic (Claude)»: заголовки, перевод
 * внутреннего wire-формата в Messages API и обратно, разбор SSE-потока
 * и сборка транспорта (+ что OpenAI-путь не изменился).
 * Запуск: npm run checks
 */
import { resolveTransport, toAnthropicTransport, toOpenAiTransport } from '@/api/transport'
import { looksLikeAnthropic, presetById, presetProtocol } from '@/lib/providerPresets'
import { DEFAULT_SETTINGS, type Settings } from '@/lib/settings'
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_VERSION,
  anthropicHeaders,
} from '@/providers/anthropic/headers'
import { consumeAnthropicStream } from '@/providers/anthropic/stream'
import {
  fromAnthropicResponse,
  mapStopReason,
  parseToolArguments,
  toAnthropicMessages,
  toAnthropicRequest,
  toAssistantTurn,
  toImageBlock,
  toWireUsage,
} from '@/providers/anthropic/translate'
import type { WireMessage } from '@/providers/openai/types'
import { check, finish } from './harness'

const base: Settings = structuredClone(DEFAULT_SETTINGS)

/** true, если вызов упал — так проверяем понятные ошибки вместо «тихого» отказа. */
function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** Поток из строки — изображает ответ fetch-а на POST /v1/messages. */
function sseStream(payload: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

// ---------------------------------------------------------------- заголовки
const headers = anthropicHeaders('  sk-ant-test  ')
check('ключ Claude уходит в x-api-key', headers['x-api-key'] === 'sk-ant-test')
check('версия API проставлена', headers['anthropic-version'] === ANTHROPIC_VERSION)
check('разрешён браузерный доступ (CORS)', headers['anthropic-dangerous-direct-browser-access'] === 'true')
check('Bearer не используется', !('Authorization' in headers))

// ---------------------------------------------------- перевод запроса
const history: WireMessage[] = [
  { role: 'system', content: 'Ты ассистент.' },
  { role: 'assistant', content: 'привет' },
  { role: 'user', content: 'Сколько будет 2+2?' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'calculator', arguments: '{"expression":"2+2"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '4' },
  { role: 'tool', tool_call_id: 'call_2', content: '5' },
]

const translated = toAnthropicMessages(history)
const messagesJson = JSON.stringify(translated.messages)
check('system вынесен в отдельное поле', translated.system === 'Ты ассистент.')
check('история не начинается с ответа модели', translated.messages[0].role !== 'assistant')
check('история начинается с вопроса пользователя', messagesJson.includes('Сколько будет 2+2'))
check('tool_calls стали блоками tool_use', messagesJson.includes('tool_use'))
check('аргументы инструмента переданы объектом', messagesJson.includes('"expression":"2+2"'))
check('история перестроена в три хода', translated.messages.length === 3)

const lastTurn = translated.messages[translated.messages.length - 1]
const lastBlocks = Array.isArray(lastTurn.content) ? lastTurn.content : []
check('соседние tool_result склеены в один ход', lastBlocks.length === 2)
check('tool_result идёт первым блоком', lastBlocks[0]?.type === 'tool_result')
check('идентификаторы tool_use_id сохранены', messagesJson.includes('call_1') && messagesJson.includes('call_2'))

const request = toAnthropicRequest({
  model: 'claude-sonnet-4-5',
  messages: history,
  stream: true,
  temperature: 3,
  tools: [
    {
      type: 'function',
      function: {
        name: 'calculator',
        description: 'Считает',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
  tool_choice: 'auto',
})
check('модель перенесена в тело запроса', request.model === 'claude-sonnet-4-5')
check('max_tokens подставлен по умолчанию', request.max_tokens === ANTHROPIC_DEFAULT_MAX_TOKENS)
check('температура приведена к диапазону Claude', request.temperature === 1)
check('инструменты описаны через input_schema', request.tools?.[0]?.input_schema?.type === 'object')
check('tool_choice переведён в auto', request.tool_choice?.type === 'auto')
check('без stream=false запрос стриминговый', request.stream === true)

const noTools = toAnthropicRequest({ model: 'claude-sonnet-4-5', messages: [], tools: [] })
check('без инструментов поле tools отсутствует', noTools.tools === undefined)
check('max_tokens всегда задан', noTools.max_tokens === ANTHROPIC_DEFAULT_MAX_TOKENS)

// ---------------------------------------------------- перевод ответа
const turn = fromAnthropicResponse({
  content: [
    { type: 'text', text: 'Ответ' },
    { type: 'tool_use', id: 'toolu_1', name: 'calculator', input: { expression: '2+2' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5 },
  model: 'claude-sonnet-4-5',
})
check('текст ответа прочитан', turn.content === 'Ответ')
check('tool_use стал tool_calls', turn.toolCalls[0]?.function.name === 'calculator')
check('аргументы снова JSON-строкой', turn.toolCalls[0]?.function.arguments === '{"expression":"2+2"}')
check('finish_reason переведён', turn.finishReason === 'tool_calls')
check('токены кэша попали в prompt_tokens', turn.usage?.prompt_tokens === 15)
check(
  'токены ответа посчитаны',
  turn.usage?.completion_tokens === 4 && turn.usage?.total_tokens === 19,
)
check('модель из ответа сохранена', turn.model === 'claude-sonnet-4-5')

const thinking = toAssistantTurn({
  blocks: [{ type: 'thinking', thinking: 'размышляю' }],
  stopReason: 'end_turn',
})
check('блок thinking стал reasoning', thinking.reasoning === 'размышляю')
check('end_turn → stop', thinking.finishReason === 'stop')
check('max_tokens → length', mapStopReason('max_tokens') === 'length')
check('неизвестная причина сохраняется', mapStopReason('some_new_reason') === 'some_new_reason')
check('нет usage — нет счётчиков', toWireUsage(undefined) === undefined)

let errorText = ''
try {
  fromAnthropicResponse({ error: { type: 'invalid_request_error', message: 'Плохой запрос' } })
} catch (err) {
  errorText = err instanceof Error ? err.message : String(err)
}
check('ошибка API превращается в исключение', errorText === 'Плохой запрос')

// ---------------------------------------------------- блоки вложений
const dataImage = toImageBlock('data:image/png;base64,AAAA')
check('data URL стал base64-блоком', dataImage?.source.type === 'base64')
check(
  'media_type сохранён',
  dataImage?.source.type === 'base64' && dataImage.source.media_type === 'image/png',
)
check('ссылка стала url-блоком', toImageBlock('https://example.com/a.png')?.source.type === 'url')
check('непонятный источник отброшен', toImageBlock('ftp://example.com/a.png') === null)
check('пустой аргумент → {}', JSON.stringify(parseToolArguments('')) === '{}')
check('сломанный JSON → {}', JSON.stringify(parseToolArguments('{oops')) === '{}')
check('валидный JSON разобран', parseToolArguments('{"a":1}').a === 1)

// ---------------------------------------------------- разбор потока
const streamPayload = [
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"При"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"вет"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"думаю"}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_9","name":"calculator"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"expression\\""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":":\\"2+2\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  'data: [DONE]\n\n',
].join('')

const deltas: string[] = []
const reasonings: string[] = []
let usageCalls = 0
const streamed = await consumeAnthropicStream(sseStream(streamPayload), {
  onDelta: (t) => deltas.push(t),
  onReasoning: (t) => reasonings.push(t),
  onUsage: () => {
    usageCalls += 1
  },
})

check('текст собран из дельт', streamed.content === 'Привет')
check('дельты отданы в UI по частям', deltas.join('') === 'Привет' && deltas.length === 2)
check('мысли отделены от ответа', streamed.reasoning === 'думаю' && reasonings.join('') === 'думаю')
check(
  'аргументы инструмента собраны из input_json_delta',
  streamed.toolCalls[0]?.function.arguments === '{"expression":"2+2"}',
)
check('id инструмента сохранён', streamed.toolCalls[0]?.id === 'toolu_9')
check('finish_reason потока переведён', streamed.finishReason === 'tool_calls')
check('input_tokens + output_tokens сошлись', streamed.usage?.total_tokens === 19)
check('счётчики отданы в UI дважды (старт и финиш)', usageCalls === 2)
check('модель из message_start сохранена', streamed.model === 'claude-sonnet-4-5')

const errorPayload =
  'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Перегружено"}}\n\n'
let streamError = ''
try {
  await consumeAnthropicStream(sseStream(errorPayload))
} catch (err) {
  streamError = err instanceof Error ? err.message : String(err)
}
check('ошибка внутри потока выбрасывается', streamError === 'Перегружено')

// ---------------------------------------------------- транспорт
const anthropicSettings: Settings = {
  ...base,
  protocol: 'anthropic',
  providerId: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-key',
  model: 'claude-sonnet-4-5',
}
const resolved = resolveTransport(anthropicSettings)
check('чат уходит на /messages', resolved.chatUrl === 'https://api.anthropic.com/v1/messages')
check(
  'модели берутся из /models с лимитом',
  resolved.modelsUrl === 'https://api.anthropic.com/v1/models?limit=100',
)
check('заголовки Claude в транспорте', resolved.headers['x-api-key'] === 'sk-ant-key')
check('генерация картинок недоступна', resolved.imagesUrl === '')
check('режим всегда direct', resolved.mode === 'direct')
check(
  'toAnthropicTransport переносит адрес',
  toAnthropicTransport(resolved).messagesUrl === resolved.chatUrl,
)
check('toOpenAiTransport не тронут', toOpenAiTransport(resolved).chatUrl === resolved.chatUrl)

check(
  'proxy-режим для Claude запрещён',
  throws(() => resolveTransport({ ...anthropicSettings, mode: 'proxy' })),
)
check(
  'без ключа Claude ошибка понятная',
  throws(() => resolveTransport({ ...anthropicSettings, apiKey: '' })),
)
check(
  'без Base URL Claude ошибка понятная',
  throws(() => resolveTransport({ ...anthropicSettings, baseUrl: '' })),
)

const withOwnImages: Settings = {
  ...anthropicSettings,
  image: {
    ...base.image,
    enabled: true,
    mode: 'direct',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-image',
  },
}
const imageTransport = resolveTransport(withOwnImages, 'image')
check(
  'своё подключение для картинок работает',
  imageTransport.imagesUrl === 'https://api.openai.com/v1/images/generations',
)
check(
  'картинки без своего подключения запрещены',
  throws(() => resolveTransport(anthropicSettings, 'image')),
)

const openAiSettings: Settings = {
  ...base,
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1/',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
}
const openAiResolved = resolveTransport(openAiSettings)
check('OpenAI-путь не изменился', openAiResolved.chatUrl === 'https://api.openai.com/v1/chat/completions')
check('картинки OpenAI на месте', openAiResolved.imagesUrl === 'https://api.openai.com/v1/images/generations')
check('ключ OpenAI уходит в Bearer', openAiResolved.headers.Authorization === 'Bearer sk-test')

// ---------------------------------------------------- пресеты
check('адрес api.anthropic.com распознаётся', looksLikeAnthropic('https://api.anthropic.com/v1'))
check('посторонний адрес не распознаётся', !looksLikeAnthropic('https://api.openai.com/v1'))
check('пресет Claude включает свой протокол', presetProtocol(presetById('anthropic')) === 'anthropic')
check('пресеты без протокола остаются OpenAI', presetProtocol(presetById('openai')) === 'openai')
check('«свой адрес» — OpenAI по умолчанию', presetProtocol(presetById('custom')) === 'openai')

finish()
