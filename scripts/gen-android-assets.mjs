import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_NAME, iconPng, splashPng } from './brand.mjs'

/**
 * Генератор иконок и сплэшей Android-проекта (Capacitor).
 * Знак и палитра — общие с PWA-иконками (scripts/brand.mjs).
 *
 * Раскладка соответствует стандартному шаблону Capacitor:
 *   mipmap-<dpi>/ic_launcher.png            — обычная иконка (до API 26)
 *   mipmap-<dpi>/ic_launcher_round.png      — круглая иконка
 *   mipmap-<dpi>/ic_launcher_foreground.png — слой adaptive-иконки (прозрачный)
 *   drawable-port-<dpi|land-<dpi>/splash.png — сплэш-экраны
 *
 * Запуск: npm run android:assets
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RES = resolve(root, 'android/app/src/main/res')

/** Плотности: [папка, сторона legacy-иконки, сторона foreground (108dp), портрет, ландшафт] */
const DENSITIES = [
  ['mdpi', 48, 108, [320, 480], [480, 320]],
  ['hdpi', 72, 162, [480, 800], [800, 480]],
  ['xhdpi', 96, 216, [720, 1280], [1280, 720]],
  ['xxhdpi', 144, 324, [960, 1600], [1600, 960]],
  ['xxxhdpi', 192, 432, [1280, 1920], [1920, 1280]],
]

/** Знак: масштаб в обычной иконке, в adaptive-слое и на сплэше. */
const LAUNCHER_SCALE = 1.15
const FOREGROUND_SCALE = 0.85
const SPLASH_SCALE = 0.6

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  console.log(`  ✓ ${path.replace(`${root}/`, '')} (${(data.length / 1024).toFixed(1)} КБ)`)
}

console.log(`Генерация Android-ассетов ${APP_NAME}…`)

for (const [dpi, launcher, foreground, port, land] of DENSITIES) {
  const mipmap = resolve(RES, `mipmap-${dpi}`)
  write(resolve(mipmap, 'ic_launcher.png'), iconPng(launcher, { scale: LAUNCHER_SCALE }))
  write(resolve(mipmap, 'ic_launcher_round.png'), iconPng(launcher, { scale: LAUNCHER_SCALE, mask: 'circle' }))
  write(
    resolve(mipmap, 'ic_launcher_foreground.png'),
    iconPng(foreground, { scale: FOREGROUND_SCALE, background: null }),
  )
  write(resolve(RES, `drawable-port-${dpi}/splash.png`), splashPng(port[0], port[1], SPLASH_SCALE))
  write(resolve(RES, `drawable-land-${dpi}/splash.png`), splashPng(land[0], land[1], SPLASH_SCALE))
}

// Базовый splash для плотности по умолчанию (как в шаблоне Capacitor — land-mdpi).
write(resolve(RES, 'drawable/splash.png'), splashPng(480, 320, SPLASH_SCALE))
console.log('Готово. Ассеты лежат в android/app/src/main/res/.')
