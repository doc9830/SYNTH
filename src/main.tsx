import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './index.css'
import { installNativeHttpBridge } from './lib/nativeHttp'
import { migrateLegacyStorage } from './lib/storage-migrations'

// PWA: автообновление service worker
registerSW({ immediate: true })

migrateLegacyStorage()

// В APK запросы к внешним сервисам идём через нативный сетевой слой (обход CORS),
// поэтому мост ставим до первого рендера.
installNativeHttpBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
