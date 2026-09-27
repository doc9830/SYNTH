import { APP_VERSION, LATEST_RELEASE_API, isNewerVersion } from './appInfo'

/**
 * Проверка обновлений через GitHub Releases публичного репозитория.
 *
 * GitHub API отдаёт CORS-заголовки, поэтому запрос работает и из браузера,
 * и из WebView. Автопроверка троттлится (см. shouldAutoCheck), чтобы не
 * дёргать API при каждом открытии приложения.
 */

export interface UpdateAsset {
  name: string
  url: string
  size: number
  contentType?: string
}

export interface UpdateInfo {
  /** Версия без префикса «v»: 1.2.0 */
  version: string
  /** Заголовок релиза */
  title: string
  /** Описание изменений (markdown из релиза) */
  notes: string
  publishedAt: string
  /** Страница релиза на GitHub */
  pageUrl: string
  /** APK-ассет релиза, если он приложен */
  apk?: UpdateAsset
}

const CHECKED_AT_KEY = 'synth.update.checkedAt'
const SKIPPED_KEY = 'synth.update.skippedVersion'

/** Автопроверка не чаще раза в 6 часов. */
const CHECK_INTERVAL = 6 * 60 * 60 * 1000

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, value)
  } catch {
    // приватный режим — просто не сохраняем
  }
}

/** Версия, которую пользователь попросил больше не предлагать. */
export function skippedVersion(): string | null {
  return readStorage(SKIPPED_KEY)
}

export function skipVersion(version: string): void {
  writeStorage(SKIPPED_KEY, version)
}

export function clearSkippedVersion(): void {
  writeStorage(SKIPPED_KEY, null)
}

export function markChecked(): void {
  writeStorage(CHECKED_AT_KEY, String(Date.now()))
}

/** Пора ли проверять обновление автоматически (при запуске приложения). */
export function shouldAutoCheck(): boolean {
  const raw = readStorage(CHECKED_AT_KEY)
  if (!raw) return true
  const last = Number.parseInt(raw, 10)
  if (!Number.isFinite(last)) return true
  return Date.now() - last > CHECK_INTERVAL
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{
    name?: string
    browser_download_url?: string
    size?: number
    content_type?: string
  }>
}

/** Последний релиз, если он новее установленной версии; иначе null. */
export async function fetchLatestUpdate(signal?: AbortSignal): Promise<UpdateInfo | null> {
  const res = await fetch(LATEST_RELEASE_API, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`GitHub вернул HTTP ${res.status} при проверке обновлений.`)
  }

  const release = (await res.json()) as GithubRelease
  if (release.draft) return null
  const tag = String(release.tag_name ?? release.name ?? '').trim()
  const version = tag.replace(/^v/i, '')
  if (!version || !isNewerVersion(version, APP_VERSION)) return null

  const apkAsset = (release.assets ?? []).find((a) => /\.apk$/i.test(a.name ?? ''))
  return {
    version,
    title: release.name?.trim() || `SYNTH ${version}`,
    notes: (release.body ?? '').trim(),
    publishedAt: release.published_at ?? '',
    pageUrl: release.html_url ?? LATEST_RELEASE_API,
    apk:
      apkAsset?.browser_download_url && apkAsset.name
        ? {
            name: apkAsset.name,
            url: apkAsset.browser_download_url,
            size: apkAsset.size ?? 0,
            contentType: apkAsset.content_type,
          }
        : undefined,
  }
}
