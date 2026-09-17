/**
 * How a DRIVE is read and presented — the shared vocabulary every VFD surface
 * needs, in one place.
 *
 * WHY THIS FILE EXISTS. Three surfaces render the same drive: the phone's drive
 * detail, the unit detail's drives card, and the tablet board's drives strip.
 * The unit-display module (src/utils/unit-display.ts) exists because four unit
 * surfaces had each grown their own answer to "what colour is a QUARANTINE pen"
 * and the answers had drifted. A drive has the same shape of problem with higher
 * stakes — "is this auger turning" must not depend on which screen asked — so
 * the reading, the run state and the refusal reason are declared once, here.
 *
 * THE READING IS JSON, AND THAT IS NOT AN ACCIDENT. `VfdReading.parameters` and
 * `.statusBits` cross the wire as the JSON scalar because the decoded register
 * set is brand-shaped: a Danfoss FC302 and a Siemens G120 do not expose the same
 * registers. Codegen therefore hands this client `Record<string, unknown>`, and
 * every function below narrows the specific keys it needs with a `typeof` check.
 * A key that is missing, null, or the wrong type comes back as `null` — NEVER as
 * a zero. "0.0 Hz" from a drive that reported nothing is the same lie as "0 kg
 * biomass" from a failed fetch, which is the defect this app has now found seven
 * times (src/utils/loadable.ts).
 *
 * WHAT IS DELIBERATELY ABSENT: a drive PERCENTAGE. The v4 design asks for one
 * and the sensor service has no brand-neutral field that carries it. The nearest
 * candidate, `speedReference`, is declared in `%` by ABB, in `Hz` by Danfoss and
 * Rockwell, and in `RPM` by Siemens (apps/sensor-service/src/vfd/brand-configs/),
 * and the wire carries the number without its unit — so rendering it as a
 * percentage would be right for one brand in four. Deriving one from
 * `outputFrequency` against the feeder's min/max Hz envelope would be a figure
 * this client computed and the server never stated. Both are the kind of
 * plausible number this app refuses, so what is shown instead is
 * `outputFrequency` in Hz, which every one of the eight brand configs declares
 * in Hz.
 */
import type { VfdDriveBindingState, VfdDrivenUnitOutcome } from '@/generated/graphql';

/**
 * The parameters this client reads, with the unit each is declared in by ALL
 * eight brand configs — the reason these four are safe to render and
 * `speedReference` is not.
 */
export interface DriveTelemetry {
  /** `output_frequency` — Hz in every brand config. */
  outputFrequencyHz: number | null;
  /** `motor_current` — A in every brand config. */
  motorCurrentA: number | null;
  /** `motor_speed` — RPM in every brand config. */
  motorSpeedRpm: number | null;
  /** `output_power` — kW in every brand config. */
  outputPowerKw: number | null;
  /** The drive's own fault number, meaningful only against its brand's manual. */
  faultCode: number | null;
}

/**
 * What the shaft is doing.
 *
 * `unknown` is a first-class member and carries most of this type's value: a
 * drive with no reading, or a reading whose status word was never decoded, has
 * NOT been observed to be stopped. Collapsing that into `stopped` would tell a
 * worker an auger is still while it is turning.
 */
export type DriveRunState = 'running' | 'stopped' | 'faulted' | 'unknown';

/** Read one numeric key out of a decoded register set, or null. */
function readNumber(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (source === null || source === undefined) {
    return null;
  }
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read one boolean key out of a decoded status word, or null when absent. */
function readBoolean(
  source: Record<string, unknown> | null | undefined,
  key: string,
): boolean | null {
  if (source === null || source === undefined) {
    return null;
  }
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

/** Read one string key out of a JSON blob, or null. */
function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (source === null || source === undefined) {
    return null;
  }
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Narrow a decoded register set into the four brand-uniform values. */
export function readDriveTelemetry(
  parameters: Record<string, unknown> | null | undefined,
): DriveTelemetry {
  return {
    outputFrequencyHz: readNumber(parameters, 'outputFrequency'),
    motorCurrentA: readNumber(parameters, 'motorCurrent'),
    motorSpeedRpm: readNumber(parameters, 'motorSpeed'),
    outputPowerKw: readNumber(parameters, 'outputPower'),
    faultCode: readNumber(parameters, 'faultCode'),
  };
}

/**
 * Decide the run state from the decoded status word.
 *
 * ORDER IS DELIBERATE. A drive can report `running` and `fault` together while
 * it coasts down from a trip; the fault is the fact the operator has to act on,
 * so it wins. `running: false` is a real observation and becomes `stopped`; a
 * MISSING bit is not an observation and stays `unknown`.
 *
 * The bit meanings come from the CiA 402 / PROFIdrive status word the server
 * decodes in `parseStatusWord` (vfd-reading-codec.ts): bit 2 is operation
 * enabled, bit 3 is fault.
 */
export function readDriveRunState(
  statusBits: Record<string, unknown> | null | undefined,
): DriveRunState {
  if (readBoolean(statusBits, 'fault') === true) {
    return 'faulted';
  }
  const running = readBoolean(statusBits, 'running');
  if (running === true) {
    return 'running';
  }
  if (running === false) {
    return 'stopped';
  }
  return 'unknown';
}

/** The word beside the dot. A dot alone is colour-alone and unreadable to a colourblind worker. */
export const RUN_STATE_LABEL: Record<DriveRunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  faulted: 'Faulted',
  unknown: 'State unknown',
};

/** Semantic tone per run state — the same three tones the rest of the app uses. */
export const RUN_STATE_TONE: Record<DriveRunState, 'ok' | 'warn' | 'crit' | 'neutral'> = {
  running: 'ok',
  stopped: 'neutral',
  faulted: 'crit',
  // Amber rather than grey: not knowing whether an actuator is turning is a
  // condition to look into, not a neutral resting state.
  unknown: 'warn',
};

/** Whether the drive's gateway answered the last time anyone asked. */
export function readIsConnected(
  connectionStatus: Record<string, unknown> | null | undefined,
): boolean | null {
  return readBoolean(connectionStatus, 'isConnected');
}

/** The last connection error the gateway reported, if any. */
export function readConnectionError(
  connectionStatus: Record<string, unknown> | null | undefined,
): string | null {
  return readString(connectionStatus, 'lastError');
}

/**
 * Why the server would refuse a command on this drive, or null when it would
 * not.
 *
 * This MIRRORS `VfdDriveBindingService.assertActuable`, which is the authority —
 * the client does not decide, it explains. Three outcomes refuse: a drive with
 * no recorded equipment, a drive whose equipment the owning service has not
 * confirmed, and a drive whose confirmation has aged out past
 * ATTESTATION_MAX_AGE_MS. Everything else actuates, INCLUDING a pump (which
 * serves no unit by design) and a feeder whose assignments have lapsed (refusing
 * that would stop feeding, which is the worse welfare outcome).
 *
 * The point of surfacing it is that pressing Stop on a refusing drive must say
 * WHY. A dead button, or a spinner that ends in nothing, teaches a worker that
 * the app is broken when in fact the drive is not safe to command.
 */
export function driveCommandRefusal(
  outcome: VfdDrivenUnitOutcome,
  bindingState: VfdDriveBindingState | null | undefined,
): string | null {
  switch (outcome) {
    case 'UNBOUND':
      return 'This drive is not bound to the equipment it turns, so the server will not command it. An administrator has to bind it first.';
    case 'UNATTESTED':
      return bindingState === 'UNKNOWN_EQUIPMENT'
        ? 'The equipment this drive turns no longer exists, so the server will not command it.'
        : bindingState === 'INACTIVE_EQUIPMENT'
          ? 'The equipment this drive turns is inactive, so the server will not command it.'
          : "The service that owns this drive's equipment has not confirmed it yet, so the server will not command it.";
    case 'EXPIRED':
      return 'The confirmation of what this drive turns has aged out, so the server will not command it until it is confirmed again.';
    case 'NOT_A_FEEDER':
    case 'FEEDER_WITHOUT_UNIT':
    case 'FEEDER_AMBIGUOUS':
    case 'FEEDER_UNIT':
      return null;
  }
}

/** The units a drive serves, as the query returns them. */
export interface DrivenUnitRow {
  unitId: string;
  unitCode: string;
  unitType: string;
  doseSharePercent: number;
}

/** The `drivenUnit` resolution as this client consumes it. */
export interface DrivenUnitResolution {
  outcome: VfdDrivenUnitOutcome;
  equipmentCategory?: string | null;
  units: readonly DrivenUnitRow[];
}

/**
 * What this drive turns, in a sentence a field worker can act on.
 *
 * Every branch is named because the server named it: the outcome union exists so
 * "no unit" cannot collapse into one silence with four different causes and four
 * different responses. This function is the client half of that contract.
 */
export function drivenUnitSummary(resolution: DrivenUnitResolution): string {
  switch (resolution.outcome) {
    case 'UNBOUND':
      return 'Not bound to any equipment';
    case 'UNATTESTED':
      return 'Equipment not yet confirmed';
    case 'EXPIRED':
      return 'Equipment confirmation has aged out';
    case 'NOT_A_FEEDER':
      // A pump or a blower. It serves no unit, and that is the whole answer —
      // the category is what makes it useful rather than a shrug.
      return resolution.equipmentCategory != null && resolution.equipmentCategory !== ''
        ? `Drives ${resolution.equipmentCategory} equipment — serves no unit`
        : 'Serves no unit';
    case 'FEEDER_WITHOUT_UNIT':
      return 'Feeder with no unit assigned';
    case 'FEEDER_AMBIGUOUS':
      return `Feeder serving ${resolution.units.map((unit) => unit.unitCode).join(', ')}`;
    case 'FEEDER_UNIT':
      return resolution.units.length === 1
        ? `Feeder for ${resolution.units[0]?.unitCode ?? 'one unit'}`
        : 'Feeder';
  }
}

/**
 * True when the driven equipment is a feeder, so its `feederSetup` is worth
 * asking farm-service for. A pump has no dosing mode and no calibrations, and
 * asking would produce an error the operator cannot act on.
 */
export function isFeederDrive(outcome: VfdDrivenUnitOutcome): boolean {
  return (
    outcome === 'FEEDER_UNIT' || outcome === 'FEEDER_AMBIGUOUS' || outcome === 'FEEDER_WITHOUT_UNIT'
  );
}
