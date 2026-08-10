/**
 * UnitVitals — the four numbers a shift check reads, plus density against consent.
 *
 * WHY IT IS A COMPONENT RATHER THAN PART OF A PAGE. This block was written on
 * TankDetailPage, for the phone. The tablet board's inspector shows the same
 * unit, and copying ninety lines of formatting into it would have created two
 * implementations of "what is this pen holding" that a worker can see within one
 * glance of each other on two devices in the same cabin. The unit detail page
 * and the board inspector now render the same component; there is one answer.
 *
 * WHAT IS DELIBERATELY NOT HERE: the log-entry CTA. It stays on the phone
 * screen, because the board's own rule is that entries are made standing at the
 * unit. Extracting only the READ-ONLY body is what lets that rule hold without a
 * `showLogButton` prop threading a policy decision through a presentation
 * component.
 */
import { AlertTriangle, Fish } from 'lucide-react';
import { type ReactElement } from 'react';

import { CapacityMeter, Card, EmptyState, StatTile } from '@/components/ui';
import type { Tank } from '@/types';
import { compactCount, fixedOrNone } from '@/utils/unit-display';

export function UnitVitals({ tank }: { tank: Tank }): ReactElement {
  const metrics = tank.batchMetrics;

  if (!metrics?.batchId) {
    return (
      <EmptyState
        icon={<Fish size={22} />}
        title="No active batch"
        description="Assign a batch to this unit to see biomass, density and growth."
      />
    );
  }

  // Nullable on the wire, and nullable for a REASON: both are null when the unit
  // has no configured consent capacity. See NO_VALUE in src/utils/unit-display.ts
  // for why neither is coerced to zero.
  const capacityPercent = metrics.capacityUsedPercent;
  const isOverCapacity = metrics.isOverCapacity === true;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {/* The UNIT's standing biomass, across every batch in it — shown beside
            density and capacity, which are also whole-container figures. Reading
            the primary batch here made three tiles on one screen disagree about
            one pen. */}
        <StatTile
          label="Standing biomass"
          value={(tank.currentBiomass / 1000).toFixed(1)}
          unit="t"
          caption={
            tank.currentQuantity > 0 ? `${compactCount(tank.currentQuantity)} fish` : undefined
          }
        />
        <StatTile
          label="Average weight"
          value={fixedOrNone(metrics.avgWeight, 0)}
          unit="g"
          caption={
            metrics.daysSinceStocking != null
              ? `${metrics.daysSinceStocking} d since stocking`
              : undefined
          }
        />
        <StatTile label="Density" value={fixedOrNone(metrics.density, 1)} unit="kg/m³" />
        {/* The capacity tile is the one that may turn colour, and it can only do
            so with the caption that names the threshold — the StatTile type
            enforces that pairing. */}
        {isOverCapacity && capacityPercent != null ? (
          <StatTile
            label="Capacity used"
            value={capacityPercent.toFixed(0)}
            unit="%"
            state="crit"
            caption="Over consent limit"
          />
        ) : (
          <StatTile label="Capacity used" value={fixedOrNone(capacityPercent, 0)} unit="%" />
        )}
      </div>

      {/* Density against consent gets its own meter because it is the regulated
          number: the thresholds are what make it readable. */}
      <Card className="p-4">
        {capacityPercent == null ? (
          // A meter parked at zero would claim this pen is nowhere near its
          // limit. What is actually true is that nobody told this app what the
          // limit is, so the meter says that instead of drawing a reassuring bar.
          <p className="text-body text-ink-3">
            No consent capacity is configured for this unit, so density against consent cannot be
            shown.
          </p>
        ) : (
          <CapacityMeter
            percent={capacityPercent}
            readout={`${capacityPercent.toFixed(0)}% · ${fixedOrNone(metrics.density, 1)} kg/m³`}
          />
        )}
      </Card>

      {isOverCapacity && (
        <Card className="p-3.5 flex items-center gap-3 border-crit">
          <span className="w-9 h-9 shrink-0 rounded-xl bg-crit-dim text-crit inline-flex items-center justify-center">
            <AlertTriangle size={18} />
          </span>
          <span className="text-body text-ink-1">
            This unit is over capacity. Consider harvesting or transferring.
          </span>
        </Card>
      )}
    </div>
  );
}
