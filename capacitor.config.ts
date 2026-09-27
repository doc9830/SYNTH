import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Конфигурация нативной оболочки (Android/iOS).
 *
 * Сборка APK:
 *   npm run build && npm run android:sync && npm run android:apk
 * Подробности — в ANDROID.md.
 */
const config: CapacitorConfig = {
  appId: 'app.synth.hub',
  appName: 'SYNTH',
  webDir: 'dist',
  server: {
    // WebView отдаёт приложение с https://localhost — так работают Service Worker
    // и CORS-запросы к OpenAI-совместимым API.
    androidScheme: 'https',
    // Разрешаем http:// (локальный backend в LAN, SearXNG, Termux-сервер)
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
    // Chrome DevTools → chrome://inspect для отладки WebView
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    // Глобальный патч fetch от CapacitorHttp выключен: он буферизует ответы
    // и ломает потоковую выдачу (SSE). Вместо него — src/lib/nativeHttp.ts,
    // который отправляет через нативный слой только не-стриминговые запросы.
    CapacitorHttp: { enabled: false },
    StatusBar: {
      overlaysWebView: false,
    },
  },
}

export default config
