/**
 * FeederDoseDirectiveService — "how do I actually make this feeder deliver these
 * kilograms" answered in exactly one place.
 *
 * This closes the operator's chain. Upstream of here it is already derivable:
 * protocol band → feed type and feeding rate → `plannedTotalKg` → the per-feeder
 * dose share (`FeederDoseSplitService`). This file turns the last link — a dose
 * in kilograms — into the thing a drive can be sent: a SPEED and a RUN DURATION
 * for a continuous auger, or a SHOT COUNT for a discrete feeder. No human
 * computes either number anywhere on that path.
 *
 * ## Why the arithmetic is here and not at the call site
 *
 * Same reason `splitDoseByShare` is not left to callers, one severity higher.
 * A split that rounds badly loses grams; a speed that is guessed drives an
 * actuator. Two callers computing "grams ÷ rate" independently is exactly how
 * one of them ends up extrapolating past a drive's usable range without noticing
 * — the arithmetic looks trivial right up until the point where it is wrong. The
 * pure functions below are the only implementation, `FeederDoseDirectiveService`
 * is the only way to reach them with real calibration data, and every outcome —
 * including every refusal — is a member of one discriminated union, so a caller
 * cannot read `.speedHz` without having first proved the plan is a plan.
 *
 * ## The speed → rate relation, and why it stops at the band edges
 *
 * An auger/screw feeder is VOLUMETRIC: each revolution of the screw displaces a
 * fixed volume of pellets, so for a given feed (constant bulk density) the mass
 * moved per revolution is constant. An induction motor under a VFD turns at
 * roughly `120·f/poles` minus a small, near-constant slip under the light and
 * steady load an auger presents. Revolutions per minute is therefore
 * proportional to drive frequency, and mass flow is proportional to revolutions.
 * Hence:
 *
 *     gramsPerMinute(f) = gramsPerMinute(f_ref) × f / f_ref
 *
 * — linear THROUGH THE ORIGIN, which is why a single measured point is enough to
 * fix the whole line.
 *
 * That derivation quietly assumes three things, and each fails at one end:
 *
 *   - at low frequency an induction motor loses torque and self-cooling, the
 *     screw stick-slips, and the hopper bridges above it — flow becomes erratic
 *     and stops tracking frequency at all;
 *   - at high frequency the screw flights no longer fill completely per
 *     revolution and the drive enters field weakening, so delivered mass falls
 *     BELOW the line. This is the dangerous end: the model would over-promise
 *     and the fish would be underfed by an amount nothing measures.
 *
 * So the line is declared valid only on `[minSpeedHz, maxSpeedHz]`, the band the
 * feeder was commissioned with, and this module REFUSES outside it rather than
 * extrapolating. A refusal is recoverable — the caller can ask again without a
 * duration preference and get the reference-speed plan. A silent extrapolation
 * is not recoverable, because nothing downstream would ever report it.
 *
 * @module FeedingProtocol/Services
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead, tenantManagerRepo } from '@aquaculture/backend-common/database';

import {
  FeederCapability,
  FeederDispenseControl,
  FeederDosingMode,
} from '../../equipment/entities/feeder-capability.entity';
import { FeederCalibration } from '../../equipment/entities/feeder-calibration.entity';
import { FeederSiloMassLatest } from '../../equipment/entities/feeder-silo-mass-latest.entity';
import type { ProtocolBand } from '../entities/feeding-protocol-v2.entity';

import { FeederDoseSplitService, type FeederDoseAllocation } from './feeder-dose-split.service';

/** Drives accept a frequency setpoint at 0.01 Hz resolution. */
const SPEED_DECIMALS = 2;
/** Grams are reported at milligram-free, gram resolution (matches plannedKg). */
const GRAM_DECIMALS = 3;

/**
 * How stale a silo-mass reading may be before a WEIGHT_BASED feeder is refused.
 *
 * A load cell under a silo reports continuously; thirty minutes of silence means
 * the source is not there, whatever the configuration claims. The window is
 * deliberately far shorter than the interval between meals, so a feeder whose
 * weight source died is refused at the NEXT meal rather than at some later one.
 */
export const WEIGHT_SOURCE_MAX_READING_AGE_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/**
 * Every way planning a dose can fail. A closed set, because each of these is a
 * DIFFERENT operational condition: a missing calibration is a setup task, a
 * silent weight source is a maintenance call, and an unreachable run window is
 * simply a request the machine cannot honour and the caller can restate.
 */
export enum FeederDoseRefusalReason {
  /** No `feeder_capabilities` row — this machine was never commissioned as a feeder. */
  NOT_COMMISSIONED = 'not_commissioned',
  /** The feeder has no calibration for THIS feed. Refused, never defaulted. */
  NO_CALIBRATION_FOR_FEED = 'no_calibration_for_feed',
  /** The requested run duration would need a speed outside the validated band. */
  RUN_WINDOW_UNREACHABLE = 'run_window_unreachable',
  /** Weight-based feeder whose bound mass sensor has not reported recently. */
  WEIGHT_SOURCE_SILENT = 'weight_source_silent',
  /** A dose of zero or less is not a dose. */
  NON_POSITIVE_DOSE = 'non_positive_dose',
}

interface FeederDoseDirectiveBase {
  feederEquipmentId: string;
  feederName: string;
  feederCode: string;
  feedId: string;
  /** What was asked for, before any quantisation the machine imposes. */
  requestedGrams: number;
}

/** A continuous (VFD auger) feeder: run the drive at this speed for this long. */
export interface ContinuousRunDirective extends FeederDoseDirectiveBase {
  kind: 'continuous_run';
  dispenseControl: FeederDispenseControl;
  /** Drive frequency setpoint, at the 0.01 Hz resolution drives accept. */
  speedHz: number;
  /** Motor run time in whole seconds — the unit a drive command carries. */
  runSeconds: number;
  /** Mass flow the linear model predicts at `speedHz`, g/min. */
  gramsPerMinuteAtSpeed: number;
  /**
   * What the drive will ACTUALLY deliver once speed and duration have been
   * rounded to what the hardware accepts. Reported rather than hidden: a plan
   * that quietly differs from the request by a few grams a meal is the same
   * class of invisible, permanent error as a 90% share sum.
   */
  deliveredGrams: number;
}

/** A discrete (shot) feeder: fire this many actuations. */
export interface DiscreteShotDirective extends FeederDoseDirectiveBase {
  kind: 'discrete_shots';
  dispenseControl: FeederDispenseControl;
  dispensings: number;
  gramsPerDispensing: number;
  /**
   * `dispensings × gramsPerDispensing`. A shot feeder cannot fire a fraction of
   * a shot, so the delivered mass is quantised and almost never equals the
   * request. Carrying it makes the quantisation auditable.
   */
  deliveredGrams: number;
}

export interface FeederDoseRefusal extends FeederDoseDirectiveBase {
  kind: 'refused';
  reason: FeederDoseRefusalReason;
  detail: string;
  /**
   * Present on RUN_WINDOW_UNREACHABLE: the run durations this feeder CAN reach
   * for this dose, at the two edges of its validated speed band. Refusing
   * without saying what is possible would just move the guessing elsewhere.
   */
  reachableRunMinutes?: { min: number; max: number };
}

export type FeederDoseDirective =
  | ContinuousRunDirective
  | DiscreteShotDirective
  | FeederDoseRefusal;

// ---------------------------------------------------------------------------
// Pure physics
// ---------------------------------------------------------------------------

/** The stored continuous-flow calibration, with the band it is valid on. */
export interface ContinuousFlowCalibration {
  /** Measured mass flow at `referenceSpeedHz`, g/min. */
  gramsPerMinute: number;
  referenceSpeedHz: number;
  minSpeedHz: number;
  maxSpeedHz: number;
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * Mass flow at an arbitrary drive speed, from the single measured point.
 *
 * Proportional (see the module doc). The caller is responsible for having
 * checked that `speedHz` is inside the calibration's band — this function is the
 * relation itself, and deliberately does not silently clamp, because a clamp
 * here would return a plausible number for a speed the machine will not honour.
 */
export function continuousFlowGramsPerMinute(
  calibration: ContinuousFlowCalibration,
  speedHz: number,
): number {
  return (calibration.gramsPerMinute * speedHz) / calibration.referenceSpeedHz;
}

export interface ContinuousRunSolution {
  speedHz: number;
  runSeconds: number;
  gramsPerMinuteAtSpeed: number;
  deliveredGrams: number;
}

export interface ContinuousRunUnreachable {
  reachableRunMinutes: { min: number; max: number };
  requiredSpeedHz: number;
}

/**
 * Solve a dose into a drive speed and a run duration.
 *
 * Two unknowns, one equation (`dose = rate(speed) × time`), so the system needs
 * one more statement — and the choice of which one is a real design decision:
 *
 *   - With NO preferred duration the solver runs at `referenceSpeedHz`. That is
 *     not an arbitrary default: it is the one operating point where the rate was
 *     MEASURED rather than inferred, so the plan carries no modelling error at
 *     all. Duration then follows directly from the operator's own number
 *     ("10 g/min" → 500 g takes 50 minutes).
 *   - With a preferred duration (a meal window: feed spread slowly enough that
 *     fish can eat it) the solver keeps the duration and solves for speed. If
 *     that speed falls outside the validated band it REFUSES and reports the
 *     durations that ARE reachable. It does not clamp: clamping would silently
 *     substitute a different meal window, and it does not extrapolate, because
 *     the line is not known to hold out there.
 *
 * Returns `null`-free: either a solution or an "unreachable" describing what is.
 */
export function solveContinuousRun(
  calibration: ContinuousFlowCalibration,
  doseGrams: number,
  preferredRunMinutes?: number,
): ContinuousRunSolution | ContinuousRunUnreachable {
  const rateAtMin = continuousFlowGramsPerMinute(calibration, calibration.minSpeedHz);
  const rateAtMax = continuousFlowGramsPerMinute(calibration, calibration.maxSpeedHz);

  let speedHz: number;
  if (preferredRunMinutes === undefined) {
    speedHz = calibration.referenceSpeedHz;
  } else {
    // dose = rate(f) · t  ⇒  f = f_ref · dose / (rate_ref · t)
    const requiredSpeedHz =
      (calibration.referenceSpeedHz * doseGrams) /
      (calibration.gramsPerMinute * preferredRunMinutes);

    if (requiredSpeedHz < calibration.minSpeedHz || requiredSpeedHz > calibration.maxSpeedHz) {
      return {
        requiredSpeedHz: roundTo(requiredSpeedHz, SPEED_DECIMALS),
        reachableRunMinutes: {
          // Fastest the band allows is the top of the band.
          min: roundTo(doseGrams / rateAtMax, GRAM_DECIMALS),
          max: roundTo(doseGrams / rateAtMin, GRAM_DECIMALS),
        },
      };
    }
    speedHz = requiredSpeedHz;
  }

  // Quantise to what the hardware accepts BEFORE computing what it delivers, so
  // `deliveredGrams` describes the command that will actually be issued rather
  // than the ideal one that will not.
  const commandedSpeedHz = roundTo(speedHz, SPEED_DECIMALS);
  const gramsPerMinuteAtSpeed = continuousFlowGramsPerMinute(calibration, commandedSpeedHz);
  const runSeconds = Math.max(1, Math.round((doseGrams / gramsPerMinuteAtSpeed) * 60));

  return {
    speedHz: commandedSpeedHz,
    runSeconds,
    gramsPerMinuteAtSpeed: roundTo(gramsPerMinuteAtSpeed, GRAM_DECIMALS),
    deliveredGrams: roundTo((gramsPerMinuteAtSpeed * runSeconds) / 60, GRAM_DECIMALS),
  };
}

export interface DiscreteShotSolution {
  dispensings: number;
  deliveredGrams: number;
}

/**
 * Solve a dose into a whole number of actuations.
 *
 * A shot feeder has a quantum, so the delivered mass is `round(dose / shot)`
 * shots and almost never the dose exactly. Rounding to NEAREST rather than down
 * keeps the long-run error centred on zero instead of biasing every single meal
 * downward, which over a season is a real underfeed.
 */
export function solveDiscreteShots(
  gramsPerDispensing: number,
  doseGrams: number,
): DiscreteShotSolution {
  const dispensings = Math.round(doseGrams / gramsPerDispensing);
  return {
    dispensings,
    deliveredGrams: roundTo(dispensings * gramsPerDispensing, GRAM_DECIMALS),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface FeederDoseOptions {
  /**
   * Meal window in minutes. When supplied the solver holds the duration and
   * derives the speed; when omitted it runs at the measured reference speed.
   */
  preferredRunMinutes?: number;
  /** Clock injection point for the weight-source freshness test. */
  now?: Date;
}

/** The subset of a protocol band that identifies which feed is being dosed. */
export type FeedIdentity = Pick<ProtocolBand, 'feedId'>;

@Injectable()
export class FeederDoseDirectiveService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly doseSplitService: FeederDoseSplitService,
  ) {}

  /**
   * The primary entry point, and the reason 2.2 re-keyed calibration on
   * `feedId`: the caller hands over the PROTOCOL BAND, not a feed id it looked
   * up. When fish grow past a weight boundary the band changes, its `feedId`
   * changes with it, and the directives returned here switch to the new feed's
   * calibration with no human action and no second place to keep in step.
   */
  async planUnitDoseForBand(
    tenantId: string,
    unitId: string,
    band: FeedIdentity,
    totalKg: number,
    options?: FeederDoseOptions,
  ): Promise<FeederDoseDirective[]> {
    const allocations = await this.doseSplitService.splitDailyDose(tenantId, unitId, totalKg);
    const directives: FeederDoseDirective[] = [];
    for (const allocation of allocations) {
      directives.push(await this.planAllocation(tenantId, band.feedId, allocation, options));
    }
    return directives;
  }

  /**
   * One feeder, one feed, one dose. Exposed for the single-feeder path (a manual
   * top-up, a commissioning test run); `planUnitDoseForBand` is what the feeding
   * plan uses.
   */
  async planFeederDose(
    tenantId: string,
    feederEquipmentId: string,
    feedId: string,
    doseKg: number,
    options?: FeederDoseOptions,
  ): Promise<FeederDoseDirective> {
    return this.planAllocation(
      tenantId,
      feedId,
      {
        feederEquipmentId,
        feederName: '',
        feederCode: '',
        doseSharePercent: 100,
        kg: doseKg,
      },
      options,
    );
  }

  private async planAllocation(
    tenantId: string,
    feedId: string,
    allocation: FeederDoseAllocation,
    options?: FeederDoseOptions,
  ): Promise<FeederDoseDirective> {
    const base: FeederDoseDirectiveBase = {
      feederEquipmentId: allocation.feederEquipmentId,
      feederName: allocation.feederName,
      feederCode: allocation.feederCode,
      feedId,
      requestedGrams: roundTo(allocation.kg * 1000, GRAM_DECIMALS),
    };

    if (!(base.requestedGrams > 0)) {
      return {
        ...base,
        kind: 'refused',
        reason: FeederDoseRefusalReason.NON_POSITIVE_DOSE,
        detail: `Dose ${String(allocation.kg)} kg is not a positive mass.`,
      };
    }

    const loaded = await this.loadFeederState(tenantId, allocation.feederEquipmentId, feedId);

    if (!loaded.capability) {
      return {
        ...base,
        kind: 'refused',
        reason: FeederDoseRefusalReason.NOT_COMMISSIONED,
        detail:
          `Equipment ${allocation.feederEquipmentId} has no feeder capability row, so its ` +
          `dosing physics is unknown. Commission it as a feeder before planning a dose.`,
      };
    }

    const { capability, calibration, weightReadingAt } = loaded;

    // WHAT: fail closed when a weight-based feeder's mass source is not talking.
    //
    // WHY before the arithmetic: a weight-based feeder stops when the silo has
    // dropped by the dose. If the mass never updates, "has it dropped" is
    // unanswerable and the machine either runs on or stops on nothing. The
    // configuration alone cannot tell us the source is real — only a recent
    // reading can — so the test is on the reading, not on the id.
    if (capability.dispenseControl === FeederDispenseControl.WEIGHT_BASED) {
      const now = (options?.now ?? new Date()).getTime();
      const ageMs = weightReadingAt ? now - weightReadingAt.getTime() : undefined;
      if (ageMs === undefined || ageMs > WEIGHT_SOURCE_MAX_READING_AGE_MS) {
        return {
          ...base,
          kind: 'refused',
          reason: FeederDoseRefusalReason.WEIGHT_SOURCE_SILENT,
          detail:
            ageMs === undefined
              ? `Feeder is weight-based but its bound mass sensor ` +
                `${capability.weightSensorId ?? '(none)'} has never reported a reading.`
              : `Feeder is weight-based but its bound mass sensor ` +
                `${capability.weightSensorId ?? '(none)'} last reported ` +
                `${String(Math.round(ageMs / 60_000))} minutes ago, beyond the ` +
                `${String(WEIGHT_SOURCE_MAX_READING_AGE_MS / 60_000)}-minute freshness window.`,
        };
      }
    }

    if (!calibration) {
      return {
        ...base,
        kind: 'refused',
        reason: FeederDoseRefusalReason.NO_CALIBRATION_FOR_FEED,
        detail:
          `Feeder ${allocation.feederEquipmentId} has no calibration for feed ${feedId}. ` +
          `Another feed's calibration is not a substitute — density and coating differ, ` +
          `so the derived run would deliver an unknown mass.`,
      };
    }

    if (capability.dosingMode === FeederDosingMode.DISCRETE) {
      // The database CHECK guarantees a DISCRETE row carries this value; the
      // assertion is the type system catching up with the constraint, not a
      // runtime guard against data the schema admits.
      const gramsPerDispensing = calibration.gramsPerDispensing;
      if (gramsPerDispensing === undefined || gramsPerDispensing === null) {
        return {
          ...base,
          kind: 'refused',
          reason: FeederDoseRefusalReason.NO_CALIBRATION_FOR_FEED,
          detail: `Discrete calibration for feed ${feedId} carries no grams-per-dispensing.`,
        };
      }
      const solved = solveDiscreteShots(gramsPerDispensing, base.requestedGrams);
      return {
        ...base,
        kind: 'discrete_shots',
        dispenseControl: capability.dispenseControl,
        dispensings: solved.dispensings,
        gramsPerDispensing,
        deliveredGrams: solved.deliveredGrams,
      };
    }

    const continuous = toContinuousCalibration(calibration);
    if (!continuous) {
      return {
        ...base,
        kind: 'refused',
        reason: FeederDoseRefusalReason.NO_CALIBRATION_FOR_FEED,
        detail:
          `Continuous calibration for feed ${feedId} is incomplete — a flow rate is ` +
          `meaningless without the speed it was measured at and the band it is valid on.`,
      };
    }

    const solved = solveContinuousRun(
      continuous,
      base.requestedGrams,
      options?.preferredRunMinutes,
    );
    if (!('speedHz' in solved)) {
      return {
        ...base,
        kind: 'refused',
        reason: FeederDoseRefusalReason.RUN_WINDOW_UNREACHABLE,
        detail:
          `Delivering ${String(base.requestedGrams)} g in ` +
          `${String(options?.preferredRunMinutes)} min needs ` +
          `${String(solved.requiredSpeedHz)} Hz, outside this feeder's validated ` +
          `${String(continuous.minSpeedHz)}–${String(continuous.maxSpeedHz)} Hz band. ` +
          `Flow is only known to track drive speed inside that band.`,
        reachableRunMinutes: solved.reachableRunMinutes,
      };
    }

    return {
      ...base,
      kind: 'continuous_run',
      dispenseControl: capability.dispenseControl,
      speedHz: solved.speedHz,
      runSeconds: solved.runSeconds,
      gramsPerMinuteAtSpeed: solved.gramsPerMinuteAtSpeed,
      deliveredGrams: solved.deliveredGrams,
    };
  }

  /**
   * One trip through the tenant read boundary for everything the decision needs:
   * the feeder's capability, its calibration for this feed, and — only when the
   * feeder is weight-based — the freshness of its mass source.
   */
  private async loadFeederState(
    tenantId: string,
    feederEquipmentId: string,
    feedId: string,
  ): Promise<{
    capability: FeederCapability | null;
    calibration: FeederCalibration | null;
    weightReadingAt?: Date;
  }> {
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const capability = await tenantManagerRepo(
        queryRunner.manager,
        FeederCapability,
        tenantId,
      ).findOne({ where: { tenantId, equipmentId: feederEquipmentId } });

      if (!capability) {
        return { capability: null, calibration: null };
      }

      const calibration = await tenantManagerRepo(
        queryRunner.manager,
        FeederCalibration,
        tenantId,
      ).findOne({ where: { tenantId, equipmentId: feederEquipmentId, feedId } });

      let weightReadingAt: Date | undefined;
      if (
        capability.dispenseControl === FeederDispenseControl.WEIGHT_BASED &&
        capability.weightSensorId
      ) {
        const reading = await queryRunner.manager.findOne(FeederSiloMassLatest, {
          where: { tenantId, sensorId: capability.weightSensorId },
        });
        weightReadingAt = reading?.measuredAt;
      }

      return { capability, calibration: calibration ?? null, weightReadingAt };
    });
  }
}

/**
 * Narrow a stored calibration row to the continuous-flow shape.
 *
 * The database CHECK constraints already guarantee all four fields are present
 * together on a CONTINUOUS row; this converts that guarantee into a type the
 * physics functions can accept without any of them being optional.
 */
function toContinuousCalibration(row: FeederCalibration): ContinuousFlowCalibration | null {
  const { gramsPerMinute, referenceSpeedHz, minSpeedHz, maxSpeedHz } = row;
  if (
    gramsPerMinute === undefined ||
    gramsPerMinute === null ||
    referenceSpeedHz === undefined ||
    referenceSpeedHz === null ||
    minSpeedHz === undefined ||
    minSpeedHz === null ||
    maxSpeedHz === undefined ||
    maxSpeedHz === null
  ) {
    return null;
  }
  return { gramsPerMinute, referenceSpeedHz, minSpeedHz, maxSpeedHz };
}
