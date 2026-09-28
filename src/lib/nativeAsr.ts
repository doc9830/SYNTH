import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { isNativeApp } from './nativeShell'

/**
 * Мост к локальному Android-плагину SynthSpeech — распознавание речи
 * (android/app/src/main/java/app/synth/hub/SpeechPlugin.java).
 *
 * Работает поверх системного `android.speech.SpeechRecognizer`: на API 31+ это
 * офлайн-сервис устройства (`createOnDeviceSpeechRecognizer()`), на более старых
 * — системный сервис с предпочтением офлайна. Никаких сторонних моделей и
 * облачных STT: аудио обрабатывает сервис Android, приложение его не хранит.
 *
 * Синтез речи живёт в том же плагине — см. src/lib/nativeTts.ts.
 */

/** Состояние разрешения на микрофон (как его отдаёт Capacitor). */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale'

export interface NativeAsrInfo {
  available: boolean
  /**
   * Причина, если распознавания нет: `NO_SERVICE` — сервиса на устройстве нет,
   * `ONDEVICE_SILENT` — офлайн-движок объявлен, но не отвечает,
   * `PLUGIN_ERROR` — плагин не ответил. Токен отдаём как есть: по нему
   * интерфейс говорит, чего именно не хватает.
   */
  reason?: string
  /** true — распознаёт офлайн-сервис устройства (API 31+). */
  onDevice?: boolean
  /** Диагностика: офлайн-движок объявлен прошивкой устройства. */
  deviceModel?: boolean
  /** Диагностика: сервис распознавания виден через PackageManager. */
  systemService?: boolean
  language?: string
  permission?: MicPermission
}

/** Одно событие сессии распознавания. */
export interface NativeAsrEvent {
  state: 'ready' | 'speech' | 'partial' | 'silence' | 'final' | 'error' | 'cancelled'
  text?: string
  /** Код ошибки системного сервиса: NO_MATCH, SILENCE, NETWORK, BUSY… */
  code?: string
  reason?: string
  onDevice?: boolean
}

export interface NativeAsrStart {
  onDevice: boolean
  language: string
}

interface SynthSpeechAsr {
  asrAvailable(): Promise<NativeAsrInfo>
  requestMic(): Promise<{ granted: boolean; permission: MicPermission }>
  startRecognize(options?: { lang?: string; silenceMs?: number }): Promise<NativeAsrStart>
  stopRecognize(): Promise<{ stopped: boolean }>
  cancelRecognize(): Promise<{ cancelled: boolean }>
  addListener(
    eventName: 'recognize',
    listenerFunc: (data: NativeAsrEvent) => void,
  ): Promise<PluginListenerHandle>
}

let instance: SynthSpeechAsr | null = null

/** Текущий подписчик на события записи (одна сессия распознавания за раз). */
let eventHandler: ((data: NativeAsrEvent) => void) | null = null
let eventHandle: Promise<PluginListenerHandle> | null = null

function asr(): SynthSpeechAsr {
  instance ??= registerPlugin<SynthSpeechAsr>('SynthSpeech')
  return instance
}

/** Плагин есть только в Android-сборке. */
export function nativeAsrAvailable(): boolean {
  return isNativeApp() && Capacitor.getPlatform() === 'android'
}

/** Есть ли сервис распознавания, офлайн-движок и разрешение на микрофон. */
export async function nativeAsrInfo(): Promise<NativeAsrInfo> {
  if (!nativeAsrAvailable()) return { available: false, reason: 'NO_SERVICE' }
  try {
    const info = await asr().asrAvailable()
    return { ...info, available: Boolean(info?.available) }
  } catch {
    // Мост или плагин не ответил: это не «сервиса нет», а «проверить не удалось».
    return { available: false, reason: 'PLUGIN_ERROR' }
  }
}

/** Запрос разрешения RECORD_AUDIO (системный диалог, первое использование). */
export async function nativeMicPermission(): Promise<MicPermission> {
  if (!nativeAsrAvailable()) return 'denied'
  try {
    const result = await asr().requestMic()
    if (result?.permission) return result.permission
    return result?.granted ? 'granted' : 'denied'
  } catch {
    return 'denied'
  }
}

/**
 * Старт записи. Слушатель событий живёт от старта до `stop`/`cancel`:
 * частичные результаты приходят в него же.
 */
export async function nativeAsrStart(
  onEvent: (data: NativeAsrEvent) => void,
  options?: { lang?: string; silenceMs?: number },
): Promise<NativeAsrStart> {
  const plugin = asr()
  eventHandler = onEvent
  if (!eventHandle) eventHandle = plugin.addListener('recognize', (data) => eventHandler?.(data))
  await eventHandle
  try {
    return await plugin.startRecognize(options)
  } catch (error) {
    // Сервис отказался: подписка больше не нужна.
    await detachListener()
    throw error
  }
}

/** «Закончить»: сервис отдаёт итоговый текст и сам выключает микрофон. */
export async function nativeAsrStop(): Promise<void> {
  if (!nativeAsrAvailable()) return
  try {
    await asr().stopRecognize()
  } catch {
    // no-op: записи и так нет
  }
}

/** «Отменить» / уход в фон: результат выбрасывается, микрофон отпускается. */
export async function nativeAsrCancel(): Promise<void> {
  if (!nativeAsrAvailable()) return
  try {
    await asr().cancelRecognize()
  } catch {
    // no-op
  }
  await detachListener()
}

/** Отписка от событий: вызывается в конце сессии распознавания. */
async function detachListener(): Promise<void> {
  eventHandler = null
  const handle = await eventHandle?.catch(() => null)
  eventHandle = null
  await handle?.remove()
}
