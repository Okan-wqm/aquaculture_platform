import { clsx } from 'clsx';
import type { ReactElement } from 'react';

/**
 * MOB-MEDIUM-008: the single "as of X ago" stamp for operational data.
 *
 * A field worker cannot act on a number they cannot date — a dissolved-oxygen
 * value from 30 seconds ago and one from yesterday look identical without an
 * age stamp. Every surface that shows operational values (tank readings, tank
 * cards, the last-synced clock) renders age through THIS component so the
 * staleness tiers mean the same thing everywhere:
 *   - fresh  (< 2 min): green — actionable as "now"
 *   - aging  (< 15 min): amber — usable, but check the connection
 *   - stale  (older): red — do NOT treat as current
 */

const FRESH_CEILING_MS = 2 * 60 * 1000;
const AGING_CEILING_MS = 15 * 60 * 1000;

export interface DataFreshnessProps {
  /** ISO timestamp of the value's origin, or null when there is no data. */
  timestamp: string | null | undefined;
  /** Optional prefix, e.g. "Synced". */
  label?: string;
  className?: string;
}

function formatAge(ageMs: number, dateStr: string): string {
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(ageMs / 3_600_000);
  const days = Math.floor(ageMs / 86_400_000);
  if (minutes < 2) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US');
}

export function DataFreshness({ timestamp, label, className }: DataFreshnessProps): ReactElement {
  if (!timestamp) {
    return (
      <span className={clsx('text-xs font-medium text-gray-400 dark:text-gray-500', className)}>
        No data
      </span>
    );
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  const tier =
    ageMs < FRESH_CEILING_MS ? 'fresh' : ageMs < AGING_CEILING_MS ? 'aging' : 'stale';

  const tierClass = {
    fresh: 'text-green-600 dark:text-green-400',
    aging: 'text-amber-600 dark:text-amber-400',
    stale: 'text-red-600 dark:text-red-400',
  }[tier];

  const ageText = formatAge(ageMs, timestamp);
  const exact = new Date(timestamp).toLocaleString('en-US');

  return (
    <span
      title={exact}
      aria-label={`${label ? `${label} ` : ''}${ageText} (${exact})`}
      className={clsx('text-xs font-medium tabular-nums', tierClass, className)}
    >
      {label ? `${label} ` : ''}
      {ageText}
    </span>
  );
}
