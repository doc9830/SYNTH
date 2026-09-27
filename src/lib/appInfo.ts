/**
 * Единый источник правды о приложении: имя, версия, репозиторий, релизы.
 * Используется в UI (шапка, «О программе»), в PWA-манифесте и в проверке обновлений.
 */

/** Версия из package.json — подставляется Vite (см. vite.config.ts → define). */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'

export const APP_NAME = 'SYNTH'
export const APP_TAGLINE = 'Synthetic Neural & Tool Hub'

/** Репозиторий и релизы на GitHub. */
export const REPO_SLUG = 'doc9830/SYNTH'
export const REPO_URL = `https://github.com/${REPO_SLUG}`
export const RELEASES_URL = `${REPO_URL}/releases`
export const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`

/** Разбирает версию («v1.2.3», «1.2.3-beta.1») в массив чисел. */
export function parseVersion(raw: string): number[] {
  const clean = raw.trim().replace(/^v/i, '').split(/[-+]/)[0]
  return clean.split('.').map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isFinite(n) ? n : 0
  })
}

/** Сравнение версий: >0 — a новее b, 0 — равны, <0 — a старее b. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Есть ли смысл предлагать обновление: latest строго новее current. */
export function isNewerVersion(latest: string, current: string = APP_VERSION): boolean {
  return compareVersions(latest, current) > 0
}
