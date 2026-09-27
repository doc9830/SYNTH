import { Capacitor, registerPlugin } from '@capacitor/core'
import { isNativeApp } from './nativeShell'

/**
 * Мост к локальному Android-плагину SynthFiles
 * (android/app/src/main/java/app/synth/hub/FilesPlugin.java).
 *
 * Нужен потому, что в WebView обычное скачивание (&lt;a download&gt;) не работает:
 * у WebView нет DownloadListener, и «Экспорт в .md» / «Скачать» картинку
 * в APK молча ничего не делали.
 */

export interface SavedFile {
  /** Путь или content:// URI сохранённого файла */
  path: string
  /** true — файл лёг в общую папку («Загрузки»/«Галерея»), а не в песочницу */
  visible: boolean
}

interface SynthFilesPlugin {
  saveText(options: { fileName: string; text: string; mime?: string }): Promise<SavedFile>
  saveBase64(options: { fileName: string; base64: string; mime?: string }): Promise<SavedFile>
}

let instance: SynthFilesPlugin | null = null

function files(): SynthFilesPlugin {
  instance ??= registerPlugin<SynthFilesPlugin>('SynthFiles')
  return instance
}

/** Плагин доступен только в Android-сборке. */
export function nativeFilesAvailable(): boolean {
  return isNativeApp() && Capacitor.getPlatform() === 'android'
}

/** Сохраняет текстовый файл (UTF-8) средствами Android. */
export function nativeSaveText(fileName: string, text: string, mime: string): Promise<SavedFile> {
  return files().saveText({ fileName, text, mime })
}

/** Сохраняет файл из data URL (картинку) средствами Android. */
export function nativeSaveDataUrl(fileName: string, dataUrl: string, mime: string): Promise<SavedFile> {
  return files().saveBase64({ fileName, base64: dataUrl, mime })
}
