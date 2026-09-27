import { create } from 'zustand'
import { listModels } from '@/api'
import { getSettings, useSettings } from './settings'

/**
 * Каталог моделей подключения.
 *
 * Список тянется из GET /v1/models настроенного Base URL (или /api/models в proxy-режиме),
 * кэшируется в localStorage (settings.modelList / settings.image.modelList) и
 * переиспользуется всеми селекторами — модель больше не нужно вводить вручную.
 */

export type ModelKind = 'chat' | 'image'

/**
 * Эвристика «модель умеет рисовать»: провайдеры не отдают тип модели в /v1/models,
 * поэтому image-селектор по умолчанию фильтрует список по названию
 * (с возможностью показать все модели целиком).
 */
const IMAGE_MODEL_RE =
  /(gpt-image|dall-?e|imagen|image[-_]?(gen|preview|\d)|flux|stable-diffusion|sdxl|sd3|ideogram|recraft|midjourney|seedream|kolors|qwen-image|nano-banana|photon|kandinsky|grok[-_ ]?\d*(\.\d+)?[-_ ]?image|gemini[-_.\d]*[-_. ]image|doubao[-_ ]?image)/i

export function looksLikeImageModel(id: string): boolean {
  return IMAGE_MODEL_RE.test(id)
}

export interface ModelBucket {
  /** Свежий список из API (пусто → показываем кэш из настроек) */
  ids: string[]
  loading: boolean
  error: string | null
  /** Когда список успешно обновился (мс), null — ещё не тянули в этой сессии */
  loadedAt: number | null
}

const emptyBucket = (): ModelBucket => ({ ids: [], loading: false, error: null, loadedAt: null })

/** Список моделей считаем свежим 10 минут — чаще провайдера дёргать незачем. */
const TTL = 10 * 60 * 1000

/** Понятное сообщение вместо «Invalid token» из API. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/invalid token|401|unauthoriz/i.test(message)) {
    return `${message} — проверьте API key: он мог истечь или скопирован не полностью.`
  }
  if (/failed to fetch|networkerror|load failed|нет соединения/i.test(message)) {
    return `Список моделей недоступен: ${message}. Проверьте интернет и Base URL.`
  }
  return message
}

interface CatalogState {
  chat: ModelBucket
  image: ModelBucket
  /** Обновить список моделей (force — минуя TTL). */
  refresh: (kind: ModelKind, opts?: { force?: boolean }) => Promise<string[]>
  /** Обновить, если кэш пуст или устарел: вызывается при открытии селектора. */
  ensure: (kind: ModelKind) => void
}

/** Параллельные запросы к /v1/models схлопываем: один на вид моделей. */
const inflight = new Map<ModelKind, Promise<string[]>>()

function commit(kind: ModelKind, ids: string[]): void {
  const store = useSettings.getState()
  if (kind === 'chat') store.update({ modelList: ids })
  else store.updateSection('image', { modelList: ids })
}

async function runRefresh(kind: ModelKind, force: boolean): Promise<string[]> {
  const state = useModelCatalog.getState()[kind]
  if (!force && state.ids.length && state.loadedAt && Date.now() - state.loadedAt < TTL) {
    return state.ids
  }
  const running = inflight.get(kind)
  if (running) return running

  useModelCatalog.setState((s) => ({ [kind]: { ...s[kind], loading: true, error: null } }) as Partial<CatalogState>)

  const task = (async (): Promise<string[]> => {
    try {
      const ids = await listModels(getSettings())
      commit(kind, ids)
      useModelCatalog.setState({
        [kind]: { ids, loading: false, error: null, loadedAt: Date.now() },
      } as Partial<CatalogState>)
      return ids
    } catch (err) {
      useModelCatalog.setState(
        (s) => ({ [kind]: { ...s[kind], loading: false, error: describeError(err) } }) as Partial<CatalogState>,
      )
      throw err
    } finally {
      inflight.delete(kind)
    }
  })()

  inflight.set(kind, task)
  return task
}

export const useModelCatalog = create<CatalogState>()((_set, get) => ({
  chat: emptyBucket(),
  image: emptyBucket(),

  refresh: (kind, opts) => runRefresh(kind, Boolean(opts?.force)),

  ensure: (kind) => {
    const bucket = get()[kind]
    if (bucket.loading) return
    if (bucket.ids.length && bucket.loadedAt && Date.now() - bucket.loadedAt < TTL) return
    void runRefresh(kind, bucket.ids.length === 0).catch(() => undefined)
  },
}))

/** Список моделей для не-React кода (диагностика, подсказки). */
export function cachedModelIds(kind: ModelKind): string[] {
  const bucket = useModelCatalog.getState()[kind]
  if (bucket.ids.length) return bucket.ids
  const settings = getSettings()
  return kind === 'chat' ? settings.modelList : settings.image.modelList
}
