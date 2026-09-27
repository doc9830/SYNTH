import { create } from 'zustand'
import { debugLog } from './debug'
import { notify } from './toast'
import {
  describeTtsNetwork,
  describeTtsUnavailable,
  probeTts,
  releaseTts,
  speakChunks,
  stopSpeech,
  ttsSupported,
  type TtsEvent,
  type TtsInfo,
} from './tts'
import { speechChunks } from './ttsText'

/**
 * Состояние озвучки ответов (задача 06).
 *
 * Один плеер на всё приложение: читается всегда не больше одного сообщения.
 * Новое нажатие «Озвучить» останавливает текущее чтение — в том числе если
 * оно идёт в другом сообщении.
 *
 * Кнопка показывается только когда движок реально доступен: `probeTts()`
 * проверяет наличие TTS, русского голоса и сетевой характер голоса.
 */

export type SpeechStatus = 'idle' | 'starting' | 'speaking'

interface SpeechState {
  /** Результат проверки движка и голоса. null — ещё не проверяли. */
  info: TtsInfo | null
  status: SpeechStatus
  /** Сообщение, которое читается (или готовится) сейчас. */
  messageId: string | null
  chunkIndex: number
  chunkCount: number
  /** Нормализованный текст текущего фрагмента — по нему идёт подсветка. */
  chunkKey: string | null
  /** `force` — проверить движок заново (например, после установки голоса). */
  ensureProbe: (force?: boolean) => Promise<void>
  toggle: (messageId: string, markdown: string) => Promise<void>
  stop: () => Promise<void>
  release: () => Promise<void>
}

/** Движок доступен → кнопка озвучки есть. */
export function canSpeak(info: TtsInfo | null): boolean {
  return Boolean(info?.available)
}

const IDLE = {
  status: 'idle' as SpeechStatus,
  messageId: null,
  chunkIndex: 0,
  chunkCount: 0,
  chunkKey: null,
}

/** Проверяем и предупреждаем один раз за запуск приложения (force — ещё раз). */
let probeRun: Promise<void> | null = null
let warnedUnavailable = false
let warnedNetwork = false

const UNSUPPORTED: TtsInfo = { available: false, reason: 'unsupported' }

/** Пауза: нужна, чтобы не задерживать ответ пользователю бесконечным ожиданием. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Проверка движка и голоса. Результат кладём в стор, причину — в Debug Console:
 * по этой записи видно, почему озвучка недоступна именно на этом устройстве.
 */
async function runProbe(set: (patch: Partial<SpeechState>) => void): Promise<void> {
  if (!ttsSupported()) {
    set({ info: { available: false, reason: 'unsupported' } })
    return
  }
  let info: TtsInfo
  try {
    info = await probeTts()
  } catch {
    info = { available: false, reason: 'speech-error' }
  }
  set({ info })
  debugLog('info', 'Озвучка: проверка системного синтеза речи', [info])

  const unavailable = describeTtsUnavailable(info)
  if (unavailable && !warnedUnavailable) {
    warnedUnavailable = true
    notify(unavailable, 'info')
  }
  const network = describeTtsNetwork(info)
  if (network && !warnedNetwork) {
    warnedNetwork = true
    notify(network, 'info')
  }
}

export const useSpeech = create<SpeechState>((set, get) => ({
  info: null,
  ...IDLE,

  ensureProbe: (force = false) => {
    if (force) probeRun = null
    probeRun ??= runProbe((patch) => set(patch))
    return probeRun
  },

  toggle: async (messageId, markdown) => {
    // Повторное нажатие по читаемому сообщению — это «стоп».
    if (get().messageId === messageId && get().status !== 'idle') {
      await get().stop()
      return
    }
    await get().stop()

    // Движок проверяем до чтения: нажатие на приглушённую кнопку должно
    // объяснить, чего не хватает, а не молчать.
    if (!get().info) await get().ensureProbe()
    if (!canSpeak(get().info)) {
      // Голос мог появиться только что — пользователь сходил в настройки Android
      // и поставил голосовые данные. Даём движку последний шанс: проверка, если
      // голос есть, отвечает мгновенно, поэтому чтение начнётся с этого же
      // нажатия. Если голоса нет, через 400 мс показываем причину.
      await Promise.race([get().ensureProbe(true), delay(400)])
      if (!canSpeak(get().info)) {
        notify(
          describeTtsUnavailable(get().info ?? UNSUPPORTED) ??
            'Озвучка на этом устройстве недоступна.',
          'info',
        )
        return
      }
    }

    const chunks = speechChunks(markdown)
    if (!chunks.length) {
      notify('В этом ответе нет текста для озвучки — только код или картинки.', 'info')
      return
    }

    set({ status: 'starting', messageId, chunkIndex: 0, chunkCount: chunks.length, chunkKey: null })

    /** События чужой сессии (после «стоп» или нового нажатия) игнорируем. */
    const onEvent = (event: TtsEvent) => {
      if (useSpeech.getState().messageId !== messageId) return
      if (event.kind === 'chunk') {
        set({
          status: 'speaking',
          chunkIndex: event.index,
          chunkKey: chunks[event.index]?.key ?? null,
        })
        return
      }
      if (event.kind === 'error') {
        notify(event.message, 'error')
        void get().stop()
        return
      }
      set(IDLE)
    }

    try {
      await speakChunks(
        chunks.map((chunk) => chunk.text),
        onEvent,
      )
    } catch {
      notify('Не удалось запустить озвучку.', 'error')
      set(IDLE)
    }
  },

  stop: async () => {
    set(IDLE)
    await stopSpeech()
  },

  release: async () => {
    set(IDLE)
    await releaseTts()
  },
}))
