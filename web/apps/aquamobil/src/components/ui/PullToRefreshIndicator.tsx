/**
 * PullToRefreshIndicator — the layout's pull-down feedback: grows with the
 * finger, flips its arrow once the pull is armed, spins while refetching.
 */
import { ArrowDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { Spinner } from './Spinner';

export interface PullToRefreshIndicatorProps {
  pullDistance: number;
  armed: boolean;
  isRefreshing: boolean;
}

const REFRESHING_HEIGHT_PX = 40;

export function PullToRefreshIndicator({
  pullDistance,
  armed,
  isRefreshing,
}: PullToRefreshIndicatorProps): ReactNode {
  const height = isRefreshing ? REFRESHING_HEIGHT_PX : pullDistance;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-end justify-center overflow-hidden text-xs font-medium text-gray-500 dark:text-gray-400 transition-[height] duration-150"
      style={{ height }}
    >
      {isRefreshing ? (
        <Spinner size="sm" text="Refreshing…" className="pb-2" />
      ) : pullDistance > 0 ? (
        <span className="flex items-center gap-1.5 pb-2">
          <ArrowDown
            size={14}
            className={armed ? 'rotate-180 transition-transform' : 'transition-transform'}
            aria-hidden
          />
          {armed ? 'Release to refresh' : 'Pull to refresh'}
        </span>
      ) : null}
    </div>
  );
}
