/**
 * Budget used, against how far the month has run: a 6px bar filled to
 * actual / budget, crossed by a tick at today's share of the month. A fill
 * past the tick is spending ahead of plan.
 *
 * Decorative: the percent printed above it and the tab's footnote carry the
 * same facts as text, so the bar is hidden from assistive technology. Fill
 * width and tick position are the row's own figures, hence inline style.
 */
import React from 'react';

export interface PaceBarProps {
  /** actual / budget; the fill stops at 100 %. */
  used: number;
  /** today / days in month. */
  pace: number;
}

export function PaceBar({ used, pace }: PaceBarProps): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative mt-1.5 h-1.5 bg-gray-300 dark:bg-gray-600">
      <div
        className="absolute inset-y-0 left-0 bg-gray-700 dark:bg-gray-300"
        style={{ width: `${Math.min(100, used * 100).toFixed(1)}%` }}
      />
      <div
        className="absolute -inset-y-1 w-0.5 bg-gray-900 dark:bg-gray-100"
        style={{ left: `${(pace * 100).toFixed(1)}%` }}
      />
    </div>
  );
}
