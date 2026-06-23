import { clsx } from 'clsx';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KpiItem {
  label: string;
  value: string | number;
  ariaLabel?: string; // Screen reader description, e.g. "Tanks fed: 5 of 12"
  valueColor?: string; // Tailwind text color class override
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
 * This matches the pattern used in HomePage's quick action grid.
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
 * KpiStrip -- row of stat boxes displayed inside a HubHeader's gradient area.
 *
 * WHY: Operational KPIs (e.g., "5 of 12 tanks fed", "3 mortality events today")
 * need to be visible immediately without scrolling. Placing them inside the
 * header gradient provides at-a-glance status that field workers can read while
 * walking between tanks.
 *
 * Design: follows the exact glass-morphism pattern from HomePage's 4-column
 * stats row (bg-white/10 backdrop-blur-sm rounded-xl).
 */
export function KpiStrip({ items }: KpiStripProps): ReactElement | null {
  if (items.length === 0) return null;

  const colClass = GRID_COLS[Math.min(items.length, 4)] ?? 'grid-cols-4';

  return (
    <div className={clsx('grid gap-2.5', colClass)}>
      {items.map((item) => (
        <div
          key={item.label}
          className="bg-white/10 backdrop-blur-sm rounded-xl p-2.5 text-center"
          aria-label={item.ariaLabel ?? `${item.label}: ${item.value}`}
          role="status"
        >
          {item.isLoading ? (
            /* WHY motion-safe: respects the user's prefers-reduced-motion OS setting,
               which is common on accessibility-configured field devices. */
            <div className="h-7 w-12 mx-auto rounded bg-white/20 motion-safe:animate-pulse" />
          ) : (
            <div
              className={clsx(
                'text-xl font-bold tabular-nums',
                item.valueColor ?? 'text-white',
              )}
            >
              {item.value}
            </div>
          )}
          <div className="text-white/70 text-[10px] font-semibold mt-0.5 truncate">
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// WHY: Re-export the interface so consumers can type their KPI arrays without
// importing from this file's internals.
export type { KpiItem };
