import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, iconPng, iconSvg } from './brand.mjs'

/**
 * Генератор PWA-иконок SYNTH без внешних зависимостей.
 * Рисование и палитра — в scripts/brand.mjs (общие с Android-ассетами).
 *
 * Запуск: npm run icons
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = resolve(root, 'public')
const ICONS_DIR = resolve(PUBLIC_DIR, 'icons')

/** Знак «во всю» иконки; maskable-вариант — мельче (safe zone 40% радиуса). */
const ICON_SCALE = 1.05
const MASKABLE_SCALE = 1.12

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`  ✓ ${path.replace(`${root}/`, '')} (${(data.length / 1024).toFixed(1)} КБ)`)
}

console.log(`Генерация иконок ${APP_NAME}…`)
write(resolve(PUBLIC_DIR, 'favicon.svg'), iconSvg())
write(resolve(ICONS_DIR, 'icon.svg'), iconSvg())
write(resolve(ICONS_DIR, 'icon-192.png'), iconPng(192, { scale: ICON_SCALE }))
write(resolve(ICONS_DIR, 'icon-512.png'), iconPng(512, { scale: ICON_SCALE }))
write(resolve(ICONS_DIR, 'icon-maskable-512.png'), iconPng(512, { scale: MASKABLE_SCALE }))
write(resolve(ICONS_DIR, 'apple-touch-icon.png'), iconPng(180, { scale: ICON_SCALE }))
console.log('Готово. Файлы лежат в public/ и public/icons/.')
