import type { CSSProperties, ReactNode } from 'react';
import './Skeleton.css';

export interface SkeletonProps {
  /** Any CSS width; a percentage makes the block track its container. */
  readonly width?: string | undefined;
  readonly height?: string | undefined;
  readonly radius?: 'sm' | 'md' | 'pill' | undefined;
  readonly className?: string | undefined;
}

const RADII: Readonly<Record<'sm' | 'md' | 'pill', string>> = {
  sm: 'var(--radius-sm)',
  md: 'var(--radius-md)',
  pill: 'var(--radius-pill)',
};

/**
 * One placeholder block.
 *
 * WHY: a loading screen that has the shape of the answer keeps the layout still
 * when data lands, so the operator's eye does not have to re-find the column it
 * was reading. Spinners are not used anywhere in this console.
 */
export function Skeleton({ width = '100%', height = '12px', radius = 'sm', className }: SkeletonProps): ReactNode {
  const style: CSSProperties = { width, height, borderRadius: RADII[radius] };
  return <span className={className === undefined ? 'skeleton' : `skeleton ${className}`} style={style} />;
}

export interface SkeletonTextProps {
  readonly lines?: number | undefined;
  /** Width of the last line, which is short in real prose. */
  readonly lastLineWidth?: string | undefined;
}

export function SkeletonText({ lines = 3, lastLineWidth = '60%' }: SkeletonTextProps): ReactNode {
  return (
    <span className="skeleton-text">
      {Array.from({ length: Math.max(1, lines) }, (_unused, index) => (
        <Skeleton key={index} height="10px" width={index === lines - 1 ? lastLineWidth : '100%'} className="skeleton-text__line" />
      ))}
    </span>
  );
}
