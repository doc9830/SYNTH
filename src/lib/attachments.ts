import type { ImageAttachment } from '@/types'
import { blobToDataUrl, dataUrlToBlob } from './dataUrl'
import { uid } from './utils'

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']

/** Расширение → MIME: Android-провайдеры часто отдают пустой type или octet-stream. */
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Максимальная длинная сторона при отправке в модель (экономия токенов). */
const MAX_SIDE = 1400

/**
 * Тип изображения: сначала `file.type`, при пустом/неизвестном — по расширению.
 * На Android файл из «Галереи» или камеры может прийти без MIME-типа,
 * и без этой проверки он бы отбраковывался как «неподдерживаемый».
 */
export function imageMimeOf(file: File): string {
  const type = (file.type || '').toLowerCase()
  if (ACCEPTED_IMAGE_TYPES.includes(type)) return type
  const ext = file.name?.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_MIME[ext] ?? type
}

export function isImageFile(file: File): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(imageMimeOf(file))
}

/** canvas → Blob; старые WebView без `toBlob` получают data URL и переводят его сами. */
function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Не удалось сжать изображение.'))),
        mime,
        quality,
      )
      return
    }
    try {
      const dataUrl = canvas.toDataURL(mime, quality)
      const blob = dataUrlToBlob(dataUrl)
      if (blob) resolve(blob)
      else reject(new Error('Не удалось сжать изображение.'))
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Файл не является изображением или повреждён.'))
    img.src = src
  })
}

/**
 * Готовит изображение к отправке: при необходимости уменьшает и перекодирует
 * в JPEG/WebP, чтобы запрос не раздувался и не упал по 413.
 *
 * Результат — Blob: так картинка и лежит в истории, и живёт в памяти. data URL
 * собирается только в момент отправки запроса провайдеру (см. `agent.ts`).
 */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  if (!isImageFile(file)) {
    throw new Error(`Неподдерживаемый формат «${file.type || 'unknown'}». Разрешены jpg, jpeg, png, webp.`)
  }

  const sourceMime = imageMimeOf(file)
  // размеры мерим по object URL: полный файл в base64 ради этого держать не нужно
  const objectUrl = URL.createObjectURL(file)
  let img: HTMLImageElement
  try {
    img = await loadImage(objectUrl)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))

  if (scale === 1 && file.size < 900_000) {
    return {
      id: uid('att'),
      name: file.name || 'image',
      mime: sourceMime,
      blob: file,
      width: img.width,
      height: img.height,
    }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Браузер не поддерживает обработку изображений (canvas).')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  const mime = sourceMime === 'image/png' ? 'image/png' : 'image/jpeg'
  return {
    id: uid('att'),
    name: file.name || 'image',
    mime,
    blob: await canvasToBlob(canvas, mime, 0.9),
    width: canvas.width,
    height: canvas.height,
  }
}

/** Кэш object URL: один Blob — один URL, пока Blob жив (см. `attachmentSrc`). */
const objectUrls = new WeakMap<Blob, string>()

/**
 * URL для `<img>`: data URL как есть, Blob — object URL.
 * База у нас теперь байтами, поэтому именно сюда смотрит вся вёрстка.
 */
export function attachmentSrc(attachment: ImageAttachment): string {
  if (attachment.dataUrl) return attachment.dataUrl
  const blob = attachment.blob
  if (!blob) return ''
  const cached = objectUrls.get(blob)
  if (cached) return cached
  const url = URL.createObjectURL(blob)
  objectUrls.set(blob, url)
  return url
}

/**
 * data URL вложения — только для запроса провайдеру.
 * Старые записи уже содержат data URL, новые собираем из байтов на месте.
 */
export async function attachmentDataUrl(attachment: ImageAttachment): Promise<string> {
  if (attachment.dataUrl) return attachment.dataUrl
  if (attachment.blob) return blobToDataUrl(attachment.blob)
  throw new Error('Вложение потеряло данные: нет ни blob, ни data URL.')
}

/** Сжимает сгенерированное изображение, чтобы история не разрасталась. */
export async function compressGeneratedImage(dataUrl: string, quality = 0.92): Promise<string> {
  try {
    const img = await loadImage(dataUrl)
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
    if (scale === 1 && dataUrl.length < 700_000) return dataUrl

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const webp = canvas.toDataURL('image/webp', quality)
    // если webp не поддержан браузером, toDataURL вернёт png — берём, что короче
    return webp.length < dataUrl.length ? webp : dataUrl
  } catch {
    return dataUrl
  }
}
