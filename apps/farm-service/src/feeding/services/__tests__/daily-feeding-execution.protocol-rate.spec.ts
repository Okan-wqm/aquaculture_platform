/**
 * DailyFeedingExecutionService.calculateDailyFeed — protocol precedence (Phase 3).
 *
 * When the tank's primary batch carries a feeding protocol, the protocol's
 * feedPercent(weight) × tempMultiplier drives the daily-plan rate — the SAME
 * calculator the tanks-page DataLoader uses — overriding the feed-derived rate.
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
import { StockMovementService } from '../../../storage/services/stock-movement.service';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';
const PROTOCOL = '33333333-3333-4333-8333-333333333333';
const DEFAULT_RATE = 3.0; // no matrix/curve on the feed → service default

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
    mock<StockMovementService>({}),
    mock<MobileCommandReceiptService>({}),
    mock<SiteAuthorizationService>({}),
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

const programTank = mock<FeedingProgramTank>({ equipmentId: 'tank-1', equipmentCode: 'T-1' });

function tankState(batchId?: string): TankCurrentState {
  return {
    tankId: 'tank-1',
    tankName: 'Tank 1',
    tankCode: 'T-1',
    avgWeightG: 100,
    fishCount: 1000,
    biomassKg: 100,
    waterTempC: 12,
    usingDefaultTemperature: false,
    batchId,
  };
}

describe('DailyFeedingExecutionService.calculateDailyFeed — protocol precedence', () => {
  it('keeps the feed-derived rate when the batch has no protocol', async () => {
    const query = jest.fn().mockResolvedValue([]); // batches_v2 → no protocolId
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(BATCH), programTank, TENANT);

    expect(result.feedingRatePercent).toBe(DEFAULT_RATE);
  });

  it('drives the rate from the protocol when the batch has one', async () => {
    // avgWeight 100g → feedPercent 2.2; waterTemp 12°C → multiplier 1.0 → rate 2.2%.
    const query = jest.fn((sql: string) => {
      if (sql.includes('batches_v2')) return Promise.resolve([{ protocolId: PROTOCOL }]);
      if (sql.includes('feeding_protocols')) {
        return Promise.resolve([
          {
            growthStageProtocols: [
              { minWeight: 50, maxWeight: 200, weightUnit: 'g', feedPercent: 2.2 },
            ],
            temperatureRanges: [{ min: 10, max: 15, unit: 'celsius', feedingMultiplier: 1.0 }],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(BATCH), programTank, TENANT);

    expect(result.feedingRatePercent).toBe(2.2);
    expect(result.feedingRatePercent).not.toBe(DEFAULT_RATE);
  });

  it('does NOT scale the protocol rate with a DEFAULTED temperature (fabricated 15C)', async () => {
    // Temp band 10..20C carries multiplier 0.5 — if the fabricated default 15C
    // leaked into the protocol branch the rate would halve. With
    // usingDefaultTemperature the protocol must see NO temperature (multiplier 1).
    const query = jest.fn((sql: string) => {
      if (sql.includes('batches_v2')) return Promise.resolve([{ protocolId: PROTOCOL }]);
      if (sql.includes('feeding_protocols')) {
        return Promise.resolve([
          {
            growthStageProtocols: [
              { minWeight: 50, maxWeight: 200, weightUnit: 'g', feedPercent: 2.2 },
            ],
            temperatureRanges: [{ min: 10, max: 20, unit: 'celsius', feedingMultiplier: 0.5 }],
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const service = makeService(query);

    const defaulted = { ...tankState(BATCH), waterTempC: 15, usingDefaultTemperature: true };
    const result = await service.calculateDailyFeed(program, defaulted, programTank, TENANT);

    expect(result.feedingRatePercent).toBe(2.2); // base × 1.0, NOT 1.1
  });

  it('skips the protocol lookup entirely when the tank has no primary batch', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = makeService(query);

    const result = await service.calculateDailyFeed(program, tankState(undefined), programTank, TENANT);

    expect(result.feedingRatePercent).toBe(DEFAULT_RATE);
    expect(query).not.toHaveBeenCalled();
  });
});
