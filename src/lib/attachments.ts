import type { ImageAttachment } from '@/types'
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

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать файл.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Файл не является изображением или повреждён.'))
    img.src = dataUrl
  })
}

/**
 * Готовит изображение к отправке: при необходимости уменьшает
 * и перекодирует в JPEG/WebP, чтобы запрос не раздувался и не упал по 413.
 */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  if (!isImageFile(file)) {
    throw new Error(`Неподдерживаемый формат «${file.type || 'unknown'}». Разрешены jpg, jpeg, png, webp.`)
  }

  const sourceMime = imageMimeOf(file)
  const original = await readAsDataUrl(file)
  const img = await loadImage(original)
  const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))

  if (scale === 1 && file.size < 900_000) {
    return {
      id: uid('att'),
      name: file.name || 'image',
      mime: sourceMime,
      dataUrl: original,
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
  const dataUrl = canvas.toDataURL(mime, 0.9)

  return {
    id: uid('att'),
    name: file.name || 'image',
    mime,
    dataUrl,
    width: canvas.width,
    height: canvas.height,
  }
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
