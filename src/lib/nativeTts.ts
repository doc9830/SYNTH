import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { isNativeApp } from './nativeShell'

/**
 * Мост к локальному Android-плагину SynthSpeech — часть синтеза речи
 * (android/app/src/main/java/app/synth/hub/SpeechPlugin.java).
 *
 * Плагин работает поверх системного `android.speech.tts.TextToSpeech`:
 * никаких сторонних моделей и сети, разрешения не нужны. Озвучка идёт
 * фрагментами: плагин складывает их в очередь движка и сообщает о начале
 * каждого событиями `progress`.
 *
 * Распознавание речи (тот же плагин, задача 07) — в src/lib/nativeAsr.ts:
 * имя плагина SynthSpeech стало общим, потому что он отвечает за оба движка.
 */

/** Причины недоступности — те же коды, что отдаёт плагин. */
export type NativeTtsReason = 'ENGINE_UNAVAILABLE' | 'ENGINE_TIMEOUT' | 'NO_RU_VOICE'

export interface NativeTtsInfo {
  available: boolean
  reason?: NativeTtsReason
  engine?: string
  voice?: string
  language?: string
  needsNetwork?: boolean
}

/** Одно событие прогресса: начало фрагмента, конец, ошибка или остановка. */
export interface NativeTtsProgress {
  index: number
  count: number
  state: 'start' | 'done' | 'error' | 'stopped'
  message?: string
  reason?: string
}

interface SynthTtsPlugin {
  available(): Promise<NativeTtsInfo>
  speak(options: { chunks: string[]; rate?: number; pitch?: number }): Promise<{ count: number }>
  stop(): Promise<{ stopped: boolean }>
  shutdown(): Promise<void>
  addListener(
    eventName: 'progress',
    listenerFunc: (data: NativeTtsProgress) => void,
  ): Promise<PluginListenerHandle>
}

let instance: SynthTtsPlugin | null = null

/** Текущий подписчик на события прогресса (одна сессия озвучки за раз). */
let progressHandler: ((data: NativeTtsProgress) => void) | null = null
let progressHandle: Promise<PluginListenerHandle> | null = null

function tts(): SynthTtsPlugin {
  instance ??= registerPlugin<SynthTtsPlugin>('SynthTts')
  return instance
}

/** Плагин есть только в Android-сборке. */
export function nativeTtsAvailable(): boolean {
  return isNativeApp() && Capacitor.getPlatform() === 'android'
}

/** Проверка движка, русского голоса и того, нужна ли голосу сеть. */
export async function nativeTtsInfo(): Promise<NativeTtsInfo> {
  if (!nativeTtsAvailable()) return { available: false, reason: 'ENGINE_UNAVAILABLE' }
  try {
    const info = await tts().available()
    return { ...info, available: Boolean(info?.available) }
  } catch {
    return { available: false, reason: 'ENGINE_UNAVAILABLE' }
  }
}

/**
 * Фрагменты ставим в очередь движка. Слушатель событий живёт от первого
 * `speak()` до `stop()`/`shutdown()`: подписка на каждый фрагмент не нужна,
 * события приходят на всю очередь сразу.
 */
export async function nativeTtsSpeak(
  chunks: string[],
  onProgress: (data: NativeTtsProgress) => void,
  options?: { rate?: number; pitch?: number },
): Promise<number> {
  const plugin = tts()
  progressHandler = onProgress
  if (!progressHandle) {
    progressHandle = plugin.addListener('progress', (data) => progressHandler?.(data))
  }
  await progressHandle
  try {
    const { count } = await plugin.speak({ chunks, rate: options?.rate, pitch: options?.pitch })
    return count
  } catch (error) {
    // Движок отказался читать (нет движка/голоса) — подписка больше не нужна.
    await detachListener()
    throw error
  }
}

/** Отписка от событий: вызывается в конце сессии озвучки. */
async function detachListener(): Promise<void> {
  progressHandler = null
  const handle = await progressHandle?.catch(() => null)
  progressHandle = null
  await handle?.remove()
}

/** Мгновенная остановка: `stop()` движка очищает очередь целиком. */
export async function nativeTtsStop(): Promise<void> {
  if (!nativeTtsAvailable()) return
  try {
    await tts().stop()
  } catch {
    // no-op: озвучки и так нет
  }
  await detachListener()
}

/** Освобождает движок (`shutdown()`): вызывается при уходе с экрана. */
export async function nativeTtsShutdown(): Promise<void> {
  if (!nativeTtsAvailable()) return
  try {
    await tts().shutdown()
  } catch {
    // no-op
  }
  await detachListener()
}
