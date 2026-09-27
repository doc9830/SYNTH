/**
 * Нативная оболочка приложения (Capacitor → Android APK).
 *
 * Здесь собрано всё, что отличается от веб-версии: определение платформы,
 * цвет статус-бара и аппаратная кнопка «Назад».
 * На веб-сборке (PWA в браузере) все функции — no-op, ничего не ломается.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** true — приложение открыто как нативное (APK/IPA), а не как PWA в браузере. */
export function isNativeApp(): boolean {
  const cap = capacitor()
  return Boolean(cap?.isNativePlatform?.())
}

/** 'android' | 'ios' | 'web' */
export function appPlatform(): string {
  return capacitor()?.getPlatform?.() ?? 'web'
}

/** Синхронизирует цвет статус-бара с темой приложения (Android/iOS). */
export async function syncStatusBar(dark: boolean): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // Style.Dark — светлые иконки (тёмная тема), Style.Light — тёмные иконки
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    await StatusBar.setBackgroundColor({ color: dark ? '#0b0d12' : '#ffffff' })
  } catch {
    // плагин недоступен — просто работаем без настройки статус-бара
  }
}

/** Подписка на аппаратную кнопку «Назад» (Android). Возвращает функцию отписки. */
export function onAndroidBack(handler: () => void): () => void {
  if (!isNativeApp()) return () => undefined
  let disposed = false
  let remove: (() => void) | undefined

  void import('@capacitor/app')
    .then(({ App: CapacitorApp }) =>
      CapacitorApp.addListener('backButton', () => handler()).then((sub) => {
        if (disposed) void sub.remove()
        else remove = () => void sub.remove()
      }),
    )
    .catch(() => undefined)

  return () => {
    disposed = true
    remove?.()
  }
}

/** Свернуть приложение (Android), когда «Назад» закрывать уже нечего. */
export async function minimizeApp(): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { App: CapacitorApp } = await import('@capacitor/app')
    await CapacitorApp.minimizeApp()
  } catch {
    // no-op
  }
}
