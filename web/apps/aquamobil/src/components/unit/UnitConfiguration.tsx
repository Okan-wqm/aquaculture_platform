/**
 * UnitConfiguration — the two values that are set once and read rarely.
 *
 * Demoted from the pre-v4 header banner: volume and max capacity never change
 * during a production cycle, so they belong beneath the numbers that change
 * every day rather than above them. Shared by the phone's unit detail and the
 * board's inspector for the same reason UnitVitals is — one pen, one answer.
 *
 * "Not configured" is stated rather than shown as a zero: a unit with no
 * configured consent capacity is a setup gap somebody has to close, and a
 * confident "0 kg max capacity" hides it.
 */
import { type ReactElement } from 'react';

import { Card } from '@/components/ui';
import type { Tank } from '@/types';
import { compactCount } from '@/utils/unit-display';

export function UnitConfiguration({ tank }: { tank: Tank }): ReactElement {
  return (
    <Card className="p-4">
      <div className="text-meta text-ink-3 mb-3">Unit configuration</div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-title font-mono font-semibold text-ink-1 tabular-nums">
            {tank.volume > 0 ? `${tank.volume}` : '—'}
          </div>
          <div className="text-meta text-ink-3">
            {tank.volume > 0 ? 'm³ volume' : 'Volume not configured'}
          </div>
        </div>
        <div>
          <div className="text-title font-mono font-semibold text-ink-1 tabular-nums">
            {tank.maxBiomass > 0 ? compactCount(tank.maxBiomass) : '—'}
          </div>
          <div className="text-meta text-ink-3">
            {tank.maxBiomass > 0 ? 'kg max capacity' : 'Capacity not configured'}
          </div>
        </div>
      </div>
    </Card>
  );
}
