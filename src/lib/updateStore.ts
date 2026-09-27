import { create } from 'zustand'
import {
  fetchLatestUpdate,
  markChecked,
  shouldAutoCheck,
  skipVersion,
  skippedVersion,
  type UpdateInfo,
} from './appUpdate'
import {
  nativeDownloadApk,
  nativeInstallApk,
  nativeOpenInstallSettings,
  nativeUpdaterAvailable,
} from './nativeUpdater'
import { notify } from './toast'

/**
 * Состояние проверки обновлений.
 *
 *  • check({auto:true})   — тихая проверка при запуске (не чаще раза в 6 часов,
 *    уважает «Пропустить эту версию»);
 *  • check({manual:true}) — из настроек/кнопки: всегда сообщает результат;
 *  • downloadAndInstall() — скачивает APK (в APK-сборке) и открывает системный
 *    установщик; в браузере — просто открывает страницу релиза.
 */

interface UpdateState {
  info: UpdateInfo | null
  checking: boolean
  dialogOpen: boolean
  downloading: boolean
  /** Прогресс загрузки 0..1 */
  progress: number
  error: string | null
  /** Путь к уже скачанному APK: пригодится, если установку прервал запрос разрешения */
  apkPath: string | null

  check: (opts?: { manual?: boolean; auto?: boolean }) => Promise<void>
  openDialog: () => void
  closeDialog: () => void
  /** Больше не предлагать эту версию */
  skip: () => void
  downloadAndInstall: () => Promise<void>
  /** Повторный запуск установщика для уже скачанного файла */
  installDownloaded: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  info: null,
  checking: false,
  dialogOpen: false,
  downloading: false,
  progress: 0,
  error: null,
  apkPath: null,

  check: async (opts) => {
    const manual = Boolean(opts?.manual)
    const auto = Boolean(opts?.auto)
    const state = get()
    if (state.checking || state.downloading) return
    if (auto && !shouldAutoCheck()) return

    set({ checking: true, error: null })
    try {
      const info = await fetchLatestUpdate()
      markChecked()
      if (!info) {
        set({ checking: false })
        if (manual) notify('Установлена последняя версия', 'success')
        return
      }
      // авто-проверка молчит про версии, которые пользователь уже пропустил
      if (!manual && skippedVersion() === info.version) {
        set({ checking: false })
        return
      }
      set({ checking: false, info, dialogOpen: true, apkPath: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ checking: false, error: message })
      if (manual) notify(message, 'error')
    }
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),

  skip: () => {
    const version = get().info?.version
    if (version) skipVersion(version)
    set({ dialogOpen: false })
  },

  installDownloaded: async () => {
    const path = get().apkPath
    if (!path) return
    try {
      await nativeInstallApk(path)
      set({ dialogOpen: false, error: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ error: message })
      if (/INSTALL_PERMISSION_REQUIRED|неизвестных источников/i.test(message)) {
        notify('Разрешите установку приложений для SYNTH — сейчас откроем настройки', 'info')
        await nativeOpenInstallSettings()
        return
      }
      notify(message, 'error')
    }
  },

  downloadAndInstall: async () => {
    const { info, downloading, apkPath } = get()
    if (!info || downloading) return

    if (apkPath) {
      await get().installDownloaded()
      return
    }

    // В браузере установить APK нельзя — открываем страницу релиза
    if (!nativeUpdaterAvailable() || !info.apk) {
      const target = info.apk?.url ?? info.pageUrl
      globalThis.open?.(target, '_blank', 'noopener')
      set({ dialogOpen: false })
      return
    }

    set({ downloading: true, progress: 0, error: null })
    try {
      const path = await nativeDownloadApk(info.apk.url, info.apk.name, (ratio) =>
        set({ progress: ratio }),
      )
      set({ downloading: false, progress: 1, apkPath: path })
      await get().installDownloaded()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ downloading: false, error: message })
      notify(message, 'error')
    }
  },
}))
