import { isNativeApp } from './nativeShell'

/**
 * Озвучка ответов системным синтезом речи (задача 06).
 *
 * Две платформы — один интерфейс:
 *  - Android (APK): локальный плагин `SynthSpeech` поверх
 *    `android.speech.tts.TextToSpeech` (офлайн, без разрешений, очередь
 *    фрагментов живёт внутри движка);
 *  - браузер/PWA: `window.speechSynthesis` с русским голосом, если он есть.
 *
 * Если ни того, ни другого нет — `probeTts()` вернёт `available: false`,
 * и кнопка озвучки просто не рисуется (см. src/lib/useSpeech.ts).
 */

export type TtsUnavailableReason =
  | 'unsupported' // нет ни плагина, ни speechSynthesis
  | 'no-engine' // системный движок TTS не установлен
  | 'no-ru-voice' // движок есть, русского голоса нет
  | 'init-timeout' // движок не ответил на инициализацию
  | 'speech-error'

export interface TtsInfo {
  available: boolean
  reason?: TtsUnavailableReason
  /** Имя системного движка (Android) — показываем в диагностике. */
  engine?: string
  voice?: string
  language?: string
  /** Голос синтезируется в сети: предупреждаем один раз, не блокируем. */
  needsNetwork?: boolean
}

/** События одной сессии озвучки. */
export type TtsEvent =
  | { kind: 'chunk'; index: number }
  | { kind: 'done' }
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; message: string }

/** Темп чтения: 1.0 — обычная скорость системного голоса. */
const SPEECH_RATE = 1
/** Сколько ждём появления голосов в браузере (Chrome отдаёт их асинхронно). */
const VOICES_TIMEOUT_MS = 1200

/** Номер текущей сессии: события прошлых сессий игнорируем. */
let session = 0

type UtteranceCtor = new (text: string) => SpeechSynthesisUtterance

/** Конструктор реплики: в браузере это глобал, но берём его там же, где синтез. */
function webUtterance(): UtteranceCtor | null {
  if (typeof window === 'undefined') return null
  const ctor = (window as Window & { SpeechSynthesisUtterance?: UtteranceCtor })
    .SpeechSynthesisUtterance
  return typeof ctor === 'function' ? ctor : null
}

function webSynth(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !webUtterance()) return null
  const synth = (window as Window & { speechSynthesis?: SpeechSynthesis }).speechSynthesis
  return synth ?? null
}

/** Поддерживается ли озвучка на этой платформе (синхронная проверка). */
export function ttsSupported(): boolean {
  return isNativeApp() || webSynth() !== null
}

function mapNativeReason(reason?: string): TtsUnavailableReason {
  if (reason === 'NO_RU_VOICE') return 'no-ru-voice'
  if (reason === 'ENGINE_TIMEOUT') return 'init-timeout'
  return 'no-engine'
}

/** Русский голос браузера (первый доступный) или null. */
async function pickWebVoice(): Promise<SpeechSynthesisVoice | null> {
  const synth = webSynth()
  if (!synth) return null
  const pick = () => synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('ru')) ?? null
  const found = pick()
  if (found) return found
  return await new Promise<SpeechSynthesisVoice | null>((resolve) => {
    let settled = false
    let timer = 0
    const finish = (voice: SpeechSynthesisVoice | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      synth.removeEventListener('voiceschanged', onChange)
      resolve(voice)
    }
    const onChange = () => {
      const voice = pick()
      if (voice) finish(voice)
    }
    timer = window.setTimeout(() => finish(pick()), VOICES_TIMEOUT_MS)
    synth.addEventListener('voiceschanged', onChange)
  })
}


/**
 * Проверка перед использованием: есть ли движок, есть ли русский голос,
 * не требует ли голос сети. Тяжёлых операций нет — можно звать при запуске.
 */
export async function probeTts(): Promise<TtsInfo> {
  if (isNativeApp()) {
    const { nativeTtsInfo } = await import('./nativeTts')
    const info = await nativeTtsInfo()
    if (!info.available) {
      return { available: false, reason: mapNativeReason(info.reason), engine: info.engine }
    }
    return {
      available: true,
      engine: info.engine,
      voice: info.voice,
      language: info.language,
      needsNetwork: Boolean(info.needsNetwork),
    }
  }

  if (!webSynth()) return { available: false, reason: 'unsupported' }
  const voice = await pickWebVoice()
  if (!voice) return { available: false, reason: 'no-ru-voice' }
  return { available: true, voice: voice.name, language: voice.lang, needsNetwork: false }
}

/** Текст для пользователя: почему озвучки нет (null — всё в порядке). */
export function describeTtsUnavailable(info: TtsInfo): string | null {
  if (info.available) return null
  switch (info.reason) {
    case 'no-ru-voice':
      return 'На устройстве нет русского голоса синтеза речи, поэтому озвучка недоступна. Голосовые данные ставятся в настройках Android: Система → Языки и ввод → Синтез речи.'
    case 'init-timeout':
      return 'Системный движок синтеза речи не ответил — озвучка недоступна.'
    case 'speech-error':
      return 'Синтез речи вернул ошибку — озвучка недоступна.'
    case 'unsupported':
      return 'Системный синтез речи здесь недоступен — озвучка выключена.'
    default:
      return 'На устройстве не найден движок синтеза речи (TTS) — озвучка недоступна.'
  }
}

/** Предупреждение о сетевом голосе (показываем один раз, не блокируем). */
export function describeTtsNetwork(info: TtsInfo): string | null {
  return info.available && info.needsNetwork
    ? 'Голос выбранного движка синтезируется через сеть: без интернета озвучка не заработает.'
    : null
}

/**
 * Читает фрагменты по очереди. Возвращает число принятых фрагментов;
 * ход озвучки приходит через `onEvent`. Прерывается `stopSpeech()`.
 */
export async function speakChunks(
  chunks: string[],
  onEvent: (event: TtsEvent) => void,
): Promise<number> {
  if (!chunks.length) return 0
  session++
  const mySession = session
  const alive = () => session === mySession

  if (isNativeApp()) {
    const { nativeTtsSpeak } = await import('./nativeTts')
    return await nativeTtsSpeak(
      chunks,
      (data) => {
        if (!alive()) return
        if (data.state === 'start') {
          onEvent({ kind: 'chunk', index: data.index })
          return
        }
        if (data.state === 'error') {
          onEvent({ kind: 'error', message: data.message ?? 'Движок TTS вернул ошибку.' })
          return
        }
        if (data.state === 'stopped') {
          onEvent({ kind: 'stopped', reason: data.reason })
          return
        }
        if (data.state === 'done' && data.index >= data.count - 1) onEvent({ kind: 'done' })
      },
      { rate: SPEECH_RATE },
    )
  }

  const synth = webSynth()
  const Utterance = webUtterance()
  if (!synth || !Utterance) {
    onEvent({ kind: 'error', message: 'Системный синтез речи недоступен.' })
    return 0
  }
  const voice = await pickWebVoice()
  synth.cancel()

  let index = 0
  for (const text of chunks) {
    if (!alive()) break
    const utterance = new Utterance(text)
    utterance.lang = voice?.lang ?? 'ru-RU'
    if (voice) utterance.voice = voice
    utterance.rate = SPEECH_RATE
    await new Promise<void>((resolve) => {
      utterance.onend = () => resolve()
      utterance.onerror = (event) => {
        // «canceled»/«interrupted» — это наша собственная остановка, не ошибка
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
          onEvent({ kind: 'error', message: `Не удалось озвучить фрагмент (${event.error}).` })
        }
        resolve()
      }
      onEvent({ kind: 'chunk', index })
      synth.speak(utterance)
    })
    index++
  }
  if (alive()) onEvent({ kind: 'done' })
  return chunks.length
}

/** Останавливает озвучку: текущий фрагмент обрывается сразу. */
export async function stopSpeech(): Promise<void> {
  session++
  if (isNativeApp()) {
    const { nativeTtsStop } = await import('./nativeTts')
    await nativeTtsStop()
    return
  }
  webSynth()?.cancel()
}

/** Останавливает озвучку и освобождает движок (`shutdown()`). */
export async function releaseTts(): Promise<void> {
  session++
  if (isNativeApp()) {
    const { nativeTtsShutdown } = await import('./nativeTts')
    await nativeTtsShutdown()
    return
  }
  webSynth()?.cancel()
}
