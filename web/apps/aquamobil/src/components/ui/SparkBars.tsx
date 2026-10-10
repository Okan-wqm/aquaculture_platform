/**
 * SparkBars — the 14-bar micro-history under a metric tile.
 *
 * Answers one question: "is this reading drifting, and which way?" It is not a
 * chart you read values off — there is no axis, and the tile above it carries
 * the current number. That is deliberate: at arm's length on a pen edge, a shape
 * is legible where tick labels are not.
 *
 * Mark spec: thin bars anchored to a common baseline, rounded data-end only, a
 * 2px surface gap between bars so adjacent values never merge into one block.
 *
 * A bar that breaches the limit takes the alarm colour, but the breach is NEVER
 * signalled by colour alone — `limitLabel` is required whenever `limit` is set,
 * and the tile renders it as text beside the plot.
 */
import { clsx } from 'clsx';
import { type ReactElement } from 'react';

export interface SparkBarsProps {
  /** Oldest → newest. Fewer than `slots` values render as leading gaps. */
  values: ReadonlyArray<number | null>;
  /** Fixed slot count so tiles line up across a grid even with partial history. */
  slots?: number;
  /**
   * Optional threshold. `below` = a reading UNDER the limit is the alarm
   * (dissolved oxygen); `above` = a reading OVER it is (mortality, density).
   */
  limit?: { value: number; direction: 'below' | 'above'; label: string };
  /** Names the series for assistive tech, e.g. "Dissolved oxygen, last 12 hours". */
  label: string;
  className?: string;
}

export function SparkBars({
  values,
  slots = 14,
  limit,
  label,
  className,
}: SparkBarsProps): ReactElement {
  // Pad from the left so a short history stays right-aligned to "now".
  const padded: Array<number | null> = [
    ...Array<null>(Math.max(0, slots - values.length)).fill(null),
    ...values.slice(-slots),
  ];

  const present = padded.filter((v): v is number => v !== null);
  // A flat series would divide by zero; give it a nominal span so bars render
  // at a readable mid height instead of collapsing to the baseline.
  const max = present.length ? Math.max(...present) : 1;
  const min = present.length ? Math.min(...present) : 0;
  const span = max - min || Math.abs(max) || 1;

  const breaches = (v: number): boolean =>
    limit !== undefined && (limit.direction === 'below' ? v < limit.value : v > limit.value);

  return (
    <div
      className={clsx('flex items-end gap-0.5 h-8', className)}
      role="img"
      aria-label={
        present.length
          ? `${label}. ${present.length} readings, ranging ${min} to ${max}.`
          : `${label}. No readings.`
      }
    >
      {padded.map((v, i) => {
        if (v === null) {
          // A gap is a real state — no reading — and must not look like zero.
          return <span key={i} className="flex-1 h-1 rounded-t-[4px] bg-line" aria-hidden />;
        }
        // Floor at 12% so the smallest reading is still a visible mark.
        const pct = 12 + ((v - min) / span) * 88;
        return (
          <span
            key={i}
            aria-hidden
            style={{ height: `${pct}%` }}
            className={clsx('flex-1 rounded-t-[4px]', breaches(v) ? 'bg-crit' : 'bg-acc')}
          />
        );
      })}
    </div>
  );
}
