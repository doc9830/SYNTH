import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ReadinessIssue } from './readiness'

/**
 * Отключаемые подсказки в верхней части экрана.
 *
 * Предупреждение можно закрыть крестиком: оно не вернётся, пока текст
 * предупреждения не изменится (например, вы не поменяли настройки) —
 * поэтому «подпись» = список сообщений, а не флаг «скрыто навсегда».
 */

/** Подпись набора предупреждений: меняется вместе с их текстом. */
export function issuesSignature(issues: ReadinessIssue[]): string {
  return issues.map((i) => `${i.scope}:${i.message}`).join('|')
}

interface NoticesState {
  /** key подсказки → подпись, для которой пользователь её закрыл */
  dismissed: Record<string, string>
  dismiss: (key: string, signature: string) => void
}

export const useNotices = create<NoticesState>()(
  persist(
    (set) => ({
      dismissed: {},
      dismiss: (key, signature) =>
        set((s) => ({ dismissed: { ...s.dismissed, [key]: signature } })),
    }),
    { name: 'ds-chat.notices.v1' },
  ),
)

/** Скрыта ли подсказка `key` для текущего текста `signature`. */
export function isNoticeHidden(key: string, signature: string): boolean {
  if (!signature) return true
  return useNotices.getState().dismissed[key] === signature
}
