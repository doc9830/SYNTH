/**
 * Проверки изображений на вход: эвристика возможностей модели, ручное
 * переопределение в настройках, сборка wire-сообщений с картинками
 * и подсказка, когда провайдер отклонил изображение.
 *
 * Повод: модель `deepseek-v4.1-flash` (пресет RuAPI) умеет vision, но
 * приложение считало её текстовой и не давало приложить картинку.
 * Запуск: npm run checks
 */
import { buildWireMessages } from '@/lib/agent'
import {
  DEFAULT_SETTINGS,
  sanitizeVisionInput,
  type Settings,
} from '@/lib/settings'
import { IMAGE_REJECTED_HINT, errorFromResponse } from '@/providers/openai/errors'
import type { WireContentPart } from '@/providers/openai/types'
import type { ChatMessage, ImageAttachment } from '@/types'
import { getModelCapabilities } from '@/lib/utils'
import { check, finish } from './harness'

const vision = (model: string, mode: 'auto' | 'on' | 'off' = 'auto') =>
  getModelCapabilities(model, mode).vision

// 1. Эвристика по id модели
check('deepseek-v4.1-flash распознаётся как vision', vision('deepseek-v4.1-flash'))
check('qwen3-vl-235b распознаётся как vision', vision('qwen3-vl-235b'))
check('claude-sonnet-4-5 распознаётся как vision', vision('claude-sonnet-4-5'))
check('gpt-4o распознаётся как vision', vision('gpt-4o'))
check('o4-mini распознаётся как vision', vision('o4-mini'))
check('gemini-2.5-flash распознаётся как vision', vision('gemini-2.5-flash'))
check('deepseek-chat остаётся текстовой', !vision('deepseek-chat'))
check('deepseek-reasoner остаётся текстовой', !vision('deepseek-reasoner'))
check('эмбеддинги не vision', !vision('text-embedding-3-small'))
check('gpt-image-1 не vision', !vision('gpt-image-1'))
check('dall-e-3 не vision (генератор картинок)', !vision('dall-e-3'))
check('пустой id не падает', !vision(''))

// 2. Ручное переопределение в настройках важнее эвристики
check('override «да» включает картинки у текстовой модели', vision('deepseek-chat', 'on'))
check('override «нет» выключает картинки у vision-модели', !vision('claude-sonnet-4-5', 'off'))
check('режим по умолчанию — авто', DEFAULT_SETTINGS.visionInput === 'auto')
check('sanitizeVisionInput(undefined) → авто', sanitizeVisionInput(undefined) === 'auto')
check('sanitizeVisionInput("on") → да', sanitizeVisionInput('on') === 'on')
check('sanitizeVisionInput("ерунда") → авто', sanitizeVisionInput('ерунда') === 'auto')

// 3. Прочие возможности не пострадали
const caps = getModelCapabilities('deepseek-v4.1-flash')
check('у deepseek-v4.1-flash есть reasoning', caps.reasoning)
check('у deepseek-v4.1-flash есть инструменты', caps.tools)
check('у gpt-image-1 нет инструментов', !getModelCapabilities('gpt-image-1').tools)

// 4. Wire-сообщения: картинки уходят как image_url, а не «выбрасываются»
const attachment: ImageAttachment = {
  id: 'att1',
  name: 'photo.png',
  mime: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA',
}

const oneMessage: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    createdAt: Date.now(),
    content: 'что на фото?',
    attachments: [attachment],
    status: 'complete',
  },
]

function settingsWith(model: string, visionInput: Settings['visionInput']): Settings {
  const next: Settings = structuredClone(DEFAULT_SETTINGS)
  next.model = model
  next.visionInput = visionInput
  return next
}

function lastUser(settings: Settings): WireContentPart[] | string | null {
  const wire = buildWireMessages(oneMessage, settings)
  const last = wire[wire.length - 1]
  return Array.isArray(last.content) ? last.content : last.content
}

const withImage = lastUser(settingsWith('deepseek-v4.1-flash', 'auto'))
check(
  'deepseek-v4.1-flash получает картинку в запросе',
  Array.isArray(withImage) &&
    withImage.some((p) => p.type === 'image_url' && p.image_url.url === attachment.dataUrl),
)
check(
  'текст пользователя остаётся рядом с картинкой',
  Array.isArray(withImage) && withImage[0].type === 'text' && withImage[0].text === 'что на фото?',
)

const textOnly = lastUser(settingsWith('deepseek-chat', 'auto'))
check(
  'текстовая модель получает пояснение вместо картинки',
  typeof textOnly === 'string' && textOnly.includes('не принимает изображения на вход'),
)

const forced = lastUser(settingsWith('deepseek-chat', 'on'))
check(
  'переопределение «да» отправляет картинку текстовой модели',
  Array.isArray(forced) && forced.some((p) => p.type === 'image_url'),
)

const forbidden = lastUser(settingsWith('claude-sonnet-4-5', 'off'))
check(
  'переопределение «нет» не отправляет картинку',
  typeof forbidden === 'string' && forbidden.includes('не принимает изображения на вход'),
)

const noAttachment: ChatMessage[] = [
  { id: 'm2', role: 'user', createdAt: Date.now(), content: 'привет', status: 'complete' },
]
const plain = buildWireMessages(noAttachment, settingsWith('deepseek-chat', 'auto'))
check('сообщение без вложений остаётся строкой', plain[plain.length - 1].content === 'привет')

// 5. Ошибка провайдера про картинку → понятная подсказка
async function imageErrorHint(): Promise<{ hint?: string; message: string }> {
  const res = new Response(JSON.stringify({ error: { message: 'image_url is not supported by this model' } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })
  const err = await errorFromResponse(res, 'https://example.test/v1/chat/completions')
  return { hint: err.hint, message: err.message }
}

const imageError = await imageErrorHint()
check('текст ошибки провайдера сохраняется', imageError.message.includes('image_url is not supported'))
check('на отказ из-за картинки показывается подсказка про вложения', imageError.hint === IMAGE_REJECTED_HINT)

const modelError = await errorFromResponse(
  new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }),
  'https://example.test/v1/chat/completions',
)
check('обычная ошибка сохраняет свою подсказку', modelError.hint?.includes('имя модели') === true)

finish()
