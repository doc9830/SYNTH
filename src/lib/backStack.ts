/**
 * Стек обработчиков аппаратной кнопки «Назад» (Android).
 *
 * Каждая открытая панель (шторка, диалог, меню, сайдбар) регистрирует свой
 * обработчик; нажатие достаётся последнему зарегистрированному — то есть
 * самой верхней панели. Если никого нет, `handleBackPress()` вернёт false
 * и вызывающий свернёт приложение.
 *
 * Так «Назад» закрывает то, что реально открыто, вместо закрытия приложения.
 */

type BackHandler = () => void

const handlers: BackHandler[] = []

/** Регистрирует обработчик; возвращает функцию отписки. */
export function pushBackHandler(handler: BackHandler): () => void {
  handlers.push(handler)
  let released = false

  return () => {
    if (released) return
    released = true
    const index = handlers.lastIndexOf(handler)
    if (index >= 0) handlers.splice(index, 1)
  }
}

/**
 * Отдаёт нажатие верхнему обработчику.
 * true — нажатие поглощено (панель закрыта), false — закрывать нечего.
 */
export function handleBackPress(): boolean {
  const handler = handlers[handlers.length - 1]
  if (!handler) return false
  handler()
  return true
}

/** Сколько панелей сейчас в стеке (для отладки). */
export function backHandlersCount(): number {
  return handlers.length
}
