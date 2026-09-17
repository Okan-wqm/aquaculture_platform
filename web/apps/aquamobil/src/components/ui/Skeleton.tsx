/**
 * Skeleton — the loading placeholder.
 *
 * Shaped like the content it replaces, so the layout does not jump when data
 * lands. The pre-v4 app hand-rolled a different skeleton per page
 * (ChannelListSkeleton, ChecklistSkeleton, MetricSkeleton); this replaces the
 * shared parts of all of them.
 *
 * The shimmer comes from the `.skeleton` class in src/styles/main.css, which is
 * now token-driven and therefore follows the active theme.
 */
import { clsx } from 'clsx';
import { type ReactElement } from 'react';

export interface SkeletonProps {
  /** `text` = a single line; `row` = a list row; `tile` = a metric card. */
  variant?: 'text' | 'row' | 'tile';
  /** Repeat count for list-shaped skeletons. */
  count?: number;
  className?: string;
}

export function Skeleton({ variant = 'text', count = 1, className }: SkeletonProps): ReactElement {
  const shape = {
    text: 'h-4 rounded-lg',
    row: 'h-16 rounded-2xl',
    tile: 'h-24 rounded-2xl',
  }[variant];

  return (
    // aria-hidden + a live-region-free wrapper: a screen reader should hear the
    // real content when it arrives, not a stream of "loading" placeholders.
    <div className={clsx('flex flex-col gap-2', className)} aria-hidden data-testid="skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={clsx('skeleton w-full', shape)} />
      ))}
    </div>
  );
}
