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
 * site. What the v4 mock shows and this does NOT show is a Feeders tab: the
 * mobile client has no feeder query — no dose, hopper level, drive percentage or
 * run/stop — so the tab is absent rather than filled with plausible numbers.
 * Tracked as an orphan finding; see the phase notes.
 */
import { Boxes, WifiOff } from 'lucide-react';
import { useMemo, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Chip, EmptyState, ListRow, Skeleton, StatusDot } from '@/components/ui';
import { useTanks } from '@/hooks/useTanks';
import type { Tank } from '@/types';

/** Status → the tone its dot and code tile take. */
function toneForStatus(status: Tank['status']): 'ok' | 'warn' | 'crit' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'HARVESTING':
    case 'PREPARING':
      return 'warn';
    case 'QUARANTINE':
    case 'MAINTENANCE':
      return 'crit';
    default:
      return 'neutral';
  }
}

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
  // together. Sites arrive as opaque ids from the inventory snapshot; until the
  // mobile client has a site-name query the group is labelled by position, which
  // is honest about what is known rather than inventing a site name.
  const groups = useMemo(() => {
    if (!tanks) return [];
    const bySite = new Map<string, Tank[]>();
    for (const tank of tanks) {
      const key = tank.siteId ?? 'unassigned';
      const bucket = bySite.get(key);
      if (bucket) bucket.push(tank);
      else bySite.set(key, [tank]);
    }
    return [...bySite.entries()].map(([siteId, rows], index) => ({
      siteId,
      label: bySite.size === 1 ? 'Units' : `Site ${index + 1}`,
      rows,
    }));
  }, [tanks]);

  const total = tanks?.length ?? 0;

  return (
    <div className="pb-32">
      <AppHeader title="Units" subtitle={total > 0 ? `${total} units` : undefined} />

      <div className="px-4 flex flex-col gap-5">
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
              <span className="text-meta font-mono text-ink-3">{group.rows.length}</span>
            </div>
            {group.rows.map((tank) => {
              const tone = toneForStatus(tank.status);
              const metrics = tank.batchMetrics;
              return (
                <ListRow
                  key={tank.id}
                  leading={shortCode(tank)}
                  tone={tone === 'neutral' ? 'neutral' : tone}
                  title={
                    <span className="flex items-center gap-2">
                      {tank.name}
                      <StatusDot tone={tone === 'neutral' ? 'ok' : tone} />
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
