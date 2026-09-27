import { downloadDataUrl } from './clipboard'
import { downloadText } from './exportChat'
import { nativeFilesAvailable, nativeSaveDataUrl, nativeSaveText } from './nativeFiles'

/**
 * Сохранение файлов «наружу» (экспорт чата, скачивание картинок).
 *
 * В APK работает нативный плагин SynthFiles — в Android 10+ файл сразу
 * появляется в «Загрузках»/«Галерее». В браузере — обычное скачивание.
 */

export interface SaveOutcome {
  ok: boolean
  /** Готовый текст для уведомления: куда сохранилось или что случилось */
  message: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** MIME из data URL; по умолчанию PNG. */
function mimeOfDataUrl(dataUrl: string): string {
  return /^data:([^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? 'image/png'
}

/** Сохраняет текст как файл (Markdown/JSON). */
export async function saveTextFile(
  fileName: string,
  text: string,
  mime = 'text/markdown',
): Promise<SaveOutcome> {
  if (nativeFilesAvailable()) {
    try {
      const saved = await nativeSaveText(fileName, text, mime)
      return {
        ok: true,
        message: saved.visible
          ? `Сохранено в «Загрузки/SYNTH»: ${fileName}`
          : `Сохранено: ${saved.path}`,
      }
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    }
  }

  downloadText(fileName, text, mime)
  return { ok: true, message: 'Файл сохранён в папку загрузок' }
}

/** Сохраняет картинку (data URL) как файл. */
export async function saveImageFile(dataUrl: string, fileName: string): Promise<SaveOutcome> {
  if (nativeFilesAvailable()) {
    try {
      const saved = await nativeSaveDataUrl(fileName, dataUrl, mimeOfDataUrl(dataUrl))
      return {
        ok: true,
        message: saved.visible
          ? `Сохранено в галерею: ${fileName}`
          : `Сохранено: ${saved.path}`,
      }
    } catch (err) {
      return { ok: false, message: errorMessage(err) }
    }
  }

  downloadDataUrl(dataUrl, fileName)
  return { ok: true, message: 'Файл сохранён в папку загрузок' }
}
