import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActivityItem {
  id: string;
  icon: LucideIcon;
  iconColor: string; // Tailwind text color, e.g. "text-red-500"
  iconBg: string; // Tailwind bg color, e.g. "bg-red-50 dark:bg-red-900/20"
  title: string;
  subtitle?: string;
  timestamp: string; // ISO 8601 date string
}

interface ActivityListProps {
  title: string;
  items: ActivityItem[];
  emptyMessage: string;
  isLoading?: boolean;
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY custom relative time: We avoid pulling in a date-fns / dayjs dependency
 * for a single formatting function. The Intl.RelativeTimeFormat API is supported
 * by all modern mobile browsers (Safari 14+, Chrome 71+) and produces
 * locale-aware output like "2 hours ago" or "yesterday".
 */
function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  // WHY: Guard against future timestamps from clock skew on field devices.
  if (diffMs < 0) return 'just now';

  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  // WHY: Beyond 7 days, show a short date rather than "14d ago" which loses
  // meaning. The short month+day format is universally readable.
  return new Date(isoDate).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Skeleton loading rows -- 3 rows matching the item height for layout stability. */
function LoadingSkeleton(): ReactElement {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading activity">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-14 rounded-xl skeleton" />
      ))}
    </div>
  );
}

/** Empty state -- icon + message, following the existing empty state pattern. */
function EmptyState({ message }: { message: string }): ReactElement {
  return (
    <div className="text-center py-8 text-gray-400 dark:text-gray-500">
      <Inbox size={36} className="mx-auto mb-2 opacity-30" />
      <p className="text-sm font-medium">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * ActivityList -- recent activity feed for hub pages.
 *
 * WHY: Hub pages need a "what happened recently" section so workers can see
 * at a glance what was recorded today (e.g., last 5 mortality events, recent
 * feeding records). This shared component provides consistent layout, loading,
 * and empty states across all 4 hub pages.
 *
 * WHY maxItems default 5: Mobile screens are ~812px tall minus header (~180px)
 * and tab bar (~64px). Five items at ~56px each fill the remaining space without
 * requiring a scroll, keeping the most recent activity visible at a glance.
 */
export function ActivityList({
  title,
  items,
  emptyMessage,
  isLoading = false,
  maxItems = 5,
}: ActivityListProps): ReactElement {
  const displayItems = items.slice(0, maxItems);

  return (
    <section aria-label={title}>
      <h2 className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
        {title}
      </h2>

      {isLoading ? (
        <LoadingSkeleton />
      ) : displayItems.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="space-y-2">
          {displayItems.map((item) => {
            const Icon = item.icon;
            return (
              <li
                key={item.id}
                className="bg-white dark:bg-gray-900 rounded-xl shadow-card border border-gray-100 dark:border-gray-800 p-3 flex items-center gap-3"
              >
                {/* WHY: Colored icon badge provides instant visual categorization
                    (red = mortality, green = feeding, blue = water quality) without
                    reading the text -- important for quick scanning. */}
                <div
                  className={clsx(
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    item.iconBg,
                  )}
                >
                  <Icon size={18} className={item.iconColor} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                    {item.title}
                  </p>
                  {item.subtitle && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {item.subtitle}
                    </p>
                  )}
                </div>
                <time
                  dateTime={item.timestamp}
                  className="text-xs text-gray-400 dark:text-gray-500 tabular-nums flex-shrink-0"
                >
                  {formatRelativeTime(item.timestamp)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type { ActivityItem };
