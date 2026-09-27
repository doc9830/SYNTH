/**
 * Миграции localStorage между версиями приложения.
 * Ключи настроек менялись, старые нужно аккуратно переносить,
 * чтобы пользователь не терял API key и настройки.
 */

const MIGRATIONS_FLAG = 'ds-chat.migrations.v1'

/** Ключи из ранних черновиков → актуальный ключ настроек. */
const LEGACY_SETTING_KEYS = ['ds-chat:settings', 'dschat.settings', 'settings']

export function migrateLegacyStorage(): void {
  if (typeof localStorage === 'undefined') return
  if (localStorage.getItem(MIGRATIONS_FLAG)) return

  const current = localStorage.getItem('ds-chat.settings.v1')
  if (!current) {
    for (const legacy of LEGACY_SETTING_KEYS) {
      const raw = localStorage.getItem(legacy)
      if (raw) {
        localStorage.setItem('ds-chat.settings.v1', raw)
        localStorage.removeItem(legacy)
        break
      }
    }
  }

  localStorage.setItem(MIGRATIONS_FLAG, String(Date.now()))
}
