import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { isNativeApp } from './nativeShell'

/**
 * Мост к локальному Android-плагину SynthUpdater
 * (android/app/src/main/java/app/synth/hub/UpdaterPlugin.java).
 *
 * Плагин качает APK в файловую систему приложения и запускает системный
 * установщик пакета. В веб-версии эти функции не вызываются: там обновление
 * просто скачивается по ссылке на релиз.
 */

export interface NativeAppInfo {
  versionName?: string
  versionCode?: number
}

export interface DownloadProgress {
  received: number
  total: number
}

interface SynthUpdaterPlugin {
  appInfo(): Promise<NativeAppInfo>
  canInstall(): Promise<{ allowed: boolean }>
  openInstallSettings(): Promise<void>
  download(options: { url: string; fileName?: string }): Promise<{ path: string; size: number }>
  cancelDownload(): Promise<void>
  install(options: { path: string }): Promise<{ started: boolean }>
  addListener(
    eventName: 'progress',
    listenerFunc: (data: DownloadProgress) => void,
  ): Promise<PluginListenerHandle>
}

let instance: SynthUpdaterPlugin | null = null

function updater(): SynthUpdaterPlugin {
  instance ??= registerPlugin<SynthUpdaterPlugin>('SynthUpdater')
  return instance
}

/** Плагин доступен только в Android-сборке. */
export function nativeUpdaterAvailable(): boolean {
  return isNativeApp() && Capacitor.getPlatform() === 'android'
}

/** Версия установленного пакета (из Android, а не из бандла). */
export async function nativeAppVersion(): Promise<NativeAppInfo | null> {
  if (!nativeUpdaterAvailable()) return null
  try {
    return await updater().appInfo()
  } catch {
    return null
  }
}

/** Разрешена ли установка APK из этого приложения (API 26+). */
export async function nativeCanInstall(): Promise<boolean> {
  if (!nativeUpdaterAvailable()) return false
  try {
    const { allowed } = await updater().canInstall()
    return allowed
  } catch {
    return false
  }
}

/** Системный экран «Установка неизвестных приложений» для SYNTH. */
export async function nativeOpenInstallSettings(): Promise<void> {
  if (!nativeUpdaterAvailable()) return
  try {
    await updater().openInstallSettings()
  } catch {
    // намеренно тихо: пользователь просто продолжит вручную
  }
}

/**
 * Качает APK и возвращает путь к файлу внутри песочницы приложения.
 * onProgress получает долю 0..1 (total = -1, если сервер не отдал размер).
 */
export async function nativeDownloadApk(
  url: string,
  fileName: string,
  onProgress?: (ratio: number, progress: DownloadProgress) => void,
): Promise<string> {
  const plugin = updater()
  let handle: PluginListenerHandle | undefined
  if (onProgress) {
    handle = await plugin.addListener('progress', (data) => {
      const ratio = data.total > 0 ? Math.min(1, data.received / data.total) : 0
      onProgress(ratio, data)
    })
  }
  try {
    const result = await plugin.download({ url, fileName })
    return result.path
  } finally {
    await handle?.remove()
  }
}

export async function nativeCancelDownload(): Promise<void> {
  if (!nativeUpdaterAvailable()) return
  try {
    await updater().cancelDownload()
  } catch {
    // no-op
  }
}

/** Запускает системный установщик для скачанного APK. */
export async function nativeInstallApk(path: string): Promise<void> {
  await updater().install({ path })
}
