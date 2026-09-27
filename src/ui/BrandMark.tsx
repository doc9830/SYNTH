import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * Знак SYNTH: нейронный хаб (центральный узел + три узла-спутника и связи).
 * Та же геометрия, что в иконках приложения — scripts/brand.mjs.
 */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  const gradientId = useId()
  const satellites: Array<[number, number]> = [
    [0, -26.2],
    [22.69, 13.1],
    [-22.69, 13.1],
  ]

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
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7C3AED" />
          <stop offset="1" stopColor="#0B0D12" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="26" fill={`url(#${gradientId})`} />
      <g transform="translate(50 50)">
        {satellites.map(([x, y]) => (
          <line
            key={`${x}:${y}`}
            x1={0}
            y1={0}
            x2={x}
            y2={y}
            stroke="#FFFFFF"
            strokeWidth={4.2}
            strokeLinecap="round"
          />
        ))}
        {satellites.map(([x, y]) => (
          <circle key={`n${x}:${y}`} cx={x} cy={y} r={7.2} fill="#FFFFFF" />
        ))}
        <circle cx={0} cy={0} r={9.5} fill="#22D3EE" />
      </g>
    </svg>
  )
}
