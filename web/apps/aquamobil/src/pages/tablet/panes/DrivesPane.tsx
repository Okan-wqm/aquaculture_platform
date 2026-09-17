/**
 * DrivesPane — the board's drives strip. This is the FEEDERS strip the v4 design
 * asks for, and TabletLayout's header comment used to record as impossible.
 *
 * WHAT IT SHOWS. Two things, both of them queried:
 *   • the fleet counts (`vfdStats`) — how many drives exist, how many are active
 *     and how many have faulted, which is the number a cabin board is on the
 *     wall to catch;
 *   • the drives serving the SELECTED unit (`vfdDevicesByTank`), each with what
 *     it turns, whether it is running and any fault.
 *
 * WHY IT IS SCOPED TO THE SELECTION RATHER THAN THE SITE. No query returns the
 * full drive shape for many units at once: `vfdDevices` can filter by unit but
 * resolves to `VfdDeviceOutput`, which carries no binding and no reading, so a
 * site-wide strip with run states would mean one round trip per unit on every
 * poll. This app already refused that pattern once — useLatestReadings batches
 * its sensors into a single call rather than N — and a wall tablet firing thirty
 * requests every twenty seconds is the same mistake with a longer interval. So
 * the strip follows the board's own selection, which is how every other column
 * here already works.
 *
 * NO COMMANDS FROM THE CABIN. The board's footer says entries are made standing
 * at the unit; the same logic binds harder for an actuator. Starting an auger
 * from a desk is starting a machine nobody is standing next to, which is the
 * exact hazard the offline-queue ban exists to prevent — arriving through a
 * different door. Start and stop live on the handheld's drive screen.
 */
import { AlertTriangle, Cog } from 'lucide-react';
import { type ReactElement } from 'react';

import { useSelectedUnit } from '../useSelectedUnit';

import { driveTelemetryLine } from '@/components/drive';
import { Chip, EmptyState, Skeleton, StatusDot } from '@/components/ui';
import { useUnitDrives, useVfdFleetSummary } from '@/hooks/useVfdDrives';
import { toLoadable } from '@/utils/loadable';
import {
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  drivenUnitSummary,
  readDriveRunState,
  readDriveTelemetry,
} from '@/utils/vfd-drive';

/**
 * The fleet counts, or the fact that they are unknown.
 *
 * "0 faulted" from a board that could not reach the sensor service is an
 * all-clear the app has no evidence for, on the surface where an all-clear is
 * most expensive — the same rule AlarmsChip follows one shell up.
 */
function FleetChips(): ReactElement {
  const summary = toLoadable(useVfdFleetSummary());

  if (summary.status === 'error') {
    return (
      <Chip tone="warn">
        <StatusDot tone="warn" />
        Drive counts unavailable
      </Chip>
    );
  }
  if (summary.status === 'loading') {
    return <Chip>Drives…</Chip>;
  }

  const stats = summary.data.vfdStats;
  return (
    <>
      <Chip>
        {stats.total} {stats.total === 1 ? 'drive' : 'drives'}
      </Chip>
      <Chip tone="ok">
        <StatusDot tone="ok" />
        {stats.active} active
      </Chip>
      {stats.faulted > 0 ? (
        <Chip tone="crit">
          <StatusDot tone="crit" live />
          {stats.faulted} faulted
        </Chip>
      ) : (
        <Chip tone="ok">
          <StatusDot tone="ok" />
          None faulted
        </Chip>
      )}
    </>
  );
}

/** One drive, as a compact tile in the strip. */
function DriveTile({
  name,
  runState,
  drives,
  measured,
}: {
  name: string;
  runState: ReturnType<typeof readDriveRunState>;
  drives: string;
  measured: string | null;
}): ReactElement {
  const tone = RUN_STATE_TONE[runState];
  return (
    <div className="shrink-0 w-56 rounded-2xl border border-line bg-surface-1 shadow-token p-3 flex flex-col gap-1">
      <div className="flex items-center gap-2 min-w-0">
        {tone !== 'neutral' && <StatusDot tone={tone} live={runState === 'running'} />}
        <span className="truncate text-title font-medium text-ink-1">{name}</span>
      </div>
      {/* The state is a WORD, not only the dot's colour — a colourblind worker
          reads the same thing everyone else does. */}
      <span className="text-body font-semibold text-ink-2">{RUN_STATE_LABEL[runState]}</span>
      <span className="truncate text-body text-ink-3">{drives}</span>
      {measured !== null && (
        <span className="font-mono tabular-nums text-body text-ink-2">{measured}</span>
      )}
    </div>
  );
}

export function DrivesPane(): ReactElement {
  const { selectedUnitId } = useSelectedUnit();
  const drives = toLoadable(useUnitDrives(selectedUnitId));

  return (
    <section
      aria-label="Drives"
      className="shrink-0 border-t border-line bg-surface-0 px-3 py-2.5 flex flex-col gap-2"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Cog size={16} className="text-acc shrink-0" aria-hidden />
        <h2 className="text-body font-semibold text-ink-2">Drives</h2>
        <FleetChips />
      </div>

      {selectedUnitId === null ? (
        // Stated, not blank: a board that shows an empty strip looks broken. The
        // reason is a real property of the API, so it is said rather than hidden.
        <p className="text-body text-ink-3">
          Select a unit to see the drives serving it. Which drive feeds which pen is only queryable
          one unit at a time, so this strip follows the board&apos;s selection.
        </p>
      ) : (
        <>
          {drives.status === 'loading' && <Skeleton variant="row" count={1} />}

          {drives.status === 'error' && (
            <EmptyState
              tone="error"
              icon={<AlertTriangle size={22} />}
              title="Drives unavailable"
              description="The drives for the selected unit could not be fetched. This is unavailable, not empty."
              className="py-3 px-0"
            />
          )}

          {drives.status === 'ready' && drives.data.vfdDevicesByTank.length === 0 && (
            <p className="text-body text-ink-3">
              No drive is bound to equipment serving the selected unit.
            </p>
          )}

          {drives.status === 'ready' && drives.data.vfdDevicesByTank.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {drives.data.vfdDevicesByTank.map((drive) => (
                <DriveTile
                  key={drive.id}
                  name={drive.name}
                  runState={readDriveRunState(drive.latestReading?.statusBits)}
                  drives={drivenUnitSummary(drive.drivenUnit)}
                  measured={driveTelemetryLine(readDriveTelemetry(drive.latestReading?.parameters))}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default DrivesPane;
