import { create } from 'zustand'
import { redactDeep } from './redact'

export type DebugKind = 'request' | 'response' | 'error' | 'tool' | 'info'

export interface DebugEntry {
  id: string
  at: number
  kind: DebugKind
  title: string
  lines: string[]
}

const MAX_ENTRIES = 40

/**
 * Убирает секреты из любых данных, попадающих в Debug Console.
 *
 * Раньше здесь вырезались только `sk-…`-строки и значения по именам полей,
 * поэтому ключ в URL (`?api_key=…`), в заголовке (`Authorization: Bearer …`)
 * или внутри тела ответа провайдера доходил до экрана отладки целиком.
 * Теперь используется общий `redactDeep` из `src/lib/redact.ts`: он знает
 * про формы ключей (sk-, sk-ant-, AIza…, Bearer…), про пары `key=value`
 * и про токены в query-строке. Значения по именам полей показываются
 * в виде `sk-…abcd` — этого достаточно, чтобы отличить один ключ от другого.
 */
export function sanitize(value: unknown): unknown {
  return redactDeep(value)
}


function serialize(value: unknown): string {
  const clean = sanitize(value)
  if (typeof clean === 'string') return clean
  try {
    return JSON.stringify(clean, null, 2)
  } catch {
    return String(clean)
  }
}

interface DebugState {
  entries: DebugEntry[]
  enabled: boolean
  log: (entry: Omit<DebugEntry, 'id' | 'at'> & { at?: number }) => void
  clear: () => void
  setEnabled: (v: boolean) => void
}

let counter = 0

export const useDebug = create<DebugState>((set) => ({
  entries: [],
  enabled: true,
  log: (entry) =>
    set((s) => {
      // защита от лишнего шума: не пишем, если логирование выключено
      const next: DebugEntry = {
        id: `log_${++counter}`,
        at: entry.at ?? Date.now(),
        kind: entry.kind,
        title: entry.title,
        lines: entry.lines.map((l) => serialize(l)),
      }
      return { entries: [next, ...s.entries].slice(0, MAX_ENTRIES) }
    }),
  clear: () => set({ entries: [] }),
  setEnabled: (enabled) => set({ enabled }),
}))

export function debugLog(
  kind: DebugKind,
  title: string,
  lines: unknown[] = [],
): void {
  if (kind === 'info' || useDebug.getState().enabled) {
    useDebug.getState().log({ kind, title, lines: lines as string[] })
  }
}

export function debugRequest(title: string, payload: unknown): void {
  debugLog('request', title, [payload])
}
