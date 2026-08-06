/**
 * CapacityMeter — stocking density against the site's consent limit.
 *
 * A regulated quantity, so the meter's job is not "how full" but "how close to
 * the number a regulator will ask about". That is why the scale is segmented
 * rather than a smooth bar: discrete blocks read as a gauge against thresholds,
 * where a continuous fill invites reading it as a simple percentage.
 *
 * Thresholds are ALWAYS labelled under the track ("70 watch", "90 limit"), so a
 * meter in the amber or coral band is never colour-alone — the tick captions say
 * where the bands are whether or not the reader can distinguish the hues.
 *
 * Mark spec: a 2px surface gap between segments so the blocks never merge, and
 * unfilled segments keep a visible track rather than disappearing.
 */
import { clsx } from 'clsx';
import { type ReactElement } from 'react';

export interface CapacityMeterProps {
  /** Current utilisation, 0–100+. Values above 100 clamp the fill but keep the label honest. */
  percent: number;
  /** Amber band start. Default 70 matches the v4 design's watch threshold. */
  watchAt?: number;
  /** Coral band start — the consent limit. Default 90. */
  limitAt?: number;
  /** Right-hand readout, e.g. "93% · 28.4 kg/m³". Caller formats it. */
  readout?: string;
  segments?: number;
  className?: string;
}

export function CapacityMeter({
  percent,
  watchAt = 70,
  limitAt = 90,
  readout,
  segments = 20,
  className,
}: CapacityMeterProps): ReactElement {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * segments);

  // The band is decided by the VALUE, not by each segment, so the whole meter
  // reads as one state instead of a gradient the eye has to interpret.
  const band = percent >= limitAt ? 'crit' : percent >= watchAt ? 'warn' : 'ok';
  const fillClass = { ok: 'bg-acc', warn: 'bg-warn', crit: 'bg-crit' }[band];

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-meta text-ink-3">Density against consent</span>
        {readout !== undefined && (
          <span className="text-meta font-mono text-ink-2 tabular-nums">{readout}</span>
        )}
      </div>
      <div
        className="flex gap-0.5 h-2"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Stocking density ${Math.round(percent)} percent of consent; watch at ${watchAt}, limit at ${limitAt}`}
      >
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={clsx('flex-1 rounded-[2px]', i < filled ? fillClass : 'bg-surface-3')}
          />
        ))}
      </div>
      {/* The thresholds in words — this is what keeps the bands from being
          colour-alone, so it is not optional decoration. */}
      <div className="flex justify-between text-meta font-mono text-ink-3">
        <span>0</span>
        <span>{watchAt} watch</span>
        <span>{limitAt} limit</span>
      </div>
    </div>
  );
}
