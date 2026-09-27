import { create } from 'zustand'
import {
  asrFailureCode,
  asrSupported,
  cancelDictation,
  describeAsrUnavailable,
  describeDictationNetwork,
  describeDictationSource,
  describeMicDenied,
  describeStartFailure,
  probeAsr,
  requestMicAccess,
  startDictation,
  stopDictation,
  type AsrEvent,
  type AsrInfo,
} from './asr'
import { debugLog } from './debug'
import { notify } from './toast'

/**
 * Состояние голосового ввода (задача 07).
 *
 * Одна сессия записи на приложение: пока идёт запись, второе нажатие её
 * заканчивает, а уход в фон — обрывает (см. `release()` и `src/App.tsx`).
 *
 * Распознанный текст только вставляется в поле ввода: автоотправки нет,
 * сообщение уходит отдельным действием пользователя. Частичные результаты
 * приходят по мере речи и сразу попадают в поле (`partial`), поэтому текст
 * видно, пока человек говорит.
 */

export type DictationStatus = 'idle' | 'starting' | 'listening'

/** Состояние одной сессии записи — меняется только событиями ASR. */
export interface DictationDraft {
  /** Текст поля ввода до начала записи: распознанное добавляется к нему. */
  base: string
  /** Последний распознанный (частичный) текст: виден в поле по мере речи. */
  partial: string
  /** Итог завершённой сессии: его забирает поле ввода. null — забирать нечего. */
  result: { base: string; text: string } | null
  /** true — распознавал офлайн-сервис устройства (для диагностики). */
  onDevice: boolean
}

/**
 * Чистое применение события ASR к сессии: так состояние записи проверяется
 * без нативного слоя и без интерфейса.
 */
export function reduceDictation(draft: DictationDraft, event: AsrEvent): DictationDraft {
  switch (event.kind) {
    case 'partial':
      return { ...draft, partial: event.text }
    case 'final': {
      // Итог сервиса бывает пустым даже после частичных результатов — тогда
      // оставляем то, что успело распознаться.
      const text = (event.text ?? draft.partial).trim()
      return {
        ...draft,
        partial: '',
        onDevice: event.onDevice,
        result: text ? { base: draft.base, text } : null,
      }
    }
    case 'error':
    case 'cancelled':
      // При уходе в фон терять уже распознанное незачем — оставляем его в поле.
      if (event.kind === 'cancelled' && event.reason === 'lifecycle' && draft.partial.trim()) {
        return {
          ...draft,
          partial: '',
          result: { base: draft.base, text: draft.partial.trim() },
        }
      }
      // Отмена и ошибка результата не оставляют: частичный текст выбрасываем.
      return { ...draft, partial: '', result: null }
    default:
      // ready / speech / silence — это только индикация, текст не меняется.
      return draft
  }
}

/** Как надиктованное приклеивается к тому, что уже было в поле ввода. */
export function composeDictation(base: string, partial: string): string {
  const spoken = partial.trim()
  if (!spoken) return base
  if (!base) return spoken
  return /[\s\n]$/.test(base) ? `${base}${spoken}` : `${base} ${spoken}`
}

/** Что сейчас должно показывать поле ввода (null — поле живёт своей жизнью). */
export function dictationValue(
  state: Pick<DictationState, 'status' | 'base' | 'partial' | 'result'>,
): string | null {
  if (state.status !== 'idle') return composeDictation(state.base, state.partial)
  return state.result ? composeDictation(state.result.base, state.result.text) : null
}

export interface DictationState extends DictationDraft {
  /** Результат проверки сервиса распознавания. null — ещё не проверяли. */
  info: AsrInfo | null
  status: DictationStatus
  /** `force` — проверить заново (например, после установки офлайн-пакета). */
  ensureProbe: (force?: boolean) => Promise<void>
  /** Начать запись: распознанное дописывается к `base` прямо в поле ввода. */
  start: (base: string) => Promise<void>
  /** Закончить запись: сервис отдаст итоговый текст событием `final`. */
  stop: () => Promise<void>
  /** Отменить запись: микрофон отпускается сразу, результат выбрасывается. */
  cancel: () => Promise<void>
  /** Уход приложения в фон: запись прерывается, микрофон освобождается. */
  release: () => Promise<void>
  /** Поле ввода забрало распознанный текст — сессия закрыта. */
  acknowledge: () => void
}

const IDLE = {
  status: 'idle' as DictationStatus,
  base: '',
  partial: '',
  result: null,
  onDevice: false,
}

/** Проверяем и предупреждаем один раз за запуск приложения (force — ещё раз). */
let probeRun: Promise<void> | null = null
let warnedUnavailable = false
let warnedNetwork = false

const UNSUPPORTED: AsrInfo = { available: false, reason: 'unsupported' }

/**
 * Проверка системы распознавания. Результат кладём в стор, причину — в Debug
 * Console: по этой записи видно, почему голосовой ввод недоступен именно на
 * этом устройстве (нет сервиса распознавания — частая история на де-Гугленных
 * прошивках).
 */
async function runProbe(set: (patch: Partial<DictationState>) => void): Promise<void> {
  if (!asrSupported()) {
    set({ info: { available: false, reason: 'unsupported' } })
    return
  }
  let info: AsrInfo
  try {
    info = await probeAsr()
  } catch {
    info = { available: false, reason: 'no-service' }
  }
  set({ info })
  debugLog('info', 'Голосовой ввод: проверка системы распознавания', [info])

  const unavailable = describeAsrUnavailable(info)
  if (unavailable && !warnedUnavailable) {
    warnedUnavailable = true
    notify(unavailable, 'info')
  }
}

/** Сервис распознавания есть → кнопка микрофона есть. */
export function canDictate(info: AsrInfo | null): boolean {
  return Boolean(info?.available)
}

/** Запись закончилась: распознаватель разрушаем и отписываемся от событий. */
async function finishSession(): Promise<void> {
  await cancelDictation()
}

export const useDictation = create<DictationState>((set, get) => {
  /**
   * События одной сессии. Сессия кончается событиями `final`/`error`/
   * `cancelled` — они и возвращают кнопку в покой; запоздалые события после
   * этого игнорируем (стор уже в `idle`).
   */
  const applyEvent = (event: AsrEvent): void => {
    const state = get()
    if (state.status === 'idle') return
    const draft = reduceDictation(state, event)

    if (event.kind === 'final') {
      // Итог кладём в `result`: поле ввода заберёт его и очистит сессию.
      if (!draft.result) notify('Речь не распознана — попробуйте ещё раз.', 'info')
      set({ ...draft, status: 'idle' })
      void finishSession()
      return
    }
    if (event.kind === 'error') {
      // Код сервиса пишем в Debug Console: по нему видно, что ответило устройство.
      debugLog('error', 'Голосовой ввод: сервис распознавания вернул ошибку', [
        event.code ?? event.message,
        event.message,
      ])
      notify(event.message, 'error')
      set({ ...draft, status: 'idle' })
      void finishSession()
      return
    }
    if (event.kind === 'cancelled') {
      // Уход в фон обрывает запись без участия пользователя — объясняем это.
      if (event.reason === 'lifecycle') notify('Запись прервана: приложение ушло в фон.', 'info')
      set({ ...draft, status: 'idle' })
      void finishSession()
      return
    }
    // Сервис отозвался — значит, микрофон уже слушает.
    if (event.kind === 'ready') set({ ...draft, status: 'listening' })
    else set(draft)
  }

  return {
    info: null,
    ...IDLE,

    ensureProbe: (force = false) => {
      if (force) probeRun = null
      probeRun ??= runProbe((patch) => set(patch))
      return probeRun
    },

    start: async (base) => {
      if (get().status !== 'idle') return

      if (!get().info) await get().ensureProbe()
      const info = get().info
      if (!canDictate(info)) {
        notify(
          describeAsrUnavailable(info ?? UNSUPPORTED) ??
            'Распознавание речи недоступно на этом устройстве.',
          'info',
        )
        return
      }

      // Разрешение спрашиваем при первом использовании записи: пока человек не
      // нажал микрофон, диалог с требованием доступа не нужен.
      if (info?.permission !== 'granted') {
        const permission = await requestMicAccess()
        set({ info: { ...(info ?? UNSUPPORTED), permission } })
        if (permission !== 'granted') {
          notify(describeMicDenied(), 'info')
          return
        }
      }

      set({ status: 'starting', base, partial: '', result: null, onDevice: false })
      try {
        const started = await startDictation(applyEvent)
        // Пока поднимался сервис, сессию могли отменить (уход в фон).
        if (get().status === 'idle') return
        set({ status: 'listening', onDevice: started.onDevice })
        debugLog('info', 'Голосовой ввод: запись началась', [
          describeDictationSource(started.onDevice),
        ])
        if (!started.onDevice && !warnedNetwork) {
          warnedNetwork = true
          notify(describeDictationNetwork(), 'info')
        }
      } catch (error) {
        // Причину отказа не прячем: у старта она бывает разной (нет разрешения,
        // нет сервиса, молчит плагин), и в Debug Console должно быть видно какая.
        const reason = describeStartFailure(error)
        debugLog('error', 'Голосовой ввод: запись не началась', [reason, asrFailureCode(error)])
        set(IDLE)
        notify(reason, 'error')
      }
    },

    stop: async () => {
      // Кнопка вернётся в покой по событию `final` — ждём ответ сервиса.
      if (get().status === 'idle') return
      await stopDictation()
    },

    cancel: async () => {
      // Результат не ждём: состояние чистим сразу, микрофон отпускает плагин.
      if (get().status !== 'idle') set(IDLE)
      await cancelDictation()
    },

    release: async () => {
      await get().cancel()
    },

    acknowledge: () => {
      if (get().result) set({ result: null, base: '' })
    },
  }
})
