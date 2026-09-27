import { APP_NAME, APP_TAGLINE, APP_VERSION } from '@/lib/appInfo'
import { IconGlobe, IconImage, IconSparkles } from './icons'
import { BrandMark } from './BrandMark'

/**
 * Стартовый экран для первого запуска (или когда подключение ещё не настроено):
 * объясняет, что это за приложение, и ведёт в мастер настройки.
 */

const FEATURES: Array<{ icon: typeof IconSparkles; title: string; text: string }> = [
  {
    icon: IconSparkles,
    title: 'Любой провайдер',
    text: 'OpenAI, OpenRouter, RuAPI, Groq, DeepSeek или локальные Ollama и LM Studio — один клиент.',
  },
  {
    icon: IconGlobe,
    title: 'Инструменты',
    text: 'Поиск в интернете, чтение страниц по ссылке и генерация изображений по запросу.',
  },
  {
    icon: IconImage,
    title: 'Живой стрим',
    text: 'Ответ печатается на глазах, а размышления модели видны под отдельным катом.',
  },
]

interface WelcomeScreenProps {
  onSetup: () => void
  onOpenSettings: () => void
}

export function WelcomeScreen({ onSetup, onOpenSettings }: WelcomeScreenProps) {
  return (
    <div className="relative flex-1 overflow-y-auto">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-100 via-slate-50 to-sky-100 dark:from-violet-950/40 dark:via-slate-950 dark:to-sky-950/40" />

      <div className="relative mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-6 px-5 py-10 text-center">
        <BrandMark size={88} className="rounded-[26px] shadow-xl shadow-violet-500/20" />

        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-white">
            {APP_NAME}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{APP_TAGLINE}</p>
        </div>

        <p className="max-w-lg text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Универсальный чат-клиент для любого OpenAI-совместимого API. Укажите адрес и ключ —
          SYNTH подтянет список доступных моделей, и можно сразу общаться.
        </p>

        <div className="grid w-full gap-2 text-left sm:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="rounded-2xl border border-slate-200 bg-white/70 p-3 backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/50"
            >
              <span className="text-violet-600 dark:text-violet-400">
                <f.icon size={18} />
              </span>
              <div className="mt-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
                {f.title}
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {f.text}
              </div>
            </div>
          ))}
        </div>

        <div className="flex w-full max-w-xs flex-col items-center gap-2">
          <button
            type="button"
            onClick={onSetup}
            className="w-full rounded-2xl bg-gradient-to-r from-violet-600 to-sky-500 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-violet-500/20 transition active:scale-[0.99]"
          >
            Настроить подключение
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="w-full rounded-2xl border border-slate-200 px-4 py-2.5 text-sm text-slate-600 transition hover:bg-white/70 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
          >
            Все настройки
          </button>
        </div>

        <p className="text-[11px] text-slate-400 dark:text-slate-500">
          Версия {APP_VERSION} · ключ и история хранятся только на этом устройстве
        </p>
      </div>
    </div>
  )
}
