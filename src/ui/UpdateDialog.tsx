import { APP_VERSION, RELEASES_URL } from '@/lib/appInfo'
import { nativeUpdaterAvailable } from '@/lib/nativeUpdater'
import { useUpdateStore } from '@/lib/updateStore'
import { cn } from '@/lib/utils'
import { IconAlert, IconDownload, IconRefresh } from './icons'
import { Markdown } from './Markdown'
import { Sheet } from './Sheet'

/**
 * Диалог обновления: что нового + кнопка «Скачать и установить».
 * В APK-сборке файл качается через нативный плагин SynthUpdater и сразу
 * отдаётся системному установщику; в браузере открывается страница релиза.
 */

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} МБ`
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`
}

function formatDate(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}

export function UpdateDialog() {
  const info = useUpdateStore((s) => s.info)
  const open = useUpdateStore((s) => s.dialogOpen)
  const close = useUpdateStore((s) => s.closeDialog)
  const skip = useUpdateStore((s) => s.skip)
  const downloading = useUpdateStore((s) => s.downloading)
  const progress = useUpdateStore((s) => s.progress)
  const error = useUpdateStore((s) => s.error)
  const apkPath = useUpdateStore((s) => s.apkPath)
  const downloadAndInstall = useUpdateStore((s) => s.downloadAndInstall)

  if (!open || !info) return null

  const canInstallInApp = nativeUpdaterAvailable() && Boolean(info.apk)
  const percent = Math.round(progress * 100)
  const sizeLabel = formatSize(info.apk?.size)

  const primaryLabel = downloading
    ? `Скачиваю… ${percent}%`
    : apkPath
      ? 'Установить'
      : canInstallInApp
        ? `Скачать и установить${sizeLabel ? ` (${sizeLabel})` : ''}`
        : 'Скачать APK на GitHub'

  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Доступна версия ${info.version}`}
      description={`У вас ${APP_VERSION}${info.publishedAt ? ` · релиз от ${formatDate(info.publishedAt)}` : ''}`}
      footer={
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={downloading}
            onClick={() => void downloadAndInstall()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-sky-500 px-4 py-2.5 text-sm font-medium text-white transition disabled:opacity-60"
          >
            {downloading ? (
              <IconRefresh size={16} className="animate-spin" />
            ) : (
              <IconDownload size={16} />
            )}
            {primaryLabel}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={close}
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Позже
            </button>
            <button
              type="button"
              onClick={skip}
              className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Пропустить версию
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-100">
          <span className="rounded-lg bg-violet-100 px-2 py-0.5 text-xs text-violet-700 dark:bg-violet-950/50 dark:text-violet-200">
            {info.title}
          </span>
        </div>

        {downloading && (
          <div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-sky-500 transition-all"
                style={{ width: `${Math.max(4, percent)}%` }}
              />
            </div>
            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Загрузка APK: {percent}%
            </div>
          </div>
        )}

        {info.notes ? (
          <div className="max-h-72 overflow-auto rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <Markdown content={info.notes} />
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Описание изменений не заполнено — подробности на странице релиза.
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
            <IconAlert size={15} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap">{error}</span>
          </div>
        )}

        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {canInstallInApp
            ? 'SYNTH скачает APK и предложит установку. Данные и настройки сохранятся.'
            : 'В браузере установка APK недоступна — откроется страница релиза.'}{' '}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className={cn('underline underline-offset-2')}
          >
            Все релизы
          </a>
        </p>
      </div>
    </Sheet>
  )
}
