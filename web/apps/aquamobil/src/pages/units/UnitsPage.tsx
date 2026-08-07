/**
 * UnitsPage — the v4 "Units" screen (the design calls it Pens).
 *
 * WHY this is a top-level destination rather than a section of Home: the unit is
 * the thing a field worker navigates by. Every entry they make is against one,
 * and before v4 the only way to reach a unit was to scroll past the greeting,
 * the stats and the quick-action grid on Home. Giving units their own dock slot
 * makes the app's central noun reachable in one tap.
 *
 * Data is the real inventory (`useTanks` → `farmStockInventory`), grouped by
 * site.
 *
 * THE FEEDERS TAB THE v4 MOCK SHOWS IS NOW A DESTINATION. This header used to
 * say the mobile client had no feeder query at all (ORPHAN-MEDIUM-575), which
 * was wrong in a way that sent people to the wrong place: apps/sensor-service
 * has carried a full VFD surface throughout, and only this client lacked
 * documents for it. The drive list lives at `/drives` and is reached from the
 * row below rather than from a tab, because a drive is not a kind of unit — it
 * is the machinery that serves one, and several drives serve several pens.
 *
 * WHAT IS STILL ABSENT: the mock's dose, hopper LEVEL and drive PERCENTAGE. No
 * query reports how much feed is in a silo, and no brand-neutral field carries a
 * drive percentage — the header of src/utils/vfd-drive.ts names the candidates
 * and why each one would be a different unit depending on the drive's brand.
 */
import { Boxes, Cog, WifiOff } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Chip, EmptyState, ListRow, Skeleton, StatusDot } from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import type { Tank } from '@/types';
import { groupUnitsBySite, unitStatusMeta } from '@/utils/unit-display';

/**
 * The short code shown in the row's tile. Codes like "U-07" already read well;
 * anything longer is truncated to keep the 40px tile legible rather than
 * shrinking the type below the sunlight floor.
 */
function shortCode(tank: Tank): string {
  const code = tank.code || tank.name;
  return code.length <= 5 ? code : code.slice(0, 5);
}

export function UnitsPage(): ReactElement {
  const navigate = useNavigate();
  const { data: tanks, isLoading, isError, refetch } = useTanks();

  // Group by site so a worker on a multi-site tenant sees their own site's units
  // together. The grouping and its positional labelling live in
  // src/utils/unit-display.ts because the tablet board's unit grid groups the
  // same units the same way — two copies would drift the moment either changed.
  const groups = useMemo(() => (tanks ? groupUnitsBySite(tanks) : []), [tanks]);

  const total = tanks?.length ?? 0;

  return (
    <div className="pb-32">
      <AppHeader title="Units" subtitle={total > 0 ? `${total} units` : undefined} />

      <div className="px-4 flex flex-col gap-5">
        {/* The only entry point to the drive surface, and deliberately OUTSIDE
            the loading/error branches below: the drives are a separate query
            against a separate service, so a farm-inventory outage must not also
            hide the way to the machinery. */}
        <ListRow
          leading={<Cog size={18} />}
          tone="accent"
          title="Drives"
          subtitle="Feeders, pumps and blowers — state, faults and start/stop"
          onClick={() => navigate('/drives')}
        />

        {isLoading && <Skeleton variant="row" count={5} />}

        {isError && (
          <EmptyState
            tone="error"
            icon={<WifiOff size={22} />}
            title="Could not load units"
            description="The unit list could not be fetched. Anything you log is still queued on this device."
            action={
              <Chip tone="accent" onClick={() => void refetch()}>
                Try again
              </Chip>
            }
          />
        )}

        {!isLoading && !isError && total === 0 && (
          <EmptyState
            icon={<Boxes size={22} />}
            title="No units"
            description="No stocked units are assigned to this tenant yet."
          />
        )}

        {groups.map((group) => (
          <section key={group.siteId} className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between px-1">
              <h2 className="text-body font-semibold text-ink-3">{group.label}</h2>
              <span className="text-meta font-mono text-ink-3">{group.units.length}</span>
            </div>
            {group.units.map((tank) => {
              // One status means one colour on every unit surface — see
              // src/utils/unit-display.ts. This screen used to answer `neutral`
              // for CLEANING, FALLOW and INACTIVE while the unit detail answered
              // `warn` for the same three, so a pen changed colour when a worker
              // tapped into it.
              const { tone } = unitStatusMeta(tank.status);
              const metrics = tank.batchMetrics;
              return (
                <ListRow
                  key={tank.id}
                  leading={shortCode(tank)}
                  tone={tone}
                  title={
                    <span className="flex items-center gap-2">
                      {tank.name}
                      <StatusDot tone={tone} />
                    </span>
                  }
                  subtitle={
                    metrics?.batchNumber
                      ? `${metrics.batchNumber} · ${tank.currentQuantity.toLocaleString()} fish`
                      : 'No batch stocked'
                  }
                  trailing={
                    tank.currentBiomass > 0 ? (
                      <span className="font-mono tabular-nums">
                        {(tank.currentBiomass / 1000).toFixed(1)}
                        <span className="text-ink-3 font-sans"> t</span>
                      </span>
                    ) : undefined
                  }
                  onClick={() => navigate(`/tank/${tank.id}`)}
                />
              );
            })}
          </section>
        ))}

        {total > 0 && (
          <p className="text-meta text-ink-3 px-1">
            Tap a unit to inspect it. Log entries happen standing at the unit.
          </p>
        )}
      </div>
    </div>
  );
}

export default UnitsPage;
