/**
 * UnitGridPane — the board's middle column: every unit, as a grid.
 *
 * WHY A GRID AND NOT THE PHONE'S LIST. The extra width is the entire reason this
 * screen exists. The phone shows one unit per row because a thumb scrolls a
 * column; a cabin tablet can hold a whole site on screen at once, and a site
 * held on screen at once is a site somebody can WATCH. Reduced to a list, the
 * board would be a phone screen stretched across a wall.
 *
 * The columns are `auto-fill`, not a breakpoint ladder: this pane sits in the
 * board's elastic middle track, which is ~190px on the narrowest board viewport
 * and ~470px on a 1280px cabin tablet. One `minmax(150px, 1fr)` covers that
 * whole range and degrades to a single column at the bottom of it, so no second
 * threshold has to be invented and kept in step with the shell's.
 *
 * SELECTING IS NOT NAVIGATING. A cell writes the unit into the board's URL via
 * useSelectedUnit(); the inspector on the right reads it. Nothing unmounts, and
 * a cabin display left running comes back to the same unit after a reload.
 *
 * NO LOG ACTIONS HERE, by design — see the board's footer line. A cell selects
 * and nothing else.
 */
import { clsx } from 'clsx';
import { Boxes } from 'lucide-react';
import { type ReactElement } from 'react';

import { Card, DataState, EmptyState, StatusDot } from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import { useSelectedUnit } from '@/pages/tablet/useSelectedUnit';
import type { Tank } from '@/types';
import { toLoadable } from '@/utils/loadable';
import { compactCount, fixedOrNone, groupUnitsBySite, unitStatusMeta } from '@/utils/unit-display';

export function UnitGridPane(): ReactElement {
  // The phone's query, unchanged and shared: React Query dedupes it with the
  // top bar's and the inspector's, so three readers cost one fetch.
  const units = toLoadable(useTanks());
  const { selectedUnitId, selectUnit } = useSelectedUnit();

  return (
    <DataState
      value={units}
      label="units"
      skeleton="tile"
      skeletonCount={6}
      empty={
        <EmptyState
          icon={<Boxes size={22} />}
          title="No units"
          description="No stocked units are assigned to this tenant yet."
        />
      }
    >
      {(tanks) => (
        <div className="flex flex-col gap-4">
          {groupUnitsBySite(tanks).map((group) => (
            <section key={group.siteId} className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between px-1">
                {/* h3: the region's own label is the h2 above it, so the site
                    headings nest under it instead of competing with it. */}
                <h3 className="text-body font-semibold text-ink-3">{group.label}</h3>
                <span className="text-meta font-mono text-ink-3 tabular-nums">
                  {group.units.length}
                </span>
              </div>
              <div className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
                {group.units.map((tank) => (
                  <UnitCell
                    key={tank.id}
                    tank={tank}
                    selected={tank.id === selectedUnitId}
                    onSelect={selectUnit}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </DataState>
  );
}

/**
 * One unit in the grid: its code, its status, and the three figures that decide
 * whether it needs attention today.
 *
 * Card-wrapping-a-button rather than a hand-rolled card: the surface, radius,
 * border and theme response stay with the primitive that owns them (the same
 * shape TankCard uses), while the semantics stay with a real <button> — which is
 * what puts it in the tab order and gives it a pressed state for free.
 *
 * `aria-pressed` is honest here because the toggle really toggles: choosing the
 * selected unit again clears the inspector. A cabin board that cannot put the
 * right column back to neutral accumulates a unit nobody is looking at any more.
 */
function UnitCell({
  tank,
  selected,
  onSelect,
}: {
  tank: Tank;
  selected: boolean;
  onSelect: (unitId: string | null) => void;
}): ReactElement {
  const status = unitStatusMeta(tank.status);
  const metrics = tank.batchMetrics;
  const headline = tank.code || tank.name;
  // The status WORD always shows: the dot alone is colour, and a colourblind
  // worker reading a wall display at three metres reads the word.
  const secondary = headline === tank.name ? status.label : `${status.label} · ${tank.name}`;

  return (
    <Card className={clsx('p-0 overflow-hidden', selected && 'border-acc ring-2 ring-acc')}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : tank.id)}
        className={clsx(
          'w-full h-full min-h-touch p-3 flex flex-col gap-2 text-left',
          'touch-feedback focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-title font-mono font-semibold text-ink-1">
            {headline}
          </span>
          <StatusDot tone={status.tone} live={tank.status === 'ACTIVE'} />
        </span>
        <span className="truncate text-meta text-ink-3">{secondary}</span>

        <span className="flex flex-col gap-1">
          {/* Container totals, not the primary batch: a mixed pen holds more
              fish than its primary batch reports (ORPHAN-HIGH-585). */}
          <CellFigure label="Biomass" value={(tank.currentBiomass / 1000).toFixed(1)} unit="t" />
          <CellFigure label="Fish" value={compactCount(tank.currentQuantity)} />
          <CellFigure
            label="Capacity"
            value={fixedOrNone(metrics?.capacityUsedPercent, 0)}
            unit="%"
          />
        </span>

        {metrics?.isOverCapacity === true && (
          <span className="text-meta font-semibold text-crit">Over capacity</span>
        )}
      </button>
    </Card>
  );
}

/** Label left, machine value right — mono and tabular so a column of cells aligns. */
function CellFigure({
  label,
  value,
  unit,
}: {
  label: string;
  value: string;
  unit?: string;
}): ReactElement {
  return (
    <span className="flex items-baseline justify-between gap-2">
      <span className="text-meta text-ink-3">{label}</span>
      <span className="text-meta font-mono font-semibold tabular-nums text-ink-1">
        {value}
        {unit !== undefined && <span className="font-sans text-ink-3"> {unit}</span>}
      </span>
    </span>
  );
}

export default UnitGridPane;
