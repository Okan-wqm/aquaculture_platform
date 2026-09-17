/**
 * StatTile — one metric, stated as a hero number.
 *
 * The v4 unit detail is four of these (oxygen, temperature, biomass, mortality)
 * and the reports header is three. It is deliberately NOT a chart: a single
 * current value's job is to be read instantly, and a plot around it would add
 * ink without adding an answer. The optional `spark` slot carries drift, which
 * is the only extra question the number itself cannot answer.
 *
 * The value is set in mono at 700 — "hero numerals at 700 mono" — so digits are
 * tabular and two tiles side by side line up on the decimal point.
 *
 * Colour discipline: the value wears an ink token unless `state` says otherwise,
 * and a non-neutral state REQUIRES `caption` (e.g. "Limit 0.30 %"). A number
 * that turns coral with nothing to explain the threshold is colour-alone, and a
 * colourblind worker reads it as an ordinary value.
 */
import { clsx } from 'clsx';
import { type ReactElement, type ReactNode } from 'react';

import { Card } from './Card';

type TileState = 'neutral' | 'warn' | 'crit';

interface StatTileBase {
  /** What the number is, e.g. "Dissolved oxygen". */
  label: string;
  /** The number itself, pre-formatted by the caller (it owns the precision). */
  value: ReactNode;
  /** Unit shown beside the value at a smaller size, e.g. "mg/L". */
  unit?: string;
  /** Drift plot — a <SparkBars/>, or omitted. */
  spark?: ReactNode;
  className?: string;
}

/**
 * `state` and `caption` are coupled on purpose: a threshold breach must always
 * be readable without colour, so the type system refuses the colour-only case.
 */
type StatTileProps = StatTileBase &
  (
    | { state?: 'neutral'; caption?: string }
    | { state: Exclude<TileState, 'neutral'>; caption: string }
  );

const VALUE_CLASS: Record<TileState, string> = {
  neutral: 'text-ink-1',
  warn: 'text-warn',
  crit: 'text-crit',
};

export function StatTile({
  label,
  value,
  unit,
  spark,
  state = 'neutral',
  caption,
  className,
}: StatTileProps): ReactElement {
  return (
    <Card className={clsx('p-3 flex flex-col gap-2', className)}>
      <span className="text-meta text-ink-3">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className={clsx('font-mono font-bold text-display tabular-nums', VALUE_CLASS[state])}>
          {value}
        </span>
        {unit !== undefined && <span className="text-meta text-ink-3">{unit}</span>}
      </span>
      {spark}
      {caption !== undefined && <span className="text-meta text-ink-3">{caption}</span>}
    </Card>
  );
}
