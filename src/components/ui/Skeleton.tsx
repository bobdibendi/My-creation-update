import { cx } from './cx'

interface SkeletonProps {
  width?: number | string
  height?: number | string
  /** `text` rounds to the line radius, `circle` to a disc. */
  shape?: 'text' | 'block' | 'circle'
  className?: string
}

/**
 * Shimmering placeholder.
 *
 * The sweep is a CSS animation on a gradient rather than a Framer loop: dozens
 * of skeletons can be on screen at once and a compositor-only keyframe is far
 * cheaper than dozens of JS-driven values.
 */
export function Skeleton({ width, height = 12, shape = 'text', className }: SkeletonProps) {
  return (
    <span
      className={cx('ui-skeleton', `ui-skeleton--${shape}`, className)}
      style={{ width: width ?? '100%', height }}
      aria-hidden
    />
  )
}

interface SkeletonTextProps {
  lines?: number
  className?: string
}

export function SkeletonText({ lines = 3, className }: SkeletonTextProps) {
  return (
    <span className={cx('ui-skeleton-text', className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          height={11}
          // Taper the last line so the block reads as a paragraph.
          width={index === lines - 1 ? '62%' : `${88 - (index % 3) * 7}%`}
        />
      ))}
    </span>
  )
}

interface SkeletonCardProps {
  lines?: number
  className?: string
}

export function SkeletonCard({ lines = 3, className }: SkeletonCardProps) {
  return (
    <div className={cx('ui-skeleton-card', className)} aria-hidden>
      <div className="ui-skeleton-card__head">
        <Skeleton shape="circle" width={26} height={26} />
        <Skeleton height={11} width="38%" />
      </div>
      <SkeletonText lines={lines} />
    </div>
  )
}

interface ShimmerProps {
  className?: string
  /** Height of the sweeping band. */
  height?: number | string
}

/** Standalone shimmer band, for progress affordances without a known value. */
export function Shimmer({ className, height = 2 }: ShimmerProps) {
  return <span className={cx('ui-shimmer', className)} style={{ height }} aria-hidden />
}
