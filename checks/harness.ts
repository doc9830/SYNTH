/**
 * Мини-харнесс для смоук-проверок (`npm run checks`).
 *
 * Тестового фреймворка в проекте нет: проверки — обычные скрипты на tsx,
 * которые печатают результат и возвращают ненулевой код при провале.
 */
let failed = 0
let total = 0

/** Отмечает проверку как пройденную или упавшую. */
export function check(label: string, ok: boolean): void {
  total++
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
}

/** Печатает итог и завершает процесс кодом 1, если что-то упало. */
export function finish(): void {
  console.log(failed ? `FAILED: ${failed} из ${total}` : `ALL PASSED (${total})`)
  if (failed) process.exit(1)
}
