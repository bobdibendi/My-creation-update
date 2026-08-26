import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { cx } from './ui/cx'

export interface BarDatum {
  label: string
  value: number
  /** Theme hue slot name, e.g. `hue1`. Cycles automatically when omitted. */
  hue?: string
}

interface BarChartProps {
  data: BarDatum[]
  /** Formats the value shown next to each bar. */
  format?: (value: number) => string
  max?: number
  className?: string
}

const HUES = ['hue1', 'hue2', 'hue3', 'hue4', 'hue5']

/**
 * Horizontal bar chart.
 *
 * Hand-rolled rather than pulled from a charting library: the app's CSP forbids
 * runtime style injection, which most chart libraries rely on, and a bar chart
 * is a width animation.
 */
export function BarChart({ data, format, max, className }: BarChartProps) {
  const ceiling = useMemo(
    () => max ?? Math.max(1, ...data.map(item => item.value)),
    [data, max],
  )

  return (
    <div className={cx('chart-bars', className)} role="img" aria-label="Répartition">
      {data.map((item, index) => (
        <div className="chart-bars__row" key={item.label}>
          <span className="chart-bars__label" title={item.label}>{item.label}</span>
          <span className="chart-bars__track">
            <motion.span
              className={cx('chart-bars__fill', `is-${item.hue ?? HUES[index % HUES.length]}`)}
              initial={{ width: 0 }}
              animate={{ width: `${(item.value / ceiling) * 100}%` }}
              transition={{ duration: 0.45, delay: index * 0.03, ease: [0.05, 0.7, 0.1, 1] }}
            />
          </span>
          <span className="chart-bars__value">
            {format ? format(item.value) : item.value.toLocaleString('fr-FR')}
          </span>
        </div>
      ))}
      {data.length === 0 && <span className="chart-bars__empty">Aucune donnée</span>}
    </div>
  )
}

interface DonutProps {
  /** 0 to 1. */
  value: number
  label: string
  caption?: string
  size?: number
  tone?: 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}

const CIRCUMFERENCE_RADIUS = 15.5

/** Single-value ring gauge. */
export function Donut({
  value, label, caption, size = 92, tone = 'accent', className,
}: DonutProps) {
  const clamped = Math.min(1, Math.max(0, value))
  const circumference = 2 * Math.PI * CIRCUMFERENCE_RADIUS

  return (
    <div className={cx('chart-donut', `is-${tone}`, className)} style={{ width: size }}>
      <svg viewBox="0 0 40 40" width={size} height={size} role="img" aria-label={`${label}: ${Math.round(clamped * 100)}%`}>
        <circle className="chart-donut__track" cx="20" cy="20" r={CIRCUMFERENCE_RADIUS} fill="none" strokeWidth="4" />
        <motion.circle
          className="chart-donut__fill"
          cx="20"
          cy="20"
          r={CIRCUMFERENCE_RADIUS}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          transform="rotate(-90 20 20)"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - clamped) }}
          transition={{ duration: 0.7, ease: [0.05, 0.7, 0.1, 1] }}
        />
      </svg>
      <span className="chart-donut__center">
        <strong>{Math.round(clamped * 100)}%</strong>
        <small>{label}</small>
      </span>
      {caption && <span className="chart-donut__caption">{caption}</span>}
    </div>
  )
}

interface SparklineProps {
  values: number[]
  className?: string
  label: string
}

/** Compact trend line. Values are normalised to their own range. */
export function Sparkline({ values, className, label }: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return ''
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 100
        const y = 28 - ((value - min) / span) * 24
        return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
      })
      .join(' ')
  }, [values])

  if (path.length === 0) return null

  return (
    <svg
      className={cx('chart-spark', className)}
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <motion.path
        d={path}
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.8, ease: 'easeOut' }}
      />
    </svg>
  )
}

interface MeterProps {
  segments: Array<{ label: string; value: number; hue?: string }>
  className?: string
  ariaLabel: string
}

/** Single stacked bar, for language or dependency composition. */
export function StackedMeter({ segments, className, ariaLabel }: MeterProps) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1

  return (
    <div className={cx('chart-meter', className)}>
      <div className="chart-meter__bar" role="img" aria-label={ariaLabel}>
        {segments.map((segment, index) => (
          <motion.span
            key={segment.label}
            className={cx('chart-meter__seg', `is-${segment.hue ?? HUES[index % HUES.length]}`)}
            title={`${segment.label}: ${segment.value}`}
            initial={{ flexGrow: 0 }}
            animate={{ flexGrow: segment.value / total }}
            transition={{ duration: 0.5, delay: index * 0.04 }}
          />
        ))}
      </div>
      <div className="chart-meter__legend">
        {segments.slice(0, 6).map((segment, index) => (
          <span key={segment.label}>
            <i className={cx('chart-meter__dot', `is-${segment.hue ?? HUES[index % HUES.length]}`)} />
            {segment.label}
            <em>{Math.round((segment.value / total) * 100)}%</em>
          </span>
        ))}
      </div>
    </div>
  )
}
