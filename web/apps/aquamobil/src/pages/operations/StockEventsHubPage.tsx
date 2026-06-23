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
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useStockEventsSummary } from '@/hooks/useStockEventsSummary';
import type { StockEvent } from '@/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * WHY typed event config: Each stock event type has a unique icon, color, and
 * label. A static lookup avoids a switch statement in the render and ensures
 * Tailwind's PurgeCSS sees all class literals.
 */
const EVENT_TYPE_CONFIG: Record<StockEvent['type'], {
  icon: typeof Package;
  borderColor: string;
  badgeBg: string;
  badgeText: string;
  iconColor: string;
  iconBg: string;
  label: string;
}> = {
  MORTALITY: {
    icon: Skull,
    borderColor: 'border-l-red-500',
    badgeBg: 'bg-red-100 dark:bg-red-900/30',
    badgeText: 'text-red-700 dark:text-red-300',
    iconColor: 'text-red-500',
    iconBg: 'bg-red-50 dark:bg-red-900/20',
    label: 'Mortality',
  },
  CULL: {
    icon: Scissors,
    borderColor: 'border-l-amber-500',
    badgeBg: 'bg-amber-100 dark:bg-amber-900/30',
    badgeText: 'text-amber-700 dark:text-amber-300',
    iconColor: 'text-amber-500',
    iconBg: 'bg-amber-50 dark:bg-amber-900/20',
    label: 'Cull',
  },
  HARVEST: {
    icon: Package,
    borderColor: 'border-l-violet-500',
    badgeBg: 'bg-violet-100 dark:bg-violet-900/30',
    badgeText: 'text-violet-700 dark:text-violet-300',
    iconColor: 'text-violet-500',
    iconBg: 'bg-violet-50 dark:bg-violet-900/20',
    label: 'Harvest',
  },
  TRANSFER: {
    icon: ArrowLeftRight,
    borderColor: 'border-l-blue-500',
    badgeBg: 'bg-blue-100 dark:bg-blue-900/30',
    badgeText: 'text-blue-700 dark:text-blue-300',
    iconColor: 'text-blue-500',
    iconBg: 'bg-blue-50 dark:bg-blue-900/20',
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
    <div className="space-y-2" aria-busy="true" aria-label="Loading events">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 rounded-xl skeleton" />
      ))}
    </div>
  );
}

/** Single event row with colored left border and type badge. */
function EventRow({ event }: { event: StockEvent }): JSX.Element {
  const config = EVENT_TYPE_CONFIG[event.type];
  const Icon = config.icon;

  return (
    <li
      className={clsx(
        'bg-white dark:bg-gray-900 rounded-xl shadow-card',
        'border border-gray-100 dark:border-gray-800',
        'border-l-4 p-3 flex items-center gap-3',
        config.borderColor,
      )}
    >
      {/* WHY: Colored icon badge provides instant type identification. */}
      <div
        className={clsx(
          'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
          config.iconBg,
        )}
      >
        <Icon size={18} className={config.iconColor} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={clsx(
              'text-[10px] font-bold px-1.5 py-0.5 rounded-full uppercase',
              config.badgeBg,
              config.badgeText,
            )}
          >
            {config.label}
          </span>
          <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
            {event.tankName}
          </span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {event.quantity} fish
        </p>
      </div>

      <time
        dateTime={event.createdAt}
        className="text-xs text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0"
      >
        {formatRelativeTime(event.createdAt)}
      </time>
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
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <HubHeader
          title="Stock Events"
          icon={Package}
          gradient="from-purple-700 via-purple-600 to-violet-500"
        >
          <KpiStrip items={kpiItems} />
        </HubHeader>

        <main className="px-5 pt-4 space-y-5">
          {!isOnline && (
            <p className="text-center text-amber-500 dark:text-amber-400 text-xs font-medium">
              Data may be outdated
            </p>
          )}

          {/* Quick Actions */}
          <section aria-label="Quick actions">
            <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Quick Actions
            </h2>
            <QuickActionGrid
              actions={[
                {
                  feature: 'cull',
                  path: '/cull/record',
                  icon: Scissors,
                  label: 'Culling',
                  gradient: 'from-amber-500 to-amber-600',
                },
                {
                  feature: 'harvest',
                  path: '/harvest/record',
                  icon: Package,
                  label: 'Harvest',
                  gradient: 'from-violet-500 to-violet-600',
                },
                {
                  feature: 'transfer',
                  path: '/transfer/record',
                  icon: ArrowLeftRight,
                  label: 'Transfer',
                  gradient: 'from-blue-500 to-blue-600',
                },
              ]}
            />
          </section>

          {/* Recent Events List */}
          <section aria-label="Recent stock events">
            <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
              Recent Events (7 Days)
            </h2>

            {isLoading ? (
              <EventListSkeleton />
            ) : recentEvents.length === 0 ? (
              <div className="text-center py-8 text-gray-400 dark:text-gray-500">
                <Package size={36} className="mx-auto mb-2 opacity-30" />
                <p className="text-sm font-medium">No stock events this week</p>
              </div>
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
