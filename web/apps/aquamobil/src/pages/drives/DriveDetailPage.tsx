/**
 * DriveDetailPage — one drive, and the only place this client commands one.
 *
 * IT ANSWERS, IN ORDER: what does this machine turn, is it running, has it
 * faulted, and may I start or stop it.
 *
 * THE REFUSAL IS THE POINT OF THE TOP HALF. A VFD that is unbound, unattested or
 * whose attestation has aged out REFUSES commands server-side by design
 * (`VfdDriveBindingService.assertActuable`). An operator pressing Stop on such a
 * drive must see WHY — not a spinner that ends in nothing, and not a dead
 * button. So the reason is rendered before the controls, in the same words the
 * server would answer with, and the controls stay visible underneath it so the
 * refusal reads as a fact about the DRIVE rather than a fault in the app.
 *
 * COMMANDS ARE ONLINE-ONLY AND CANNOT BE QUEUED. That is enforced structurally
 * rather than by this screen remembering it — see src/pwa/actuation-commands.ts.
 * What this screen owns is making the refusal audible: pressing Start with no
 * signal produces an alert saying nothing was sent and nothing will be sent
 * later, because a worker who has watched mortality entries queue all shift will
 * otherwise assume this queued too.
 *
 * WHAT IS ABSENT AND WHY: a drive PERCENTAGE. The v4 design shows one; no
 * brand-neutral field carries it (src/utils/vfd-drive.ts documents the four
 * brand-disagreeing candidates). Output frequency in Hz is shown instead,
 * because every one of the eight brand configs declares that in Hz.
 */
import { AlertTriangle, ArrowLeft, Ban, Cog, Play, Square } from 'lucide-react';
import { type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { DataFreshness } from '@/components/DataFreshness';
import { DriveStateChip, DriveTelemetryGrid } from '@/components/drive';
import { Button, Card, CardDivider, DataState, EmptyState } from '@/components/ui';
import type { MobileDriveFieldsFragment, MobileFeederSetupQuery } from '@/generated/graphql';
import { useVfdCommand } from '@/hooks/useVfdCommand';
import { useFeederSetup, useVfdDrive } from '@/hooks/useVfdDrives';
import { toLoadable, type Loadable } from '@/utils/loadable';
import {
  driveCommandRefusal,
  drivenUnitSummary,
  isFeederDrive,
  readConnectionError,
  readDriveRunState,
  readDriveTelemetry,
  readIsConnected,
} from '@/utils/vfd-drive';

export function DriveDetailPage(): ReactElement {
  const { vfdDeviceId } = useParams<{ vfdDeviceId: string }>();
  const navigate = useNavigate();
  const query = useVfdDrive(vfdDeviceId);
  const drive = toLoadable(query);

  return (
    <div className="pb-32">
      <AppHeader title="Drive" onBack={() => navigate(-1)} showAvatar={false} />

      <div className="px-4 flex flex-col gap-5">
        <DataState value={drive} label="this drive" skeleton="tile" skeletonCount={3}>
          {(data) =>
            data.vfdDevice === null ? (
              // Reachable ONLY on the ready arm: DataState will not run this
              // render-prop during a failure, so "no such drive" can never be
              // shown for "we could not ask". That substitution is the defect
              // this app has found seven times (src/utils/loadable.ts).
              <EmptyState
                icon={<Cog size={22} />}
                title="Drive not found"
                description="This drive is not registered in your tenant. It may have been removed."
                action={
                  <Button variant="primary" onClick={() => navigate('/drives')}>
                    <ArrowLeft size={16} />
                    All drives
                  </Button>
                }
              />
            ) : (
              <DriveBody
                drive={data.vfdDevice}
                onCommandSettled={() => {
                  void query.refetch();
                }}
              />
            )
          }
        </DataState>
      </div>
    </div>
  );
}

/**
 * The drive itself. Split out so the null branch above stays legible and so this
 * body can assume a real drive rather than re-checking for one.
 */
function DriveBody({
  drive,
  onCommandSettled,
}: {
  drive: MobileDriveFieldsFragment;
  onCommandSettled: () => void;
}): ReactElement {
  const runState = readDriveRunState(drive.latestReading?.statusBits);
  const telemetry = readDriveTelemetry(drive.latestReading?.parameters);
  const refusal = driveCommandRefusal(drive.drivenUnit.outcome, drive.driveBinding?.state);
  const isConnected = readIsConnected(drive.connectionStatus);
  const connectionError = readConnectionError(drive.connectionStatus);

  // Asked only when the binding says the equipment IS a feeder — a pump has no
  // dosing mode, and asking farm-service about one produces an error nobody can
  // act on.
  const feederEquipmentId =
    isFeederDrive(drive.drivenUnit.outcome) && drive.drivenUnit.drivenEquipmentId !== null
      ? drive.drivenUnit.drivenEquipmentId
      : null;
  const feederSetup = toLoadable(useFeederSetup(feederEquipmentId));

  return (
    <>
      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-head font-semibold text-ink-1">{drive.name}</h2>
            <p className="truncate text-body text-ink-3">
              {drive.brand}
              {drive.location !== null && ` · ${drive.location}`}
            </p>
          </div>
          <DriveStateChip runState={runState} />
        </div>

        <CardDivider />

        <div className="flex flex-col gap-1">
          <span className="text-meta text-ink-3">What it drives</span>
          <span className="text-title text-ink-1">{drivenUnitSummary(drive.drivenUnit)}</span>
          {drive.driveBinding?.equipmentName != null && (
            <span className="text-body text-ink-3">
              {drive.driveBinding.equipmentName}
              {drive.driveBinding.equipmentCode !== null &&
                ` (${drive.driveBinding.equipmentCode})`}
            </span>
          )}
        </div>
      </Card>

      {/* The measured half. Every value here was sent by the drive; anything the
          drive did not send is absent rather than zeroed. */}
      <Card className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-title font-semibold text-ink-1">Last reading</h3>
          <DataFreshness timestamp={drive.latestReading?.timestamp} />
        </div>

        {drive.latestReading === null ? (
          <p className="text-body text-ink-3">
            This drive has never reported a reading. Its state is unknown — it has not been observed
            to be stopped.
          </p>
        ) : (
          <>
            <DriveTelemetryGrid telemetry={telemetry} />
            {telemetry.faultCode !== null && telemetry.faultCode !== 0 && (
              <p className="text-body text-crit" role="alert">
                Fault code {telemetry.faultCode}. Its meaning is in the {drive.brand} drive manual —
                this client does not hold the brand fault tables.
              </p>
            )}
            {drive.latestReading.isValid === false && (
              <p className="text-body text-warn">
                The drive reported a partial or invalid read
                {drive.latestReading.errorMessage !== null &&
                  `: ${drive.latestReading.errorMessage}`}
                .
              </p>
            )}
          </>
        )}

        {isConnected === false && (
          <p className="text-body text-warn">
            The gateway could not reach this drive
            {connectionError !== null && `: ${connectionError}`}.
          </p>
        )}
      </Card>

      {feederEquipmentId !== null && <FeederSetupCard setup={feederSetup} />}

      <DriveCommands drive={drive} refusal={refusal} onCommandSettled={onCommandSettled} />
    </>
  );
}

/**
 * The feeder's own setup, from farm-service.
 *
 * `feederSetup` replaced the older `feederCalibrations` query and returns the
 * capability WITH the calibrations, which is what makes either readable: a
 * grams-per-minute figure means nothing without knowing the machine doses
 * continuously.
 */
function FeederSetupCard({ setup }: { setup: Loadable<MobileFeederSetupQuery> }): ReactElement {
  return (
    <Card className="p-4 flex flex-col gap-3">
      <h3 className="text-title font-semibold text-ink-1">Feeder setup</h3>
      <DataState value={setup} label="the feeder setup" skeleton="text" skeletonCount={2}>
        {(data) =>
          data.feederSetup.capability === null ? (
            <p className="text-body text-ink-3">
              This feeder has no capability recorded yet, so its dosing is not configured.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-body text-ink-2">
                {data.feederSetup.capability.dosingMode === 'CONTINUOUS'
                  ? 'Continuous flow'
                  : 'Discrete doses'}
                {' · '}
                {data.feederSetup.capability.dispenseControl === 'WEIGHT_BASED'
                  ? 'weight-controlled'
                  : 'time-controlled'}
              </p>
              {data.feederSetup.capability.siloCapacityKg !== null && (
                <p className="text-body text-ink-2">
                  Silo capacity{' '}
                  <span className="font-mono tabular-nums">
                    {data.feederSetup.capability.siloCapacityKg}
                  </span>{' '}
                  kg
                </p>
              )}
              {data.feederSetup.capability.minSpeedHz !== null &&
                data.feederSetup.capability.maxSpeedHz !== null && (
                  <p className="text-body text-ink-2">
                    Operating band{' '}
                    <span className="font-mono tabular-nums">
                      {data.feederSetup.capability.minSpeedHz}–
                      {data.feederSetup.capability.maxSpeedHz}
                    </span>{' '}
                    Hz
                  </p>
                )}
              <p className="text-body text-ink-3">
                {data.feederSetup.calibrations.length === 0
                  ? 'No feed is calibrated on this machine yet.'
                  : `${data.feederSetup.calibrations.length} feed calibration${
                      data.feederSetup.calibrations.length === 1 ? '' : 's'
                    } recorded.`}
              </p>
              {/* The silo LEVEL the v4 design shows is deliberately absent: the
                  capability carries the silo's CAPACITY, and no query on this
                  client reports how much is currently in it. A capacity rendered
                  as a level would be a full hopper the app invented. */}
            </div>
          )
        }
      </DataState>
    </Card>
  );
}

/**
 * Start and stop.
 *
 * Three gates, all of them visible rather than silent:
 *   1. ROLE — the buttons are absent when the operator's role does not clear the
 *      server's `@Roles(TENANT_ADMIN, MODULE_MANAGER)` floor, and the card says
 *      so instead of rendering nothing at all.
 *   2. BINDING — a drive the server would refuse shows the reason above the
 *      buttons, in the server's own terms.
 *   3. NETWORK — the buttons stay live offline ON PURPOSE. A disabled control is
 *      a silence, and this is the one refusal a field worker most needs spoken:
 *      pressing produces an alert saying the command was not sent and will not
 *      be queued.
 */
function DriveCommands({
  drive,
  refusal,
  onCommandSettled,
}: {
  drive: MobileDriveFieldsFragment;
  refusal: string | null;
  onCommandSettled: () => void;
}): ReactElement {
  const { send, isSending, outcome, canCommand, isOnline } = useVfdCommand(
    drive.id,
    onCommandSettled,
  );

  if (!canCommand) {
    return (
      <Card className="p-4 flex gap-3">
        <Ban size={18} className="shrink-0 text-ink-3" aria-hidden />
        <p className="text-body text-ink-2">
          Starting and stopping a drive needs a module-manager role. You can watch this drive but
          not command it.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <h3 className="text-title font-semibold text-ink-1">Command</h3>

      {refusal !== null && (
        <div className="flex gap-3 rounded-2xl bg-warn-dim p-3">
          <AlertTriangle size={18} className="shrink-0 text-warn" aria-hidden />
          <p className="text-body text-warn">{refusal}</p>
        </div>
      )}

      {!isOnline && (
        <p className="text-body text-warn">
          Offline. Drive commands are never queued — pressing will tell you so rather than storing
          the command for later.
        </p>
      )}

      <div className="flex gap-3">
        <Button
          variant="primary"
          block
          disabled={isSending}
          onClick={() => {
            void send('start');
          }}
        >
          <Play size={16} />
          Start
        </Button>
        <Button
          variant="danger"
          block
          disabled={isSending}
          onClick={() => {
            void send('stop');
          }}
        >
          <Square size={16} />
          Stop
        </Button>
      </div>

      {/* role="alert" so the refusal is ANNOUNCED, not just drawn. A worker in
          gloves who pressed Stop and got nothing is the failure this prevents. */}
      {outcome !== null && (
        <p
          role="alert"
          className={outcome.status === 'sent' ? 'text-body text-ok' : 'text-body text-crit'}
        >
          {outcome.message}
        </p>
      )}
    </Card>
  );
}

export default DriveDetailPage;
