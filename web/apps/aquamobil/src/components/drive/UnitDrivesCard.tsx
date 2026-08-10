/**
 * UnitDrivesCard — the drives that serve ONE unit.
 *
 * The unit detail already answers "how much is in this pen" and "what is the
 * water doing". This answers the third question a worker standing at a pen asks:
 * what machinery feeds it, and is any of it running or faulted right now.
 *
 * WHY THE ROWS ARE LINKS RATHER THAN CONTROLS. Start and stop live on the drive's
 * own screen, behind its refusal notice and its role gate, so a command is never
 * one stray tap away from a list. The row shows the state and takes you to the
 * place where acting on it is a considered act.
 *
 * THE THREE NON-VALUE STATES ARE KEPT APART, the same way LiveReadingsCard keeps
 * them apart, because they mean different things:
 *   • no drives bound to this unit — a configuration fact about the pen
 *   • the fetch failed             — tone="error"; we do not know, which is a
 *     different claim from "there are none" and must never look like it
 *   • a drive with no reading yet  — the row says "State unknown", never "Stopped"
 */
import { AlertTriangle, Cog } from 'lucide-react';
import { type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { driveTelemetryLine } from './DriveState';

import { Card, EmptyState, ListRow, Skeleton } from '@/components/ui';
import { useUnitDrives } from '@/hooks/useVfdDrives';
import { toLoadable } from '@/utils/loadable';
import {
  RUN_STATE_LABEL,
  drivenUnitSummary,
  readDriveRunState,
  readDriveTelemetry,
} from '@/utils/vfd-drive';

export function UnitDrivesCard({ tankId }: { tankId: string }): ReactElement {
  const navigate = useNavigate();
  const drives = toLoadable(useUnitDrives(tankId));

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Cog size={16} className="text-acc" />
        <h3 className="text-title font-semibold text-ink-1">Drives</h3>
      </div>

      {drives.status === 'loading' && <Skeleton variant="row" count={2} />}

      {drives.status === 'error' && (
        <EmptyState
          tone="error"
          icon={<AlertTriangle size={22} />}
          title="Drives unavailable"
          // Never "no drives" — the app does not know, and on a surface about
          // machinery that difference is the whole message.
          description="The drives serving this unit could not be fetched. This is unavailable, not empty."
          className="py-4 px-0"
        />
      )}

      {drives.status === 'ready' && drives.data.vfdDevicesByTank.length === 0 && (
        <EmptyState
          icon={<Cog size={22} />}
          title="No drives"
          description="No drive is bound to equipment serving this unit."
          className="py-4 px-0"
        />
      )}

      {drives.status === 'ready' && drives.data.vfdDevicesByTank.length > 0 && (
        <div className="flex flex-col gap-2">
          {drives.data.vfdDevicesByTank.map((drive) => {
            const runState = readDriveRunState(drive.latestReading?.statusBits);
            const line = driveTelemetryLine(readDriveTelemetry(drive.latestReading?.parameters));
            return (
              <ListRow
                key={drive.id}
                leading={<Cog size={18} />}
                tone={runState === 'faulted' ? 'crit' : runState === 'running' ? 'ok' : 'neutral'}
                title={drive.name}
                // The state is spelled out in WORDS here rather than left to the
                // tile's colour: the row is the only place some workers will read
                // it, and a hue is not a sentence.
                subtitle={`${RUN_STATE_LABEL[runState]} · ${drivenUnitSummary(drive.drivenUnit)}`}
                // The measured line is omitted rather than zeroed when the drive
                // has reported nothing — see DriveState.tsx.
                trailing={line ?? undefined}
                onClick={() => navigate(`/drives/${drive.id}`)}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}
