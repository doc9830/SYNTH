import { chatCompletion, type OpenAiTransport } from './client'
import { ApiError, errorFromResponse, networkError } from './errors'

/**
 * Генерация изображений через OpenAI-совместимый API.
 * Работают два разных механизма:
 *
 *  1. Images API → POST /v1/images/generations (gpt-image-1, dall-e-3,
 *     flux, imagen и т.п.), ответ содержит b64_json или url.
 *  2. Chat-based image-модели (Gemini Image, nano-banana и подобные) —
 *     обычный POST /v1/chat/completions, картинка приходит
 *     как markdown data URI внутри choices[0].message.content.
 *
 * Эти модели НЕ взаимозаменяемы, поэтому обе ветки изолированы здесь.
 */

export const IMAGE_MODELS = {
  openaiImages: ['gpt-image-1'],
  chatImage: ['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview'],
} as const

export function isChatImageModel(model: string): boolean {
  return /gemini.*image|image.*preview/i.test(model)
}

export interface ImageRequest {
  model: string
  prompt: string
  size?: string
  quality?: 'low' | 'medium' | 'high'
  n?: number
}

export interface ImageResult {
  /** data URL'ы готовых изображений */
  images: string[]
  /** текстовый комментарий модели (для chat-image) */
  text: string
  /** человекочитаемое имя провайдера для UI */
  provider: string
}

/** Вытаскивает все изображения вида ![image](data:image/png;base64,...) из текста. */
export function extractDataUriImages(text: string): string[] {
  const out: string[] = []
  const re = /!\[[^\]]*]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    out.push(match[1].replace(/\s+/g, ''))
  }
  return out
}

/** Убирает огромные data URI из текста, оставляя человекочитаемый комментарий. */
export function stripDataUriImages(text: string): string {
  return text
    .replace(/!\[[^\]]*]\(data:image\/[^)]*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

let imageCounter = 0

function dataUrlFromBase64(b64: string, mime = 'image/png'): string {
  imageCounter += 1
  return `data:${mime};base64,${b64.replace(/\s+/g, '')}`
}

/** Способ 2: OpenAI Images API (/v1/images/generations) — gpt-image-2. */
async function generateViaImagesEndpoint(
  transport: OpenAiTransport,
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const body = {
    model: req.model,
    prompt: req.prompt,
    size: req.size ?? '1024x1024',
    quality: req.quality ?? 'low',
    n: req.n ?? 1,
    // просим base64, а не внешний URL: ссылки у провайдера недолговечны
    response_format: 'b64_json',
  }

  let res: Response
  try {
    res = await fetch(transport.imagesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...transport.headers },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw networkError(err, transport.imagesUrl)
  }

  if (!res.ok) {
    const err = await errorFromResponse(res, transport.imagesUrl)
    throw new ApiError({
      message: err.message,
      status: err.status,
      endpoint: transport.imagesUrl,
      hint:
        err.status === 404
          ? 'Проверьте модель генерации изображений в настройках → «Подключение» (например, gpt-image-1) и Base URL с /v1.'
          : err.hint,
      details: err.details,
    })
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
    error?: { message?: string }
  }

  if (json.error?.message) {
    throw new ApiError({ message: json.error.message, endpoint: transport.imagesUrl })
  }

  const images = (json.data ?? [])
    .map((item) => {
      if (item.b64_json) return dataUrlFromBase64(item.b64_json)
      return null
    })
    .filter((v): v is string => Boolean(v))

  if (!images.length) {
    throw new ApiError({
      message: 'Image API не вернул изображение (нет b64_json в ответе).',
      endpoint: transport.imagesUrl,
      details: JSON.stringify(json).slice(0, 1000),
    })
  }

  return { images, text: '', provider: 'images-api' }
}

/** Способ 1: генерация через chat/completions (Gemini Image / Nano Banana). */
async function generateViaChat(
  transport: OpenAiTransport,
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const turn = await chatCompletion(
    transport,
    {
      model: req.model,
      messages: [{ role: 'user', content: req.prompt }],
      stream: false,
    },
    { signal },
  )

  const images = extractDataUriImages(turn.content)
  if (!images.length) {
    throw new ApiError({
      message: 'Модель не вернула изображение. Попробуйте переформулировать запрос.',
      endpoint: transport.chatUrl,
      hint: 'Модели Gemini Image отвечают картинкой не всегда — иногда возвращают только текст.',
      details: turn.content.slice(0, 1000),
    })
  }

  return { images, text: stripDataUriImages(turn.content), provider: `chat-image (${req.model})` }
}

/** Единая точка входа: сама выбирает нужный механизм по модели. */
export async function generateImage(
  transport: OpenAiTransport,
  req: ImageRequest,
  signal?: AbortSignal,
): Promise<ImageResult> {
  if (isChatImageModel(req.model)) {
    return generateViaChat(transport, req, signal)
  }
  return generateViaImagesEndpoint(transport, req, signal)
}
