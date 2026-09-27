import { useSettings, type Settings } from '@/lib/settings'
import {
  FEATURES,
  FEATURE_GROUPS,
  FEATURE_GROUP_LABELS,
  featureById,
  isFeatureAvailable,
  isFeatureOn,
  setFeature,
  type Feature,
} from '@/lib/features'
import { cn } from '@/lib/utils'
import { IconBrain } from './icons'
import { Sheet } from './Sheet'

/**
 * Шторка «Функции»: все переключатели, влияющие на поведение модели,
 * в одном месте — поиск, чтение ссылок, картинки, инструменты, память, вид ленты.
 *
 * Шторка нужна потому, что часть флагов меняется редко, и держать их чипами
 * под полем ввода неудобно: в композере остаются только главные (см. PRIMARY_FEATURES).
 */
interface FeatureSheetProps {
  open: boolean
  onClose: () => void
  /** Переход в управление памятью (записи, экспорт, очистка) */
  onOpenMemory?: () => void
}

export function FeatureSheet({ open, onClose, onOpenMemory }: FeatureSheetProps) {
  const settings = useSettings((s) => s.settings)

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Функции"
      description="Что делать с этим чатом: инструменты модели, память, вид ленты. Настройки применяются сразу и сохраняются на устройстве."
    >
      <div className="space-y-5">
        {FEATURE_GROUPS.map((group) => {
          const items = FEATURES.filter((f) => f.group === group)
          if (!items.length) return null
          return (
            <section key={group}>
              <h4 className="mb-1 px-1 text-[11px] font-medium tracking-wide text-neutral-500 uppercase dark:text-neutral-400">
                {FEATURE_GROUP_LABELS[group]}
              </h4>
              <div className="divide-y divide-neutral-200 rounded-2xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
                {items.map((feature) => (
                  <FeatureRow key={feature.id} feature={feature} settings={settings} />
                ))}
              </div>
              {group === 'memory' && onOpenMemory && (
                <button
                  type="button"
                  onClick={() => {
                    onClose()
                    onOpenMemory()
                  }}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition active:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:active:bg-neutral-800"
                >
                  <IconBrain size={16} />
                  Открыть память: записи, экспорт, очистка
                </button>
              )}
            </section>
          )
        })}
      </div>
    </Sheet>
  )
}

function FeatureRow({ feature, settings }: { feature: Feature; settings: Settings }) {
  const on = isFeatureOn(settings, feature)
  const available = isFeatureAvailable(settings, feature)
  const Icon = feature.icon
  const parentLabel = feature.requires ? featureById(feature.requires).label : ''

  return (
    <button
      type="button"
      onClick={() => {
        if (available) setFeature(feature, !on)
        else if (feature.requires) setFeature(feature, true)
      }}
      className={cn(
        'flex w-full items-start gap-3 rounded-none px-3 py-2.5 text-left transition active:bg-neutral-100 dark:active:bg-neutral-800',
        !available && !on && 'opacity-70',
      )}
    >
      <Icon size={17} className={cn('mt-0.5 shrink-0', on ? 'text-neutral-800 dark:text-neutral-100' : 'text-neutral-400')} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-neutral-800 dark:text-neutral-100">{feature.label}</span>
        <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {available ? feature.hint : `Требуется включить «${parentLabel}» — нажмите, чтобы включить оба.`}
        </span>
      </span>
      <span
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition',
          on ? 'bg-neutral-900 dark:bg-neutral-200' : 'bg-neutral-300 dark:bg-neutral-700',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
            on ? 'left-4.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  )
}
