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

export type AsrUnavailableReason =
  | 'unsupported' // не Android-приложение: системного распознавания нет
  | 'no-service' // сервис распознавания на устройстве отсутствует

export interface AsrInfo {
  available: boolean
  reason?: AsrUnavailableReason
  /** true — распознаёт офлайн-сервис устройства (API 31+), false — системный. */
  onDevice?: boolean
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
  | { kind: 'error'; message: string }
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

/** Проверка сервиса распознавания, офлайн-пакета и разрешения на микрофон. */
export async function probeAsr(): Promise<AsrInfo> {
  if (!asrSupported()) return { available: false, reason: 'unsupported' }
  const { nativeAsrInfo } = await import('./nativeAsr')
  try {
    const info = await nativeAsrInfo()
    return {
      available: info.available,
      reason: info.available ? undefined : 'no-service',
      onDevice: info.onDevice,
      language: info.language,
      permission: info.permission,
    }
  } catch {
    return { available: false, reason: 'no-service' }
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
      return { kind: 'error', message: asrErrorMessage(data.code) }
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
    case 'BUSY':
      return 'Распознавание занято: попробуйте ещё раз через пару секунд.'
    case 'AUDIO':
      return 'Микрофон недоступен — его заняло другое приложение.'
    case 'SERVER':
      return 'Сервис распознавания вернул ошибку.'
    case 'NO_START':
      return 'Не удалось начать запись: сервис распознавания не ответил.'
    case 'NO_RESULT':
      return 'Сервис распознавания не отдал результат.'
    default:
      return 'Не удалось распознать речь.'
  }
}

/** Причина недоступности распознавания — или null, если оно работает. */
export function describeAsrUnavailable(info: AsrInfo | null): string | null {
  if (info?.available) return null
  if (info?.reason === 'unsupported') {
    return 'Голосовой ввод работает в Android-приложении SYNTH — здесь можно печатать текстом.'
  }
  return 'Распознавание речи недоступно на этом устройстве — можно печатать текстом.'
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
