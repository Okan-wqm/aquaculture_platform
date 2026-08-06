/**
 * StockEventsHubPage -- Enterprise stock events hub with batch metrics,
 * recent event feed, and quick actions for culling, harvest, and transfer.
 *
 * WHY a dedicated hub: Stock events (cull, harvest, transfer, mortality) are
 * lifecycle operations that happen less frequently than daily ops but carry
 * higher consequence (incorrect batch quantities cascade to biomass calculations,
 * feed plans, and harvest projections). The hub provides a 7-day event feed so
 * workers can verify recent entries before recording new ones, reducing the
 * "accidental double-entry" error rate observed in field testing.
 */

import { clsx } from 'clsx';
import {
  Package,
  Scissors,
  ArrowLeftRight,
  Skull,
} from 'lucide-react';
import type { JSX } from 'react';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { HubHeader, KpiStrip, QuickActionGrid } from '@/components/hub';
import type { KpiItem } from '@/components/hub';
import { EmptyState, ListRow, Skeleton, type RowTone } from '@/components/ui';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useStockEventsSummary } from '@/hooks/useStockEventsSummary';
import type { StockEvent } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * WHY typed event config: Each stock event type has a unique icon, tone, and
 * label. A static lookup avoids a switch statement in the render and ensures
 * Tailwind's PurgeCSS sees all class literals.
 *
 * v4: the four hand-mixed palettes (red/amber/violet/blue, each with a light and
 * a dark variant per surface) collapse onto the per-log-type hues, which are the
 * one place the design lets colour be decorative — a worker identifies an entry
 * type by hue before reading it, and these six are validated as discriminable
 * under the common colour-vision deficiencies. The label is still always drawn.
 */
const EVENT_TYPE_CONFIG: Record<StockEvent['type'], {
  icon: typeof Package;
  tone: RowTone;
  badge: string;
  label: string;
}> = {
  MORTALITY: {
    icon: Skull,
    tone: 'mortality',
    badge: 'bg-type-mortality-dim text-type-mortality',
    label: 'Mortality',
  },
  CULL: {
    icon: Scissors,
    tone: 'cull',
    badge: 'bg-type-cull-dim text-type-cull',
    label: 'Cull',
  },
  HARVEST: {
    icon: Package,
    tone: 'harvest',
    badge: 'bg-type-harvest-dim text-type-harvest',
    label: 'Harvest',
  },
  TRANSFER: {
    icon: ArrowLeftRight,
    tone: 'transfer',
    badge: 'bg-type-transfer-dim text-type-transfer',
    label: 'Transfer',
  },
};

/** Maximum events displayed in the recent events list. */
const MAX_EVENTS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY custom relative time: Avoids a date library dependency for a single
 * formatting call. Same approach as ActivityList component.
 */
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Loading skeleton for the event list. */
function EventListSkeleton(): JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading events">
      <Skeleton variant="row" count={3} />
    </div>
  );
}

/**
 * Single event row: type-hued icon tile, type badge + unit, quantity, and the
 * time it was recorded.
 *
 * NOT a bare <ListRow>: the row carries a type BADGE beside the unit name, and
 * ListRow's `title` truncates a single line — folding the badge in would push the
 * unit name out of view on the narrow screens this list is read on. The badge is
 * therefore composed into the title slot deliberately, with the unit name given
 * the remaining width.
 */
function EventRow({ event }: { event: StockEvent }): JSX.Element {
  const config = EVENT_TYPE_CONFIG[event.type];
  const Icon = config.icon;

  return (
    <li>
      <ListRow
        leading={<Icon size={18} />}
        tone={config.tone}
        title={
          <span className="flex items-center gap-2 min-w-0">
            <span
              className={clsx(
                'text-meta font-semibold px-2 py-0.5 rounded-full shrink-0',
                config.badge,
              )}
            >
              {config.label}
            </span>
            <span className="truncate">{event.tankName}</span>
          </span>
        }
        subtitle={`${event.quantity} fish`}
        trailing={
          <time dateTime={event.createdAt} className="font-mono tabular-nums">
            {formatRelativeTime(event.createdAt)}
          </time>
        }
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function StockEventsHubPage(): JSX.Element {
  const { isOnline } = useOfflineQueue();
  const { summary, isLoading } = useStockEventsSummary();

  const activeBatchCount = summary?.activeBatchCount ?? 0;
  const thisWeekEventsCount = summary?.thisWeekEventsCount ?? 0;
  const recentTransferCount = summary?.recentTransferCount ?? 0;
  const recentEvents = (summary?.recentEvents ?? []).slice(0, MAX_EVENTS);

  const kpiItems: KpiItem[] = [
    {
      label: 'Batches',
      value: activeBatchCount,
      ariaLabel: `${activeBatchCount} active batches`,
      isLoading,
    },
    {
      label: 'This Week',
      value: thisWeekEventsCount,
      ariaLabel: `${thisWeekEventsCount} stock events this week`,
      isLoading,
    },
    {
      label: 'Transfers',
      value: recentTransferCount,
      ariaLabel: `${recentTransferCount} recent transfers`,
      isLoading,
    },
  ];

  return (
    <ErrorBoundary fallbackTitle="Stock Events Error">
      <div>
        <HubHeader title="Stock Events" icon={Package}>
          <KpiStrip items={kpiItems} />
        </HubHeader>

        <main className="px-4 space-y-5">
          {!isOnline && (
            <p className="text-center text-warn text-meta font-medium">Data may be outdated</p>
          )}

          {/* Quick Actions */}
          <section aria-label="Quick actions">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">Quick Actions</h2>
            <QuickActionGrid
              actions={[
                {
                  feature: 'cull',
                  path: '/cull/record',
                  icon: Scissors,
                  label: 'Culling',
                  tone: 'cull',
                },
                {
                  feature: 'harvest',
                  path: '/harvest/record',
                  icon: Package,
                  label: 'Harvest',
                  tone: 'harvest',
                },
                {
                  feature: 'transfer',
                  path: '/transfer/record',
                  icon: ArrowLeftRight,
                  label: 'Transfer',
                  tone: 'transfer',
                },
              ]}
            />
          </section>

          {/* Recent Events List */}
          <section aria-label="Recent stock events">
            <h2 className="text-body font-semibold text-ink-3 mb-2 px-1">
              Recent Events (7 Days)
            </h2>

            {isLoading ? (
              <EventListSkeleton />
            ) : recentEvents.length === 0 ? (
              <EmptyState
                icon={<Package size={22} />}
                title="No stock events this week"
                className="py-8"
              />
            ) : (
              <ul className="space-y-2">
                {recentEvents.map((event: StockEvent) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ul>
            )}
          </section>
        </main>

        {/* WHY: Bottom spacer prevents content from hiding behind the fixed tab bar. */}
        <div className="h-24" />
      </div>
    </ErrorBoundary>
  );
}
