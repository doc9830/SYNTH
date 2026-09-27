import { useEffect } from 'react'
import { syncStatusBar } from './nativeShell'
import { useSettings } from './settings'

/** Применяет тему (light/dark/system) и размер шрифта к <html>. */
export function useAppearance(): void {
  const theme = useSettings((s) => s.settings.ui.theme)
  const fontSize = useSettings((s) => s.settings.ui.fontSize)

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', dark)
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', dark ? '#0a0a0a' : '#ffffff')
      // в APK цвет статус-бара синхронизируем с темой
      void syncStatusBar(dark)
    }

    apply()
    if (theme === 'system') {
      media.addEventListener('change', apply)
      return () => media.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-font-size', fontSize)
  }, [fontSize])
}

/** true, если установлено как PWA (standalone). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}
