import { cn } from '@/lib/utils'

/**
 * Переключатель из нескольких равнозначных вариантов: режим подключения,
 * тип подключения (протокол), размер шрифта.
 *
 * Стоит отдельно от остальных контролов, потому что нужен в двух местах —
 * в окне настроек и в мастере первого запуска.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-1 rounded-xl bg-neutral-100 p-1 dark:bg-neutral-800">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'flex-1 rounded-lg px-2 py-1.5 text-xs transition',
            value === o.value
              ? 'bg-white font-medium text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
              : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
