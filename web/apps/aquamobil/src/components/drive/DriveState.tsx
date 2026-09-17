/**
 * The two pieces of drive presentation that every VFD surface repeats: what the
 * shaft is doing, and what the drive last measured.
 *
 * They live here rather than on a page because three surfaces render them — the
 * phone's drive detail, the unit detail's drives card, and the tablet board's
 * drives strip — and a run state that reads one way in the cabin and another on
 * the handheld is the drift src/utils/unit-display.ts was written to end for
 * pens. A drive deserves the same treatment for higher stakes.
 */
import { type ReactElement } from 'react';

import { Chip, StatusDot } from '@/components/ui';
import {
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  type DriveRunState,
  type DriveTelemetry,
} from '@/utils/vfd-drive';

/**
 * Run state as a chip.
 *
 * The word is always present — a coloured dot alone is colour-alone, and a
 * colourblind worker would read "running" and "faulted" identically. `live` is
 * set only while the drive is actually turning, so the pulse means something.
 *
 * A stopped drive wears the neutral tone and therefore no dot: StatusDot has no
 * neutral colour by design (its whole vocabulary is "something is happening"),
 * and inventing a grey one would put a status light next to a machine that is
 * deliberately at rest.
 */
export function DriveStateChip({ runState }: { runState: DriveRunState }): ReactElement {
  const tone = RUN_STATE_TONE[runState];
  return (
    <Chip tone={tone}>
      {tone !== 'neutral' && <StatusDot tone={tone} live={runState === 'running'} />}
      {RUN_STATE_LABEL[runState]}
    </Chip>
  );
}

/** One measured value, rendered only because the drive reported it. */
function TelemetryValue({
  label,
  value,
  unit,
}: {
  label: string;
  value: number;
  unit: string;
}): ReactElement {
  return (
    <div className="rounded-xl bg-surface-2 p-2.5 text-center">
      <div className="text-head font-mono font-bold tabular-nums text-ink-1">
        {value.toFixed(unit === 'RPM' ? 0 : 2)}
        <span className="text-meta font-semibold text-ink-3 ml-0.5">{unit}</span>
      </div>
      <div className="text-meta font-semibold text-ink-2">{label}</div>
    </div>
  );
}

/**
 * The drive's measured values.
 *
 * ONLY the four parameters every one of the eight brand configs declares in the
 * same unit are shown, and only when the drive actually reported them — see the
 * header of src/utils/vfd-drive.ts for why a drive PERCENTAGE is absent rather
 * than derived. A value the drive did not send renders as nothing at all; a zero
 * would be a measurement this client invented.
 */
export function DriveTelemetryGrid({ telemetry }: { telemetry: DriveTelemetry }): ReactElement {
  const values: Array<{ label: string; value: number; unit: string }> = [];
  if (telemetry.outputFrequencyHz !== null) {
    values.push({ label: 'Output', value: telemetry.outputFrequencyHz, unit: 'Hz' });
  }
  if (telemetry.motorCurrentA !== null) {
    values.push({ label: 'Current', value: telemetry.motorCurrentA, unit: 'A' });
  }
  if (telemetry.motorSpeedRpm !== null) {
    values.push({ label: 'Speed', value: telemetry.motorSpeedRpm, unit: 'RPM' });
  }
  if (telemetry.outputPowerKw !== null) {
    values.push({ label: 'Power', value: telemetry.outputPowerKw, unit: 'kW' });
  }

  if (values.length === 0) {
    return (
      <p className="text-body text-ink-3">
        This drive has not reported any measurement yet. The drive percentage the v4 design shows is
        not among the values the server sends — see the note below.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {values.map((entry) => (
        <TelemetryValue key={entry.label} {...entry} />
      ))}
    </div>
  );
}

/**
 * A one-line form of the same values, for rows where a grid would not fit.
 * Returns null when the drive reported nothing, so a row never shows an empty
 * trailing slot that reads as a zero.
 */
export function driveTelemetryLine(telemetry: DriveTelemetry): string | null {
  const parts: string[] = [];
  if (telemetry.outputFrequencyHz !== null) {
    parts.push(`${telemetry.outputFrequencyHz.toFixed(1)} Hz`);
  }
  if (telemetry.motorCurrentA !== null) {
    parts.push(`${telemetry.motorCurrentA.toFixed(1)} A`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
