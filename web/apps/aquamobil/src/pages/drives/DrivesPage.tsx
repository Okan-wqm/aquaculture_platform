/**
 * DrivesPage — the drive index (ORPHAN-MEDIUM-575).
 *
 * WHAT IT ANSWERS: which drives this tenant has, how many are active and how
 * many have faulted, and how to get to any one of them. That is the whole of
 * what the fleet query can honestly say.
 *
 * WHY IT DOES NOT SHOW RUN STATE. `vfdDevices` resolves to `VfdDeviceOutput`, a
 * projection carrying no `driveBinding`, no `drivenUnit` and no `latestReading`
 * — the three fields that would say what a drive turns and whether the shaft is
 * moving. Those are resolve-fields on `VfdDevice`, which only `vfdDevice(id:)`
 * and `vfdDevicesByTank(tankId:)` return. Putting a "Stopped" badge on this list
 * would therefore mean this client made it up, so the list is an INDEX and the
 * page says so on screen rather than only in this comment. Open a drive, or open
 * a unit, for the state.
 *
 * WHY IT IS UNGATED. The VFD read queries carry no `@Roles` on the sensor
 * resolver — any authenticated member of the tenant may look at the drive
 * inventory, exactly as they may look at the unit list. Only the COMMANDS are
 * role-floored, and that floor is enforced on the drive detail where the buttons
 * are.
 */
import { AlertTriangle, Cog, Plug, PlugZap } from 'lucide-react';
import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Card, DataState, EmptyState, ListRow, StatTile } from '@/components/ui';
import { useVfdFleet } from '@/hooks/useVfdDrives';
import { toLoadable } from '@/utils/loadable';

/** Turn a drive's own status string into the row tone. */
function statusTone(
  status: string,
  isConnected: boolean | null,
): 'ok' | 'warn' | 'crit' | 'neutral' {
  if (status === 'TEST_FAILED' || status === 'OFFLINE') return 'crit';
  if (isConnected === false) return 'warn';
  if (status === 'ACTIVE') return 'ok';
  return 'neutral';
}

/**
 * The subtitle: what kind of drive it is and whether its gateway answered.
 *
 * `isConnected` is a nullable boolean on purpose — a drive nobody has ever tested
 * has no connection status at all, which is neither connected nor disconnected,
 * and saying "Not reachable" about it would be an accusation the server never
 * made.
 */
function driveSubtitle(
  brand: string,
  protocol: string,
  isConnected: boolean | null,
  lastError: string | null,
): string {
  const identity = `${brand} · ${protocol}`;
  if (isConnected === true) return `${identity} · Reachable`;
  if (isConnected === false) {
    return lastError !== null
      ? `${identity} · Not reachable: ${lastError}`
      : `${identity} · Not reachable`;
  }
  return `${identity} · Never tested`;
}

export function DrivesPage(): ReactElement {
  const navigate = useNavigate();
  const fleet = toLoadable(useVfdFleet());

  return (
    <div className="pb-32">
      <AppHeader title="Drives" subtitle="Feeders, pumps and blowers" />

      <div className="px-4 flex flex-col gap-5">
        <DataState value={fleet} label="drives" skeleton="tile" skeletonCount={3}>
          {(data) => (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Drives" value={data.vfdStats.total} />
                <StatTile label="Active" value={data.vfdStats.active} />
                {/* The coloured tile REQUIRES a caption by type (StatTile
                    refuses the colour-only case), so a crit number always says
                    what to do about it. A zero wears the neutral tone — and it
                    is the SERVER's zero, reached only on the ready arm, never a
                    fallback for a failed fetch. */}
                {data.vfdStats.faulted > 0 ? (
                  <StatTile
                    label="Faulted"
                    value={data.vfdStats.faulted}
                    state="crit"
                    caption="Open the drive to see the fault"
                  />
                ) : (
                  <StatTile label="Faulted" value={data.vfdStats.faulted} />
                )}
              </div>

              {data.vfdDevices.items.length === 0 ? (
                <EmptyState
                  icon={<Cog size={22} />}
                  title="No drives"
                  description="No variable-frequency drive is registered for this tenant."
                />
              ) : (
                <section className="flex flex-col gap-2">
                  {data.vfdDevices.items.map((drive) => {
                    const isConnected = drive.connectionStatus?.isConnected ?? null;
                    return (
                      <ListRow
                        key={drive.id}
                        leading={isConnected === false ? <Plug size={18} /> : <PlugZap size={18} />}
                        tone={statusTone(drive.status, isConnected)}
                        title={drive.name}
                        subtitle={driveSubtitle(
                          drive.brand,
                          drive.protocol,
                          isConnected,
                          drive.connectionStatus?.lastError ?? null,
                        )}
                        trailing={drive.location ?? undefined}
                        onClick={() => navigate(`/drives/${drive.id}`)}
                      />
                    );
                  })}
                </section>
              )}

              {/* Stated on screen, not only in the source: a worker who expects a
                  run state here is entitled to know why there is not one, and
                  where to find it. */}
              <Card className="p-4 flex gap-3">
                <AlertTriangle size={18} className="shrink-0 text-warn" aria-hidden />
                <p className="text-body text-ink-2">
                  This list is an index. Whether a drive is running, what it turns and any fault
                  come from the drive itself — open one, or open a unit, to see them.
                </p>
              </Card>

              {data.vfdDevices.hasNextPage && (
                <p className="text-meta text-ink-3 px-1">
                  Showing {data.vfdDevices.items.length} of {data.vfdDevices.total} drives. This
                  client reads the first page only.
                </p>
              )}
            </>
          )}
        </DataState>
      </div>
    </div>
  );
}

export default DrivesPage;
