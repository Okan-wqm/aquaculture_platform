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
 *   - fresh  (< 2 min): ok token — actionable as "now"
 *   - aging  (< 15 min): warn token — usable, but check the connection
 *   - stale  (older): crit token — do NOT treat as current
 *
 * v4: the tiers wear the semantic tokens rather than a green/amber/red ramp
 * with a per-theme twin each, so one class per tier is correct in night, day
 * and colour. The tier MEANINGS are unchanged — this stamp is the only place
 * the app says how old a number is, and softening it would be a safety
 * regression.
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
    return <span className={clsx('text-meta font-medium text-ink-3', className)}>No data</span>;
  }

  const ageMs = Date.now() - new Date(timestamp).getTime();
  const tier = ageMs < FRESH_CEILING_MS ? 'fresh' : ageMs < AGING_CEILING_MS ? 'aging' : 'stale';

  const tierClass = {
    fresh: 'text-ok',
    aging: 'text-warn',
    stale: 'text-crit',
  }[tier];

  const ageText = formatAge(ageMs, timestamp);
  const exact = new Date(timestamp).toLocaleString('en-US');

  return (
    <span
      title={exact}
      aria-label={`${label ? `${label} ` : ''}${ageText} (${exact})`}
      className={clsx('text-meta font-medium font-mono tabular-nums', tierClass, className)}
    >
      {label ? `${label} ` : ''}
      {ageText}
    </span>
  );
}
