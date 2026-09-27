import { useId, useMemo } from 'react'
import { cn } from '@/lib/utils'

/**
 * Знак SYNTH: минималистичная монограмма «S» — одна линия с круглыми концами
 * на графитово-сером фоне. Геометрия и палитра совпадают с иконками приложения
 * и ассетами Android (scripts/brand.mjs) — при правке знака меняйте оба места.
 */

/** Палитра знака (scripts/brand.mjs → BG_FROM / BG_TO / ACCENT). */
const BG_FROM = '#3A3E44'
const BG_TO = '#16181B'
const ACCENT = '#F4F5F7'

/** Верхний и нижний полукруги знака в долях холста (y вниз). */
const UPPER = { x: 0.5, y: 0.325, rx: 0.175, ry: 0.135 }
const LOWER = { x: 0.5, y: 0.675, rx: 0.175, ry: 0.135 }
const STROKE = 0.038 // половина толщины линии
const SEGMENTS = 32 // сегментов на дугу

function ellipsePoint(arc: typeof UPPER, deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: arc.x + arc.rx * Math.cos(rad), y: arc.y + arc.ry * Math.sin(rad) }
}

/** Осевая линия знака: верхняя дуга → наклонный переход → нижняя дуга. */
function buildPath(): string {
  const points: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= SEGMENTS; i += 1) points.push(ellipsePoint(UPPER, 20 - 230 * (i / SEGMENTS)))
  for (let i = 0; i <= SEGMENTS; i += 1) points.push(ellipsePoint(LOWER, -30 + 240 * (i / SEGMENTS)))
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * 100).toFixed(1)} ${(p.y * 100).toFixed(1)}`)
    .join(' ')
}

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  const gradientId = useId()
  const path = useMemo(buildPath, [])

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
      role="img"
      aria-label="SYNTH"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BG_FROM} />
          <stop offset="1" stopColor={BG_TO} />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="26" fill={`url(#${gradientId})`} />
      <path
        d={path}
        fill="none"
        stroke={ACCENT}
        strokeWidth={STROKE * 200}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
