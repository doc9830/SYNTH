/**
 * Общие стилевые токены интерфейса: поля ввода, кнопки, подписи.
 *
 * Держим их в одном месте, чтобы скругления, отступы и границы во всех
 * панелях (настройки, мастер подключения, селектор моделей) совпадали,
 * а акцентный цвет оставался нейтральным — серым, без «цветных» кнопок.
 */

/** Поле ввода, select, textarea. */
export const inputCls =
  'w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-400 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-500'

/** Второстепенная кнопка (действия, проверки). */
export const btnCls =
  'inline-flex items-center gap-1.5 rounded-xl border border-neutral-300 px-3 py-2 text-sm text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800'

/** Главная кнопка (отправка, сохранение). */
export const btnPrimaryCls =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white'

/** Подпись поля. */
export const labelCls = 'mb-1 block text-xs font-medium text-neutral-600 dark:text-neutral-300'
