/**
 * Proof that a dose in kilograms becomes a drive command with nobody doing
 * arithmetic by hand — and that every case the model cannot honestly answer is
 * REFUSED rather than approximated.
 *
 * The numbers are the operator's own: one feed that flows at 10 g/min through
 * this auger and another that flows at 40 g/min through the same machine. Every
 * expectation below is derivable on paper from those two figures, which is the
 * point — if the implementation and the physics ever part company, the paper
 * number is the arbiter.
 */
import { createMockDataSource } from '@aquaculture/testing';

import {
  FeederCapability,
  FeederDispenseControl,
  FeederDosingMode,
} from '../../equipment/entities/feeder-capability.entity';
import { FeederCalibration } from '../../equipment/entities/feeder-calibration.entity';
import { FeederSiloMassLatest } from '../../equipment/entities/feeder-silo-mass-latest.entity';
import {
  continuousFlowGramsPerMinute,
  FeederDoseDirectiveService,
  FeederDoseRefusalReason,
  solveContinuousRun,
  solveDiscreteShots,
  WEIGHT_SOURCE_MAX_READING_AGE_MS,
  type ContinuousFlowCalibration,
} from '../services/feeder-dose-directive.service';
import { FeederDoseSplitService } from '../services/feeder-dose-split.service';
import { FeederAssignment } from '../entities/feeder-assignment.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FEEDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FEED_X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FEED_Y = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MASS_SENSOR = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** The operator's slow feed: 10 g/min, measured at 25 Hz, valid 10–50 Hz. */
const FEED_X_CALIBRATION: ContinuousFlowCalibration = {
  gramsPerMinute: 10,
  referenceSpeedHz: 25,
  minSpeedHz: 10,
  maxSpeedHz: 50,
};

/** The operator's fast feed: 40 g/min through the SAME machine and band. */
const FEED_Y_CALIBRATION: ContinuousFlowCalibration = {
  gramsPerMinute: 40,
  referenceSpeedHz: 25,
  minSpeedHz: 10,
  maxSpeedHz: 50,
};

describe('continuous-flow physics', () => {
  it('scales flow linearly with drive speed through the origin', () => {
    // A volumetric auger moves a fixed mass per revolution and revolutions
    // track drive frequency, so doubling the frequency doubles the flow.
    expect(continuousFlowGramsPerMinute(FEED_X_CALIBRATION, 50)).toBe(20);
    expect(continuousFlowGramsPerMinute(FEED_X_CALIBRATION, 25)).toBe(10);
    expect(continuousFlowGramsPerMinute(FEED_X_CALIBRATION, 12.5)).toBe(5);
    expect(continuousFlowGramsPerMinute(FEED_Y_CALIBRATION, 50)).toBe(80);
  });

  it('runs at the MEASURED speed when no meal window is requested', () => {
    // 500 g of a 10 g/min feed is 50 minutes. Nothing else is derivable without
    // stating a window, and the reference speed is the only operating point
    // where the rate was measured rather than inferred.
    const solved = solveContinuousRun(FEED_X_CALIBRATION, 500);

    expect(solved).toEqual({
      speedHz: 25,
      runSeconds: 3000,
      gramsPerMinuteAtSpeed: 10,
      deliveredGrams: 500,
    });
  });

  it('derives a DIFFERENT duration for a faster feed at the same dose and speed', () => {
    // Same machine, same 500 g, same 25 Hz — the feed alone changes the answer.
    // 500 / 40 = 12.5 min.
    const solved = solveContinuousRun(FEED_Y_CALIBRATION, 500);

    expect(solved).toEqual({
      speedHz: 25,
      runSeconds: 750,
      gramsPerMinuteAtSpeed: 40,
      deliveredGrams: 500,
    });
  });

  it('derives the SPEED when the meal window is fixed', () => {
    // 500 g in 25 min needs 20 g/min. The slow feed does 10 g/min at 25 Hz, so
    // it needs twice that: 50 Hz. The fast feed does 40 g/min at 25 Hz, so it
    // needs half: 12.5 Hz. Two feeds, one requested window, two speeds, and no
    // human computed either.
    expect(solveContinuousRun(FEED_X_CALIBRATION, 500, 25)).toEqual({
      speedHz: 50,
      runSeconds: 1500,
      gramsPerMinuteAtSpeed: 20,
      deliveredGrams: 500,
    });
    expect(solveContinuousRun(FEED_Y_CALIBRATION, 500, 25)).toEqual({
      speedHz: 12.5,
      runSeconds: 1500,
      gramsPerMinuteAtSpeed: 20,
      deliveredGrams: 500,
    });
  });

  it('refuses a window that would need a speed outside the validated band', () => {
    // 500 g in 5 min is 100 g/min — ten times the measured rate, i.e. 250 Hz on
    // a drive commissioned to 50. The line is not known to hold there and
    // beyond the top of the band the screw under-fills, so the real delivery
    // would fall BELOW the prediction and nothing would report it.
    const solved = solveContinuousRun(FEED_X_CALIBRATION, 500, 5);

    expect(solved).toEqual({
      requiredSpeedHz: 250,
      reachableRunMinutes: { min: 25, max: 125 },
    });
    expect('speedHz' in solved).toBe(false);
  });

  it('refuses a window that would need a speed below the band', () => {
    // 500 g stretched over 200 min is 2.5 g/min — a quarter of the measured
    // rate, i.e. 6.25 Hz. Below the band the motor loses torque and the hopper
    // bridges; the auger may deliver nothing at all.
    const solved = solveContinuousRun(FEED_X_CALIBRATION, 500, 200);

    expect(solved).toEqual({
      requiredSpeedHz: 6.25,
      reachableRunMinutes: { min: 25, max: 125 },
    });
  });

  it('does not silently clamp — the relation itself extrapolates only if asked', () => {
    // The pure relation is deliberately unguarded so it cannot quietly return a
    // plausible number for an un-commissioned speed; refusing is the SOLVER's
    // job, and the tests above prove it does it.
    expect(continuousFlowGramsPerMinute(FEED_X_CALIBRATION, 250)).toBe(100);
  });

  it('reports what the drive will actually deliver after hardware rounding', () => {
    // 333 g at 10 g/min is 1998 s exactly; awkward doses must still reconcile.
    const solved = solveContinuousRun(FEED_X_CALIBRATION, 333);
    expect('speedHz' in solved && solved.deliveredGrams).toBe(333);

    // A dose whose ideal run time is not a whole second reports the quantised
    // truth rather than the request.
    const awkward = solveContinuousRun({ ...FEED_X_CALIBRATION, gramsPerMinute: 7 }, 100);
    expect('runSeconds' in awkward && Number.isInteger(awkward.runSeconds)).toBe(true);
    expect('deliveredGrams' in awkward && Math.abs(awkward.deliveredGrams - 100)).toBeLessThan(0.1);
  });
});

describe('discrete shot physics', () => {
  it('turns a dose into a whole number of actuations', () => {
    expect(solveDiscreteShots(12.5, 500)).toEqual({ dispensings: 40, deliveredGrams: 500 });
  });

  it('reports the quantisation instead of pretending the dose was exact', () => {
    // A shot feeder cannot fire 40.4 shots. 40 shots is 500 g, not 505.
    expect(solveDiscreteShots(12.5, 505)).toEqual({ dispensings: 40, deliveredGrams: 500 });
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface Fixture {
  service: FeederDoseDirectiveService;
  rows: {
    capability: FeederCapability | null;
    calibrations: FeederCalibration[];
    massReading: FeederSiloMassLatest | null;
  };
}

function capability(overrides: Partial<FeederCapability> = {}): FeederCapability {
  return {
    tenantId: TENANT,
    equipmentId: FEEDER,
    dosingMode: FeederDosingMode.CONTINUOUS,
    minSpeedHz: 10,
    maxSpeedHz: 50,
    dispenseControl: FeederDispenseControl.TIME_BASED,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as FeederCapability;
}

function continuousCalibration(feedId: string, gramsPerMinute: number): FeederCalibration {
  return {
    id: `cal-${feedId}`,
    tenantId: TENANT,
    equipmentId: FEEDER,
    feedId,
    dosingMode: FeederDosingMode.CONTINUOUS,
    gramsPerMinute,
    referenceSpeedHz: 25,
    minSpeedHz: 10,
    maxSpeedHz: 50,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as FeederCalibration;
}

function makeFixture(): Fixture {
  const rows: Fixture['rows'] = {
    capability: capability(),
    calibrations: [continuousCalibration(FEED_X, 10), continuousCalibration(FEED_Y, 40)],
    massReading: null,
  };

  const { mockDataSource, mockManager } = createMockDataSource();

  // Route each entity's reads at its own fixture slice. `tenantManagerRepo`
  // funnels through `manager.getRepository`, so one implementation covers both
  // the tenant-scoped repositories and the plain manager reads.
  const findOneFor = (entity: unknown, options: { where?: Record<string, unknown> }) => {
    if (entity === FeederCapability) {
      return Promise.resolve(rows.capability);
    }
    if (entity === FeederCalibration) {
      const feedId = options.where?.feedId;
      return Promise.resolve(rows.calibrations.find((row) => row.feedId === feedId) ?? null);
    }
    if (entity === FeederSiloMassLatest) {
      return Promise.resolve(rows.massReading);
    }
    return Promise.resolve(null);
  };

  // The unit's active feeder assignment — the upstream link in the chain. It is
  // a real row read by the REAL split service below, not a stubbed return: the
  // point of this suite is that unit → feeder → share → calibration → drive
  // command holds end to end, and a stubbed split would cut the chain in half.
  const assignments = [
    {
      feederEquipmentId: FEEDER,
      feederName: 'Auger 1',
      feederCode: 'FD-1',
      doseSharePercent: 100,
    } as FeederAssignment,
  ];

  (mockManager.getRepository as jest.Mock).mockImplementation((entity: unknown) => ({
    findOne: jest.fn((options: { where?: Record<string, unknown> }) =>
      findOneFor(entity, options ?? {}),
    ),
    find: jest.fn(() =>
      Promise.resolve(entity === FeederAssignment ? assignments : ([] as unknown[])),
    ),
  }));
  (mockManager.findOne as jest.Mock).mockImplementation(
    (entity: unknown, options: { where?: Record<string, unknown> }) =>
      findOneFor(entity, options ?? {}),
  );

  return {
    service: new FeederDoseDirectiveService(
      mockDataSource,
      new FeederDoseSplitService(mockDataSource),
    ),
    rows,
  };
}

describe('FeederDoseDirectiveService', () => {
  it('plans a unit dose straight from the protocol band, with no feed id typed by anyone', async () => {
    const { service } = makeFixture();

    // 0.5 kg of the slow feed at its measured 10 g/min → 50 minutes at 25 Hz.
    const [directive] = await service.planUnitDoseForBand(TENANT, UNIT, { feedId: FEED_X }, 0.5);

    expect(directive).toMatchObject({
      kind: 'continuous_run',
      feedId: FEED_X,
      requestedGrams: 500,
      speedHz: 25,
      runSeconds: 3000,
      deliveredGrams: 500,
    });
  });

  it('follows a band change to a new feed with no other input altered', async () => {
    const { service } = makeFixture();

    // The ONLY thing that changes between these two calls is the band handed
    // in — exactly what happens when fish grow past a weight boundary. The
    // calibration set, the feeder and the dose are identical.
    const [slow] = await service.planUnitDoseForBand(TENANT, UNIT, { feedId: FEED_X }, 0.5);
    const [fast] = await service.planUnitDoseForBand(TENANT, UNIT, { feedId: FEED_Y }, 0.5);

    expect(slow).toMatchObject({ kind: 'continuous_run', feedId: FEED_X, runSeconds: 3000 });
    expect(fast).toMatchObject({ kind: 'continuous_run', feedId: FEED_Y, runSeconds: 750 });
  });

  it('REFUSES a feed it has no calibration for instead of borrowing another feed’s', async () => {
    const { service } = makeFixture();
    const unknownFeed = '99999999-9999-4999-8999-999999999999';

    const [directive] = await service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: unknownFeed },
      0.5,
    );

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.NO_CALIBRATION_FOR_FEED,
    });
    expect('speedHz' in directive!).toBe(false);
  });

  it('REFUSES a feeder that was never commissioned', async () => {
    const fixture = makeFixture();
    fixture.rows.capability = null;

    const [directive] = await fixture.service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: FEED_X },
      0.5,
    );

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.NOT_COMMISSIONED,
    });
  });

  it('REFUSES a weight-based feeder whose load cell has never reported', async () => {
    const fixture = makeFixture();
    fixture.rows.capability = capability({
      dispenseControl: FeederDispenseControl.WEIGHT_BASED,
      weightSensorId: MASS_SENSOR,
    });
    fixture.rows.massReading = null;

    const [directive] = await fixture.service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: FEED_X },
      0.5,
    );

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.WEIGHT_SOURCE_SILENT,
    });
  });

  it('REFUSES a weight-based feeder whose load cell has gone quiet', async () => {
    const now = new Date('2026-08-07T12:00:00.000Z');
    const fixture = makeFixture();
    fixture.rows.capability = capability({
      dispenseControl: FeederDispenseControl.WEIGHT_BASED,
      weightSensorId: MASS_SENSOR,
    });
    fixture.rows.massReading = {
      tenantId: TENANT,
      sensorId: MASS_SENSOR,
      massKg: 420,
      measuredAt: new Date(now.getTime() - WEIGHT_SOURCE_MAX_READING_AGE_MS - 60_000),
    };

    const [directive] = await fixture.service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: FEED_X },
      0.5,
      { now },
    );

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.WEIGHT_SOURCE_SILENT,
    });
  });

  it('plans a weight-based feeder whose load cell is actually reporting', async () => {
    const now = new Date('2026-08-07T12:00:00.000Z');
    const fixture = makeFixture();
    fixture.rows.capability = capability({
      dispenseControl: FeederDispenseControl.WEIGHT_BASED,
      weightSensorId: MASS_SENSOR,
    });
    fixture.rows.massReading = {
      tenantId: TENANT,
      sensorId: MASS_SENSOR,
      massKg: 420,
      measuredAt: new Date(now.getTime() - 60_000),
    };

    const [directive] = await fixture.service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: FEED_X },
      0.5,
      { now },
    );

    expect(directive).toMatchObject({
      kind: 'continuous_run',
      dispenseControl: FeederDispenseControl.WEIGHT_BASED,
      speedHz: 25,
      runSeconds: 3000,
    });
  });

  it('REFUSES an unreachable meal window and says which windows ARE reachable', async () => {
    const { service } = makeFixture();

    const [directive] = await service.planUnitDoseForBand(TENANT, UNIT, { feedId: FEED_X }, 0.5, {
      preferredRunMinutes: 5,
    });

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.RUN_WINDOW_UNREACHABLE,
      reachableRunMinutes: { min: 25, max: 125 },
    });
  });

  it('plans a discrete feeder as a shot count, never as a speed', async () => {
    const fixture = makeFixture();
    fixture.rows.capability = capability({
      dosingMode: FeederDosingMode.DISCRETE,
      minSpeedHz: undefined,
      maxSpeedHz: undefined,
    });
    fixture.rows.calibrations = [
      {
        id: 'cal-discrete',
        tenantId: TENANT,
        equipmentId: FEEDER,
        feedId: FEED_X,
        dosingMode: FeederDosingMode.DISCRETE,
        gramsPerDispensing: 12.5,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as FeederCalibration,
    ];

    const [directive] = await fixture.service.planUnitDoseForBand(
      TENANT,
      UNIT,
      { feedId: FEED_X },
      0.5,
    );

    expect(directive).toMatchObject({
      kind: 'discrete_shots',
      dispensings: 40,
      gramsPerDispensing: 12.5,
      deliveredGrams: 500,
    });
    expect('speedHz' in directive!).toBe(false);
  });

  it('REFUSES a non-positive dose', async () => {
    const { service } = makeFixture();

    const directive = await service.planFeederDose(TENANT, FEEDER, FEED_X, 0);

    expect(directive).toMatchObject({
      kind: 'refused',
      reason: FeederDoseRefusalReason.NON_POSITIVE_DOSE,
    });
  });
});
