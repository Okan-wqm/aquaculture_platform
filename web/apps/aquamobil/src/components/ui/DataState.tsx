/**
 * DataState — render a Loadable without being able to show content during an error.
 *
 * The companion to src/utils/loadable.ts. Where that makes forgetting the error
 * arm a compile error, this makes handling it a one-liner, so the correct path
 * is also the shortest one — Tier 2 on top of Tier 1.
 *
 *     <DataState value={toLoadable(query)} label="units">
 *       {(units) => <UnitList units={units} />}
 *     </DataState>
 *
 * The children render-prop only ever receives real data. There is no way to
 * reach it while the query is failing, which is what five separate screens in
 * this app previously did.
 *
 * `label` is what the failure message names ("Could not load units"). It is
 * required because "Something went wrong" tells a worker on a boat nothing
 * about what they have lost or whether to retry.
 */
import { AlertTriangle } from 'lucide-react';
import { type ReactElement, type ReactNode } from 'react';

import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';

import type { Loadable } from '@/utils/loadable';

export interface DataStateProps<T> {
  value: Loadable<T>;
  /** Names what could not be loaded, lower-case: "units", "the warehouse". */
  label: string;
  /** Shape of the loading placeholder — match what the content looks like. */
  skeleton?: 'text' | 'row' | 'tile';
  skeletonCount?: number;
  /**
   * Optional: rendered instead of the children when the query succeeded but
   * returned nothing. Keeping this separate from the error state is the whole
   * point — "nothing here" and "could not load" must never look alike.
   */
  empty?: ReactNode;
  /** Decides whether ready data counts as empty. Defaults to an empty array. */
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
}

function defaultIsEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

export function DataState<T>({
  value,
  label,
  skeleton = 'row',
  skeletonCount = 3,
  empty,
  isEmpty = defaultIsEmpty,
  children,
}: DataStateProps<T>): ReactElement {
  if (value.status === 'loading') {
    return <Skeleton variant={skeleton} count={skeletonCount} />;
  }

  if (value.status === 'error') {
    return (
      <EmptyState
        tone="error"
        icon={<AlertTriangle size={22} />}
        title={`Could not load ${label}`}
        // Never "no data" — the figures are UNAVAILABLE, which is a different
        // claim and the one the app is entitled to make.
        description="This is unavailable, not empty. Anything you log is still queued on this device."
        action={
          <Button variant="primary" onClick={value.retry}>
            Try again
          </Button>
        }
      />
    );
  }

  if (empty !== undefined && isEmpty(value.data)) {
    return <>{empty}</>;
  }

  return <>{children(value.data)}</>;
}
