/**
 * DailyFeedingExecutionService.calculateDailyFeed — protocol precedence.
 *
 * The contract under test changed shape: protocol authority is the TANK's
 * active v2 `ProtocolAssignment`, not `batches_v2.protocolId`. That column had
 * no writer anywhere in the repo, so the old batch-keyed lookup could only ever
 * return "no protocol" — these tests used to pass by feeding the service a row
 * production never produced. They now drive the real assignment ⋈ protocol
 * join, through a real `UnitProtocolResolverService` over a real
 * `ProtocolRateService`: only the DataSource is a double, so the band/
 * temperature/override math being asserted is the shipped math.
 *
 * Doubles are built through a typed factory (a single `as T`, matching the
 * sibling daily-feeding-execution.service.spec.ts).
 */
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import {
  DailyFeedingExecutionService,
  TankCurrentState,
} from '../daily-feeding-execution.service';
import { FeedingProgram, FCRSource, FeedAssignment } from '../../entities/feeding-program.entity';
import { FeedingProgramTank } from '../../entities/feeding-program-tank.entity';
import { Feed } from '../../../feed/entities/feed.entity';
import { BilinearInterpolationService } from '../bilinear-interpolation.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { FeedingLedgerService } from '../feeding-ledger.service';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import {
  ProtocolRateService,
  derivedBandWeightG,
} from '../../../feeding-protocol/services/protocol-rate.service';
import { UnitProtocolResolverService } from '../../../feeding-protocol/services/unit-protocol-resolver.service';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = '33333333-3333-4333-8333-333333333333';
const TANK = 'tank-1';
const DEFAULT_RATE = 3.0; // no matrix/curve on the feed → service default

/** Bands covering the fixture weight (100 g) at 2.2 % of body weight. */
const BANDS = [
  {
    minWeightG: 50,
    maxWeightG: 200,
    feedId: 'feed-p1',
    feedCode: 'P1',
    feedName: 'Protocol Feed 1',
    feedingRatePercent: 2.2,
    expectedFcr: 1.1,
  },
];

/** Service whose collaborators implement only what calculateDailyFeed touches. */
function makeService(query: jest.Mock): DailyFeedingExecutionService {
  const emptyRepo = <T extends ObjectLiteral>(): Repository<T> => mock<Repository<T>>({});
  return new DailyFeedingExecutionService(
    emptyRepo(),
    emptyRepo(),
    emptyRepo(),
    emptyRepo(),
    emptyRepo(),
    emptyRepo(),
    mock<Repository<Feed>>({
      findOne: jest
        .fn()
        .mockResolvedValue(mock<Feed>({ id: 'feed-1', code: 'F1', name: 'Feed 1' })),
    }),
    mock<BilinearInterpolationService>({}),
    mock<WaterTemperatureService>({}),
    mock<DataSource>({ query }),
    mock<BatchDomainService>({}),
    mock<FeedingLedgerService>({}),
    mock<BiomassGrowthApplierService>({}),
    mock<MobileCommandReceiptService>({}),
    mock<SiteAuthorizationService>({}),
    // Real resolver + real rate math — mocking these would mock away the exact
    // behaviour under test.
    new UnitProtocolResolverService(new ProtocolRateService()),
  );
}

const program = mock<FeedingProgram>({
  code: 'PROG-1',
  settings: mock<FeedingProgram['settings']>({
    fcrSource: FCRSource.FEED,
    defaultMealsPerDay: 4,
  }),
  findFeedForWeight: (): FeedAssignment =>
    mock<FeedAssignment>({ feedId: 'feed-1', feedCode: 'F1', feedName: 'Feed 1' }),
  isTransitionApproaching: () => ({ approaching: false }),
});

const programTank = mock<FeedingProgramTank>({ equipmentId: TANK, equipmentCode: 'T-1' });

/**
 * 1000 fish × 100 g = 100 kg — so the derived band weight is exactly 100 g,
 * inside the fixture band.
 */
function tankState(batchId?: string): TankCurrentState {
  return {
    tankId: TANK,
    tankName: 'Tank 1',
    tankCode: 'T-1',
    avgWeightG: derivedBandWeightG(100, 1000),
    fishCount: 1000,
    biomassKg: 100,
    waterTempC: 12,
    usingDefaultTemperature: false,
    batchId,
  };
}

/**
 * One assignment ⋈ protocol row for the tank. `temperatureAdjustments` is the
 * knob the P-20 test flips.
 */
function assignmentRow(
  temperatureAdjustments: Array<{ minC: number; maxC: number; rateMultiplier: number }>,
  overrides: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    unitId: TANK,
    overrides,
    protocolId: PROTOCOL,
    protocolName: 'Std Protocol',
    bands: BANDS,
    temperatureAdjustments,
    settings: { fcrSource: 'band' },
  };
}

describe('DailyFeedingExecutionService.calculateDailyFeed — protocol precedence', () => {
  it('keeps the feed-derived rate when the tank has no active assignment', async () => {
    const query = jest.fn().mockResolvedValue([]); // no assignment row
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(BATCH), programTank, TENANT);

    expect(result.feedingRatePercent).toBe(DEFAULT_RATE);
    // The lookup was attempted against the v2 tables, not batches_v2.
    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain('feeding_protocol_assignments');
    expect(sql).not.toContain('batches_v2');
  });

  it("drives the rate from the tank's assigned protocol band", async () => {
    // 100 g → band 2.2 %; 12 °C → multiplier 1.0 → 2.2 %.
    const query = jest.fn().mockResolvedValue([
      assignmentRow([{ minC: 10, maxC: 15, rateMultiplier: 1.0 }]),
    ]);
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(BATCH), programTank, TENANT);

    expect(result.feedingRatePercent).toBe(2.2);
    expect(result.feedingRatePercent).not.toBe(DEFAULT_RATE);
  });

  it("applies the assignment's rate override, like the 06:00 generator", async () => {
    // 2.2 % × 1.0 × (1 + 10/100) = 2.42 — proof the daily plan honours the same
    // unit-level override the v2 engine does, which the batch-keyed v1 lookup
    // had no way to see at all.
    const query = jest.fn().mockResolvedValue([
      assignmentRow([{ minC: 10, maxC: 15, rateMultiplier: 1.0 }], { rateAdjustmentPercent: 10 }),
    ]);
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(BATCH), programTank, TENANT);

    expect(result.feedingRatePercent).toBeCloseTo(2.42, 6);
  });

  it('does NOT scale the protocol rate with a DEFAULTED temperature (fabricated 15C)', async () => {
    // Temp band 10..20C carries multiplier 0.5 — if the fabricated default 15C
    // leaked into the protocol branch the rate would halve. With
    // usingDefaultTemperature the protocol must see NO temperature (multiplier 1).
    const query = jest.fn().mockResolvedValue([
      assignmentRow([{ minC: 10, maxC: 20, rateMultiplier: 0.5 }]),
    ]);
    const service = makeService(query);

    const defaulted = { ...tankState(BATCH), waterTempC: 15, usingDefaultTemperature: true };
    const result = await service.calculateDailyFeed(program, defaulted, programTank, TENANT);

    expect(result.feedingRatePercent).toBe(2.2); // base × 1.0, NOT 1.1
  });

  it('resolves the protocol even when the tank has no primary batch', async () => {
    // The point of the unit re-key: the TANK is authoritative. A tank holding
    // fish but carrying no primaryBatchId still follows its own protocol, where
    // the batch-keyed lookup silently skipped it.
    const query = jest.fn().mockResolvedValue([
      assignmentRow([{ minC: 10, maxC: 15, rateMultiplier: 1.0 }]),
    ]);
    const service = makeService(query);

    const result = await service.calculateDailyFeed(
      program,
      tankState(undefined),
      programTank,
      TENANT,
    );

    expect(result.feedingRatePercent).toBe(2.2);
    expect(query).toHaveBeenCalled();
  });
});
