import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'
import { installNativeHttpBridge } from './lib/nativeHttp'
import { isNativeApp } from './lib/nativeShell'
import { migrateLegacyStorage } from './lib/storage-migrations'

/**
 * Нативная оболочка? Второй признак нужен на случай service worker: если он
 * отдал из кэша старый index.html, нативный мост Capacitor в страницу не
 * попадает и `isNativeApp()` ошибочно отвечает false — тогда пропадают вообще
 * все нативные возможности (TTS, обновления, файлы). APK отдаёт приложение по
 * адресу https://localhost.
 */
function looksNativeShell(): boolean {
  if (isNativeApp()) return true
  const place = globalThis.location
  return place?.protocol === 'https:' && place?.hostname === 'localhost'
}

/**
 * PWA: автообновление service worker — только в браузере.
 *
 * В APK ассеты и так лежат внутри приложения, поэтому precache workbox там не
 * нужен, зато опасен: после установки новой версии он мог отдать из кэша
 * бандл прошлой сборки (вместе со старым index.html) — и пользователь «не
 * видел» новых возможностей, хотя APK уже обновился. Поэтому в нативном
 * приложении регистрацию снимаем, кэши чистим, а если страницу обслуживал
 * старый worker — один раз перезагружаемся и показываем установленную сборку.
 */
if (looksNativeShell()) {
  const sw = navigator.serviceWorker
  const cachesApi = globalThis.caches
  const CLEANUP_FLAG = 'synth-sw-cleanup'

  void (async () => {
    if (cachesApi) {
      const keys = await cachesApi.keys().catch(() => [])
      await Promise.all(keys.map((key) => cachesApi.delete(key).catch(() => false)))
    }
    const controlled = Boolean(sw?.controller)
    const registrations = sw ? await sw.getRegistrations().catch(() => []) : []
    await Promise.all(registrations.map((item) => item.unregister().catch(() => false)))
    try {
      // Перезагружаемся максимум один раз за запуск приложения: защита от петли.
      if (controlled && !sessionStorage.getItem(CLEANUP_FLAG)) {
        sessionStorage.setItem(CLEANUP_FLAG, '1')
        window.location.reload()
      }
    } catch {
      // приватный режим: sessionStorage может быть недоступен — просто живём дальше
    }
  })()
} else {
  registerSW({ immediate: true })
}

migrateLegacyStorage()

// В APK запросы к внешним сервисам идём через нативный сетевой слой (обход CORS),
// поэтому мост ставим до первого рендера.
installNativeHttpBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
