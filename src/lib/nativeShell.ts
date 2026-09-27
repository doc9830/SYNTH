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

/**
 * Android-устройство: APK на телефоне или браузер/WebView в Android.
 *
 * Нужно там, где поведение отличается от десктопа: на телефонной клавиатуре
 * Enter должен вставлять перенос строки, а отправлять — кнопка со стрелкой.
 */
export function isAndroidDevice(): boolean {
  if (appPlatform() === 'android') return true
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

/** Синхронизирует цвет статус-бара с темой приложения (Android/iOS). */
export async function syncStatusBar(dark: boolean): Promise<void> {
  if (!isNativeApp()) return
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar')
    // Style.Dark — светлые иконки (тёмная тема), Style.Light — тёмные иконки
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
    // цвет совпадает с фоном приложения (neutral-950) и meta theme-color
    await StatusBar.setBackgroundColor({ color: dark ? '#0a0a0a' : '#ffffff' })
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

/**
 * Вызов при возвращении приложения на передний план (после системных настроек,
 * установщика пакета, камеры). Возвращает функцию отписки.
 */
export function onAppResume(handler: () => void): () => void {
  if (!isNativeApp()) return () => undefined
  let disposed = false
  let remove: (() => void) | undefined

  void import('@capacitor/app')
    .then(({ App: CapacitorApp }) =>
      CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) handler()
      }).then((sub) => {
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
