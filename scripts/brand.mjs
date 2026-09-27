import { deflateSync } from 'node:zlib'

/**
 * Фирменный стиль SYNTH: программная отрисовка логотипа без внешних зависимостей.
 *
 * Знак — «нейронный хаб»: центральный узел (акцентный цвет), три узла-спутника
 * и связи между ними. Используется и в веб-иконках (public/), и в ассетах
 * Android-проекта (scripts/gen-android-assets.mjs).
 */

export const APP_NAME = 'SYNTH'
export const APP_TAGLINE = 'Synthetic Neural & Tool Hub'

// ── Палитра ─────────────────────────────────────────────────────────
/** Градиент фона: фиолетовый → почти чёрный (как в тёмной теме приложения). */
export const BG_FROM = [124, 58, 237] // violet-600
export const BG_TO = [11, 13, 18] // #0b0d12
/** Акцент (центральный узел). */
export const ACCENT = [34, 211, 238] // cyan-400
export const NODE = [255, 255, 255]

// ── Геометрия знака (в долях холста, y вниз) ────────────────────────
const CENTER = { x: 0.5, y: 0.5, r: 0.095 }
const ORBIT = 0.262
const ANGLES = [-90, 30, 150] // градусы: верх, право-низ, лево-низ
const SATELLITE_R = 0.072
const LINK_HALF_WIDTH = 0.021

const SATELLITES = ANGLES.map((deg) => {
  const rad = (deg * Math.PI) / 180
  return {
    x: CENTER.x + ORBIT * Math.cos(rad),
    y: CENTER.y + ORBIT * Math.sin(rad),
    r: SATELLITE_R,
  }
})

export const NODES = [CENTER, ...SATELLITES]
export const LINKS = SATELLITES.map((s) => ({ from: CENTER, to: s, halfWidth: LINK_HALF_WIDTH }))

function insideCircle(x, y, c) {
  return (x - c.x) ** 2 + (y - c.y) ** 2 <= c.r ** 2
}

function distanceToSegment(px, py, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2))
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

function gradientColor(u, v) {
  const t = Math.min(Math.max((u + v) / 2, 0), 1)
  return [
    Math.round(BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t),
    Math.round(BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t),
    Math.round(BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t),
  ]
}

/**
 * Цвет знака в точке (u, v) ∈ [0,1] или null, если точка вне знака.
 * scale — множитель размера знака: 1 — натуральный, >1 — знак меньше
 * (safe zone для maskable-PWA и adaptive-иконок Android).
 */
export function markColor(u, v, scale = 1) {
  const gx = (u - 0.5) / scale + 0.5
  const gy = (v - 0.5) / scale + 0.5

  if (insideCircle(gx, gy, CENTER)) return ACCENT
  for (const s of SATELLITES) if (insideCircle(gx, gy, s)) return NODE
  for (const l of LINKS) {
    if (distanceToSegment(gx, gy, l.from, l.to) <= l.halfWidth) return NODE
  }
  return null
}

function insideSquircle(u, v) {
  const p = 4
  return Math.abs(u - 0.5) ** p + Math.abs(v - 0.5) ** p <= 0.5 ** p
}

/**
 * Растровое изображение иконки в RGBA.
 * @param {number} size сторона квадрата в пикселях
 * @param {{ scale?: number, background?: 'gradient' | null, mask?: 'circle' | 'squircle' | null }} opts
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

export function iconSvg({ maskable = false } = {}) {
  const scale = maskable ? 0.72 : 1
  const X = (x) => (100 * ((x - 0.5) / scale + 0.5)).toFixed(2)
  const Y = (y) => (100 * ((y - 0.5) / scale + 0.5)).toFixed(2)
  const strokeWidth = ((2 * LINK_HALF_WIDTH * 100) / scale).toFixed(2)
  const lines = SATELLITES.map(
    (s) =>
      `  <line x1="${X(CENTER.x)}" y1="${Y(CENTER.y)}" x2="${X(s.x)}" y2="${Y(s.y)}" stroke="${hex(NODE)}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
  ).join('\n')
  const nodes = NODES.map(
    (n, i) =>
      `  <circle cx="${X(n.x)}" cy="${Y(n.y)}" r="${((n.r * 100) / scale).toFixed(2)}" fill="${i === 0 ? hex(ACCENT) : hex(NODE)}"/>`,
  ).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${APP_NAME} — ${APP_TAGLINE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hex(BG_FROM)}"/>
      <stop offset="1" stop-color="${hex(BG_TO)}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#bg)"/>
${lines}
${nodes}
</svg>
`
}
