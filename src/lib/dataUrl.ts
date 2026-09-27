/**
 * Кодек data URL ↔ Blob.
 *
 * Картинки в базе лежат байтами (Blob), а data URL — только транспорт до
 * провайдера и то, что приходит от старых записей. Держать base64 в сторе
 * было дорого: +33 % объёма на диске и такие же строки в JS-куче.
 */

/** `data:image/png;base64,AAA…` → Blob. `null`, если это не data URL. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(dataUrl)
  if (!match) return null
  const mime = match[1] || 'application/octet-stream'
  const payload = match[3] ?? ''
  try {
    if (!match[2]) {
      // без base64: data:image/svg+xml,<svg…>
      return new Blob([decodeURIComponent(payload)], { type: mime })
    }
    const binary = atob(payload.replace(/\s+/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  } catch {
    return null
  }
}

/** Blob → data URL. Нужен в момент отправки запроса и при сохранении файла. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение.'))
    reader.readAsDataURL(blob)
  })
}

/** Размер base64-нагрузки в байтах — для оценок и проверок. */
export function base64Size(payload: string): number {
  const clean = payload.replace(/\s+/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}
