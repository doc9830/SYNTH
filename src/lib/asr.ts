import { appPlatform, isNativeApp } from './nativeShell'

/**
 * Голосовой ввод системным распознаванием речи Android (задача 07).
 *
 * Жёсткое ограничение задачи: только `android.speech.SpeechRecognizer`. Ни
 * сторонних моделей, ни облачных STT, ни скачиваемых весов. Распознаёт либо
 * офлайн-сервис устройства (`createOnDeviceSpeechRecognizer()`, API 31+), либо
 * системный сервис распознавания — подробности в нативном плагине
 * (android/app/src/main/java/app/synth/hub/SpeechPlugin.java).
 *
 * Слой платформы: приводит события плагина к внутреннему виду (`AsrEvent`),
 * прячет мост (`src/lib/nativeAsr.ts`) и хранит тексты сообщений. Состояние
 * записи живёт в `src/lib/useDictation.ts`, кнопка — в `src/ui/Composer.tsx`.
 *
 * В браузере голосового ввода нет: системного `SpeechRecognizer` там не
 * существует, а `SpeechRecognition` работает через облако, что запрещено
 * ограничением задачи. Кнопка микрофона в веб-сборке не рисуется.
 */

/**
 * Почему голосового ввода нет. Токены `NO_SERVICE` / `ONDEVICE_SILENT` /
 * `PLUGIN_ERROR` приходят от плагина и моста как есть: раньше `probeAsr`
 * заменял любую причину на общую `no-service`, и в интерфейсе все они выглядели
 * одной фразой «распознавание недоступно» — по ней нельзя было понять, что чинить.
 */
export type AsrUnavailableReason =
  | 'unsupported' // не Android-приложение: системного распознавания нет
  | 'NO_SERVICE' // сервиса распознавания на устройстве нет вовсе
  | 'ONDEVICE_SILENT' // офлайн-движок объявлен, но не отвечает
  | 'PLUGIN_ERROR' // плагин или мост не ответил: проверить не удалось

export interface AsrInfo {
  available: boolean
  reason?: AsrUnavailableReason
  /** true — распознаёт офлайн-сервис устройства (API 31+), false — системный. */
  onDevice?: boolean
  /** Диагностика: офлайн-движок объявлен прошивкой устройства. */
  deviceModel?: boolean
  /** Диагностика: сервис распознавания виден через PackageManager. */
  systemService?: boolean
  language?: string
  permission?: string
}

/** События одной сессии записи — тот же набор, что шлёт плагин. */
export type AsrEvent =
  | { kind: 'ready' }
  | { kind: 'speech' }
  | { kind: 'partial'; text: string }
  | { kind: 'silence' }
  | { kind: 'final'; text: string | null; onDevice: boolean }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'cancelled'; reason: 'user' | 'lifecycle' }

export interface DictationStart {
  onDevice: boolean
  language: string
}

/** Язык распознавания: русский, как и у озвучки. */
export const ASR_LANGUAGE = 'ru-RU'
/** Молчание, после которого сервис сам завершает запись (автостоп). */
export const ASR_SILENCE_MS = 1100

/**
 * Почему тап-старт / тап-стоп, а не «удерживать кнопку».
 *
 * Удержание заставляет держать палец на кнопке и смотреть в экран: на ходу это
 * неудобно, а случайно сдвинутый палец обрывает фразу. Тап-старт оставляет руки
 * свободными — говорите сколько нужно, а запись заканчивается вторым тапом или
 * сама по тишине.
 */
export const DICTATION_TAP_HINT = 'тап — начать, второй тап — закончить (или просто замолчать)'

/** Подпись кнопки микрофона: в покое — как начать, во время записи — что будет. */
export function describeDictationButton(active: boolean): string {
  return active ? 'Закончить запись' : `Голосовой ввод: ${DICTATION_TAP_HINT}`
}

/** Из чего распознаётся речь — для диагностики. */
export function describeDictationSource(onDevice: boolean): string {
  return onDevice ? 'офлайн-сервис устройства' : 'системный сервис распознавания'
}

/** Номер текущей сессии: события прошлых сессий игнорируем. */
let session = 0

/**
 * Голосовой ввод есть только в Android-сборке: системного распознавания речи
 * в браузере нет, а облачные движки запрещены ограничением задачи.
 */
export function asrSupported(): boolean {
  return isNativeApp() && appPlatform() === 'android'
}

/** Проверка сервиса распознавания, офлайн-движка и разрешения на микрофон. */
export async function probeAsr(): Promise<AsrInfo> {
  if (!asrSupported()) return { available: false, reason: 'unsupported' }
  const { nativeAsrInfo } = await import('./nativeAsr')
  try {
    const info = await nativeAsrInfo()
    return {
      available: info.available,
      // Причину берём у плагина: он различает «сервиса нет», «офлайн-движок
      // молчит» и «система не смогла создать распознаватель», и по ней человек
      // понимает, что делать.
      reason: info.available ? undefined : ((info.reason as AsrUnavailableReason) ?? 'NO_SERVICE'),
      onDevice: info.onDevice,
      deviceModel: info.deviceModel,
      systemService: info.systemService,
      language: info.language,
      permission: info.permission,
    }
  } catch {
    // Плагин не ответил — это не «сервиса нет»: так и говорим.
    return { available: false, reason: 'PLUGIN_ERROR' }
  }
}

/** Запрос разрешения RECORD_AUDIO — системный диалог, первое использование. */
export async function requestMicAccess(): Promise<string> {
  if (!asrSupported()) return 'denied'
  const { nativeMicPermission } = await import('./nativeAsr')
  return await nativeMicPermission()
}

/**
 * Преобразование события плагина во внутреннее. Чистая функция: непонятные
 * состояния отбрасываются (`null`), частичный текст без текста — тоже.
 */
export function asrEventFromNative(data: {
  state?: string
  text?: string
  code?: string
  reason?: string
  onDevice?: boolean
}): AsrEvent | null {
  switch (data.state) {
    case 'ready':
      return { kind: 'ready' }
    case 'speech':
      return { kind: 'speech' }
    case 'silence':
      return { kind: 'silence' }
    case 'partial':
      return data.text ? { kind: 'partial', text: data.text } : null
    case 'final':
      return { kind: 'final', text: data.text ?? null, onDevice: Boolean(data.onDevice) }
    case 'error':
      // Код сервиса сохраняем: по нему видно, что именно ответило устройство.
      return { kind: 'error', message: asrErrorMessage(data.code), code: data.code }
    case 'cancelled':
      return { kind: 'cancelled', reason: data.reason === 'lifecycle' ? 'lifecycle' : 'user' }
    default:
      return null
  }
}

/** Коды ошибок системного сервиса — понятные фразы. */
export function asrErrorMessage(code?: string): string {
  switch (code) {
    case 'NO_MATCH':
      return 'Речь не распознана: попробуйте говорить ближе к микрофону.'
    case 'SILENCE':
      return 'Тишина: ничего не услышал.'
    case 'NETWORK':
      return 'Распознавание не достучалось до сервиса: проверьте интернет или офлайн-пакет.'
    case 'PERMISSION_DENIED':
      return 'Нет доступа к микрофону: разрешите его в настройках Android.'
    case 'CLIENT':
      // ERROR_CLIENT: система не подключила распознаватель — обычно не выбран
      // сервис распознавания речи (в 1.7.2 это выглядело как «недоступно»).
      return 'Системный распознаватель речи не подключился: проверьте, что в настройках Android выбран сервис распознавания речи (Система → Языки и ввод → Распознавание речи).'
    case 'BUSY':
      return 'Распознавание занято: попробуйте ещё раз через пару секунд.'
    case 'AUDIO':
      return 'Микрофон недоступен — его заняло другое приложение.'
    case 'SERVER':
      return 'Сервис распознавания вернул ошибку.'
    case 'NO_START':
      return 'Не удалось начать запись: сервис распознавания не ответил. Попробуйте ещё раз — сервису бывает нужно время, чтобы включиться.'
    case 'NO_RESULT':
      return 'Сервис распознавания не отдал результат.'
    case 'TOO_MANY':
      return 'Сервис распознавания перегружен запросами: попробуйте через минуту.'
    case 'NO_LANGUAGE':
      return 'Сервис распознавания не поддерживает русский язык: включите русский в настройках распознавания речи Android.'
    case 'NO_PACK':
      return 'Нет русского офлайн-пакета распознавания: скачайте его в настройках Android (Система → Языки и ввод → Распознавание речи) или подключитесь к интернету.'
    default:
      return 'Не удалось распознать речь.'
  }
}

/**
 * Код отказа плагина: Capacitor кладёт его в `error.code`, а текст — в
 * `error.message`. Нужен, чтобы причина отказа не подменялась общей фразой.
 */
export function asrFailureCode(error: unknown): string | null {
  if (typeof error === 'string') return error || null
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && code) return code
    if (typeof message === 'string' && message) return message
  }
  return null
}

/**
 * Почему запись не началась — словами.
 *
 * До этого любая осечка старта показывалась одной и той же фразой «сервис
 * распознавания не ответил», и настоящая причина терялась: отказ в микрофоне,
 * отсутствие сервиса и молчащий плагин выглядели одинаково.
 */
export function describeStartFailure(error: unknown): string {
  const code = asrFailureCode(error)
  if (code?.includes('PERMISSION_DENIED') || code?.includes('Нет разрешения')) return describeMicDenied()
  if (code?.includes('CREATE_FAILED')) {
    return 'Система не смогла создать распознаватель речи: проверьте, что в настройках Android выбран сервис распознавания речи, — или печатайте текстом.'
  }
  if (code?.includes('NO_SERVICE') || code?.includes('недоступно на этом устройстве')) {
    return describeAsrUnavailable({ available: false, reason: 'NO_SERVICE' }) ?? asrErrorMessage('NO_START')
  }
  return asrErrorMessage('NO_START')
}

/**
 * Причина недоступности распознавания — или null, если оно работает.
 *
 * Причина называется конкретно: «сервиса нет» и «офлайн-движок молчит» — это
 * разные состояния с разными действиями, а общая фраза «недоступно» ничего не
 * объясняла. Разрешение на микрофон проверяем первым: без него запись не
 * начнётся, даже когда сервис на устройстве есть.
 */
export function describeAsrUnavailable(info: AsrInfo | null): string | null {
  if (info?.available) return null
  if (info?.reason === 'unsupported') {
    return 'Голосовой ввод работает в Android-приложении SYNTH — здесь можно печатать текстом.'
  }
  if (info?.permission && info.permission !== 'granted') return describeMicDenied()
  switch (info?.reason) {
    case 'NO_SERVICE':
      // Частая история на де-Гугленных прошивках и части китайских ромов.
      return 'Распознавание речи недоступно: сервиса распознавания на устройстве нет — можно печатать текстом.'
    case 'ONDEVICE_SILENT':
      return 'Распознавание речи недоступно: офлайн-движок устройства не отвечает, а системного сервиса нет — можно печатать текстом.'
    case 'PLUGIN_ERROR':
      return 'Не удалось проверить распознавание речи: плагин не ответил — можно печатать текстом.'
    default:
      return 'Распознавание речи недоступно на этом устройстве — можно печатать текстом.'
  }
}

/** Отказ в доступе к микрофону: как это исправить. */
export function describeMicDenied(): string {
  return 'Без доступа к микрофону голосовой ввод не работает: разрешите его в Настройках Android → Приложения → SYNTH → Разрешения.'
}

/** Сервис распознаёт через сеть (Android до 12 или без офлайн-пакета). */
export function describeDictationNetwork(): string {
  return 'Системный сервис распознавания может обрабатывать речь через сеть: без интернета он не ответит.'
}

/**
 * Старт записи. Возвращает источник распознавания; ход записи приходит в
 * `onEvent`. Завершается `stopDictation()` (система отдаёт итоговый текст)
 * или `cancelDictation()` (результат выбрасывается).
 */
export async function startDictation(onEvent: (event: AsrEvent) => void): Promise<DictationStart> {
  session++
  const mySession = session
  const alive = () => session === mySession
  const { nativeAsrStart } = await import('./nativeAsr')
  return await nativeAsrStart(
    (data) => {
      if (!alive()) return
      const event = asrEventFromNative(data)
      if (event) onEvent(event)
    },
    { lang: ASR_LANGUAGE, silenceMs: ASR_SILENCE_MS },
  )
}

/** «Закончить»: сервис отдаёт итоговый текст и сам выключает микрофон. */
export async function stopDictation(): Promise<void> {
  if (!asrSupported()) return
  const { nativeAsrStop } = await import('./nativeAsr')
  await nativeAsrStop()
}

/**
 * «Отменить»: результат выбрасывается, микрофон отпускается сразу. Тем же
 * вызовом завершается запись при уходе приложения в фон (задача 07, п. 7).
 */
export async function cancelDictation(): Promise<void> {
  session++
  if (!asrSupported()) return
  const { nativeAsrCancel } = await import('./nativeAsr')
  await nativeAsrCancel()
}
