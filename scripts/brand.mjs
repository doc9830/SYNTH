import { deflateSync } from 'node:zlib'

/**
 * Фирменный стиль SYNTH: программная отрисовка знака без внешних зависимостей.
 *
 * Знак — минималистичная монограмма «S»: одна линия постоянной толщины с
 * круглыми концами на графитово-сером фоне. Та же геометрия используется в
 * веб-иконках (public/), в ассетах Android (scripts/gen-android-assets.mjs)
 * и в интерфейсе (src/ui/BrandMark.tsx).
 */

export const APP_NAME = 'SYNTH'
export const APP_TAGLINE = 'Synthetic Neural & Tool Hub'

// ── Палитра ─────────────────────────────────────────────────────────
/** Фон: серьёзный графит — от светлого сверху к почти чёрному снизу. */
export const BG_FROM = [58, 62, 68] // #3A3E44
export const BG_TO = [22, 24, 27] // #16181B
/** Знак: нейтральный почти-белый (не белоснежный — «спокойнее»). */
export const ACCENT = [244, 245, 247] // #F4F5F7
export const NODE = ACCENT

// ── Геометрия знака «S» (доли холста, y вниз) ───────────────────────
/** Верхний и нижний полукруги: одна линия = дуга + наклонный переход + дуга. */
const UPPER = { x: 0.5, y: 0.325, rx: 0.175, ry: 0.135 }
const LOWER = { x: 0.5, y: 0.675, rx: 0.175, ry: 0.135 }
/** Половина толщины линии. */
const STROKE = 0.038
/** Сегментов на дугу (больше — глаже, но медленнее отрисовка). */
const ARC_SEGMENTS = 40

function ellipsePoint(arc, deg) {
  const rad = (deg * Math.PI) / 180
  return { x: arc.x + arc.rx * Math.cos(rad), y: arc.y + arc.ry * Math.sin(rad) }
}

/** Точки осевой линии знака: верхняя дуга, наклонный переход, нижняя дуга. */
function buildPath(segments = ARC_SEGMENTS) {
  const points = []
  // Верхняя дуга: от правого окончания через верх к нижне-левому краю.
  for (let i = 0; i <= segments; i += 1) points.push(ellipsePoint(UPPER, 20 - 230 * (i / segments)))
  // Нижняя дуга: от верхне-правого края через низ к левому окончанию.
  for (let i = 0; i <= segments; i += 1) points.push(ellipsePoint(LOWER, -30 + 240 * (i / segments)))
  return points
}

/** Осевая линия знака (для SVG и растровой отрисовки). */
export const STROKE_PATH = buildPath()

/** Границы знака с учётом толщины линии — для быстрой отбраковки точек. */
const BOUNDS = (() => {
  let minX = 1
  let maxX = 0
  let minY = 1
  let maxY = 0
  for (const p of STROKE_PATH) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  return { minX: minX - STROKE, maxX: maxX + STROKE, minY: minY - STROKE, maxY: maxY + STROKE }
})()

/** Квадрат расстояния от точки до осевой линии (по сегментам, без sqrt). */
function distanceSq(x, y, points) {
  let best = Infinity
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const px = x - (a.x + t * dx)
    const py = y - (a.y + t * dy)
    const d = px * px + py * py
    if (d < best) best = d
  }
  return best
}

/** Фон иконки: вертикальный графитовый градиент (u не используется — фон осесимметричный). */
function gradientColor(_u, v) {
  const t = Math.min(Math.max(v, 0), 1)
  return [
    Math.round(BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t),
    Math.round(BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t),
    Math.round(BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t),
  ]
}

/**
 * Цвет знака в точке (u, v) ∈ [0,1] или null, если точка вне знака.
 * scale — множитель размера знака: 1 — натуральный, >1 — знак крупнее
 * (квадратные иконки), <1 — мельче (safe zone maskable-PWA и adaptive Android).
 */
export function markColor(u, v, scale = 1) {
  const gx = (u - 0.5) / scale + 0.5
  const gy = (v - 0.5) / scale + 0.5
  if (gx < BOUNDS.minX || gx > BOUNDS.maxX || gy < BOUNDS.minY || gy > BOUNDS.maxY) return null
  return distanceSq(gx, gy, STROKE_PATH) <= STROKE * STROKE ? ACCENT : null
}

function insideSquircle(u, v) {
  const p = 4
  return Math.abs(u - 0.5) ** p + Math.abs(v - 0.5) ** p <= 0.5 ** p
}

/**
 * Растровое изображение иконки в RGBA.
 * @param {number} size сторона квадрата в пикселях
 * @param {{ scale?: number, background?: 'gradient' | null, mask?: 'circle' | 'squircle' | null }} opts
 *   scale > 1 — знак крупнее (квадратная иконка), scale < 1 — мельче (safe zone maskable/adaptive).
 */
export function renderIcon(size, opts = {}) {
  const { scale = 1, background = 'gradient', mask = null } = opts
  const SS = 3 // суперсэмплинг 3×3
  const out = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let covered = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          if (mask === 'circle' && Math.hypot(u - 0.5, v - 0.5) > 0.5) continue
          if (mask === 'squircle' && !insideSquircle(u, v)) continue
          const base = markColor(u, v, scale) ?? (background === 'gradient' ? gradientColor(u, v) : [0, 0, 0])
          r += base[0]
          g += base[1]
          b += base[2]
          covered += 1
        }
      }
      if (covered === 0) continue
      const i = (y * size + x) * 4
      out[i] = Math.round(r / covered)
      out[i + 1] = Math.round(g / covered)
      out[i + 2] = Math.round(b / covered)
      out[i + 3] = Math.round((covered * 255) / (SS * SS))
    }
  }
  return out
}

// ── Минимальный PNG-энкодер (RGBA, без интерлейса) ──────────────────
const CRC_TABLE = (() => {
  const table = new Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Иконка в PNG-буфере. */
export function iconPng(size, opts = {}) {
  return encodePNG(size, size, renderIcon(size, opts))
}

/**
 * Прямоугольное изображение с градиентом и знаком по центру —
 * для Android-сплэшей (битмап растягивается системой, поэтому просто fill).
 */
export function splashPng(width, height, markScale = 0.22) {
  const rgba = Buffer.alloc(width * height * 4)
  const size = Math.min(width, height)
  const offsetX = (width - size) / 2
  const offsetY = (height - size) / 2
  const SS = 2

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const base =
            markColor((px - offsetX) / size, (py - offsetY) / size, markScale) ??
            gradientColor(px / width, py / height)
          r += base[0]
          g += base[1]
          b += base[2]
        }
      }
      const n = SS * SS
      const i = (y * width + x) * 4
      rgba[i] = Math.round(r / n)
      rgba[i + 1] = Math.round(g / n)
      rgba[i + 2] = Math.round(b / n)
      rgba[i + 3] = 255
    }
  }
  return encodePNG(width, height, rgba)
}

// ── SVG-версия знака ────────────────────────────────────────────────
function hex(rgb) {
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function iconSvg({ maskable = false, scale = 1 } = {}) {
  const k = maskable ? 0.88 : scale
  const X = (x) => (100 * ((x - 0.5) * k + 0.5)).toFixed(1)
  const Y = (y) => (100 * ((y - 0.5) * k + 0.5)).toFixed(1)
  const d = STROKE_PATH.filter((_, i) => i % 2 === 0 || i === STROKE_PATH.length - 1)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.x)} ${Y(p.y)}`)
    .join(' ')
  const strokeWidth = (2 * STROKE * 100 * k).toFixed(1)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${APP_NAME} — ${APP_TAGLINE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hex(BG_FROM)}"/>
      <stop offset="1" stop-color="${hex(BG_TO)}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100"${maskable ? '' : ' rx="22"'} fill="url(#bg)"/>
  <path d="${d}" fill="none" stroke="${hex(ACCENT)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`
}
