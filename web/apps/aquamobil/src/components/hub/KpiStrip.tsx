import { clsx } from 'clsx';
import type { ReactElement } from 'react';

import { Card } from '@/components/ui';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KpiItem {
  label: string;
  value: string | number;
  ariaLabel?: string; // Screen reader description, e.g. "Tanks fed: 5 of 12"
  /**
   * Semantic token class for the value, e.g. `text-ok` / `text-warn`.
   * Omit for the default ink. Raw palette classes do not belong here — the
   * strip has to read correctly in all three themes.
   */
  valueColor?: string;
  isLoading?: boolean;
}

interface KpiStripProps {
  items: KpiItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * WHY static grid-cols lookup: Tailwind's JIT compiler cannot detect dynamically
 * constructed class strings like `grid-cols-${n}`. A static map ensures all used
 * grid column classes appear verbatim in the source and survive PurgeCSS.
 */
const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * KpiStrip -- row of stat tiles displayed under a HubHeader's title row.
 *
 * WHY: Operational KPIs (e.g., "5 of 12 tanks fed", "3 mortality events today")
 * need to be visible immediately without scrolling. Keeping them in the header
 * area provides at-a-glance status that field workers can read while walking
 * between tanks.
 *
 * v4: these were `bg-white/10 backdrop-blur-sm` glass tiles, which only read as
 * tiles because a gradient sat behind them — HubHeader no longer has one, so
 * translucent white on the page ground was about to become invisible. They are
 * now ordinary surface cards, and the label moved off a 10px translucent-white
 * class (unreadable at arm's length in sunlight, and white-on-nothing in the day
 * theme) onto `text-meta text-ink-3`.
 *
 * NOT StatTile: that primitive is a full-width hero metric and carries no
 * loading state or per-tile accessible name, and this strip needs both.
 */
export function KpiStrip({ items }: KpiStripProps): ReactElement | null {
  if (items.length === 0) return null;

  const colClass = GRID_COLS[Math.min(items.length, 4)] ?? 'grid-cols-4';

  return (
    <div className={clsx('grid gap-2', colClass)}>
      {items.map((item) => (
        <Card
          key={item.label}
          className="p-2.5 text-center"
          aria-label={item.ariaLabel ?? `${item.label}: ${item.value}`}
          role="status"
        >
          {item.isLoading ? (
            /* The shared shimmer is already theme-aware and stops under
               prefers-reduced-motion via the global rule in main.css. */
            <div className="h-7 w-12 mx-auto rounded-lg skeleton" aria-hidden />
          ) : (
            <div
              className={clsx(
                'text-head font-mono font-bold tabular-nums',
                item.valueColor ?? 'text-ink-1',
              )}
            >
              {item.value}
            </div>
          )}
          <div className="text-meta font-semibold text-ink-3 mt-0.5 truncate">{item.label}</div>
        </Card>
      ))}
    </div>
  );
}

// WHY: Re-export the interface so consumers can type their KPI arrays without
// importing from this file's internals.
export type { KpiItem };
