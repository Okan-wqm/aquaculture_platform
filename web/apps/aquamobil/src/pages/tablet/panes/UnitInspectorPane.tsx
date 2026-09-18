/**
 * UnitInspectorPane — the board's right column: the selected unit, in full.
 *
 * It is the phone's unit detail MINUS its one action. Same vitals, same consent
 * meter, same live water values, same advisory cards — rendered from the same
 * components, so the cabin and the handheld cannot disagree about a pen. What is
 * absent is the "Log entry" button and the log sheet behind it, because the
 * board's own footer says entries are made standing at the unit. Leaving the CTA
 * here would make that line decoration.
 *
 * IT DOES NOT NAVIGATE. The unit arrives as `?unit=<id>` on the board's own
 * route (src/pages/tablet/useSelectedUnit.ts), so filling this column costs no
 * route change and the other two columns keep watching while somebody inspects.
 *
 * PERMISSIONS: nothing here is gated on the phone either — `/tank/:tankId` is an
 * ungated route in App.tsx, the AI cards return null when the AI surface is off,
 * and LiveReadingsCard reads sensors any field role may read. The board exposes
 * no surface a role cannot already reach.
 */
import { AlertTriangle, LayoutGrid } from 'lucide-react';
import { type ReactElement } from 'react';

import { FeedingAdviceCard, GrowthPredictionCard, TankRiskBadge } from '@/components/ai';
import { LiveReadingsCard } from '@/components/LiveReadingsCard';
import { Button, Chip, DataState, EmptyState, StatusDot } from '@/components/ui';
import { UnitConfiguration, UnitVitals } from '@/components/unit';
import { useTanks } from '@/hooks/useTanks';
import { useSelectedUnit } from '@/pages/tablet/useSelectedUnit';
import type { Tank } from '@/types';
import { toLoadable } from '@/utils/loadable';
import { unitStatusMeta } from '@/utils/unit-display';

export function UnitInspectorPane(): ReactElement {
  const { selectedUnitId, selectUnit } = useSelectedUnit();
  const units = toLoadable(useTanks());

  if (selectedUnitId === null) {
    return (
      <EmptyState
        icon={<LayoutGrid size={22} />}
        title="No unit selected"
        description="Choose a unit in the grid to inspect it here."
      />
    );
  }

  return (
    <DataState value={units} label="units" skeleton="tile" skeletonCount={3}>
      {(tanks) => {
        const tank = tanks.find((candidate) => candidate.id === selectedUnitId);

        if (!tank) {
          // Reachable ONLY on the ready arm — DataState will not run this
          // render-prop during a failure, which is what keeps "we could not
          // fetch the unit list" from being reported as "this unit is not in
          // your inventory". That exact substitution is the defect this app has
          // now found seven times (src/utils/loadable.ts).
          return (
            <EmptyState
              icon={<AlertTriangle size={22} />}
              title="Unit not in this list"
              description="This unit is not in the current inventory. It may belong to another site, or the list may be stale."
              action={
                <Button variant="primary" onClick={() => selectUnit(null)}>
                  Clear selection
                </Button>
              }
            />
          );
        }

        return <UnitDetail key={tank.id} tank={tank} />;
      }}
    </DataState>
  );
}

/**
 * The unit itself. Every block below is the component the phone's detail screen
 * renders — this pane composes them, it does not re-implement them.
 */
function UnitDetail({ tank }: { tank: Tank }): ReactElement {
  const status = unitStatusMeta(tank.status);
  const batchId = tank.batchMetrics?.batchId;

  return (
    <div className="flex flex-col gap-4">
      {/* The phone puts this in AppHeader; the board's region heading already
          says "Selected unit", so the identity line sits inside the column
          rather than competing with the shell's top bar. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-head font-mono font-semibold text-ink-1">
            {tank.code || tank.name}
          </h3>
          {tank.code !== '' && <p className="truncate text-body text-ink-3">{tank.name}</p>}
        </div>
        <Chip tone={status.tone}>
          <StatusDot tone={status.tone} live={tank.status === 'ACTIVE'} />
          {status.label}
        </Chip>
      </div>

      <UnitVitals tank={tank} />

      {/* MOB-MEDIUM-008: measured water values, each with its own freshness
          stamp. It sits ABOVE the advisory cards deliberately — measurement
          first, then the model's reading of it. */}
      <LiveReadingsCard tankId={tank.id} />

      {/* Advisory intelligence. Each card carries its own <AdvisoryChip/> and
          tilde (ORPHAN-MEDIUM-589) so a forecast sitting under measured sensor
          values still reads as a forecast, and each returns null when the AI
          surface is disabled or unreachable. */}
      <div className="flex flex-col gap-3">
        <TankRiskBadge tankId={tank.id} />
        {batchId != null && <GrowthPredictionCard batchId={batchId} />}
        <FeedingAdviceCard tankId={tank.id} />
      </div>

      <UnitConfiguration tank={tank} />
    </div>
  );
}

export default UnitInspectorPane;
