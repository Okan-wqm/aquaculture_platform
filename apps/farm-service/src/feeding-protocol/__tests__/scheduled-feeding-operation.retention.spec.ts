/**
 * Scheduled aylık retention temizliği (K-16 + NFR "Receipt büyümesi").
 *
 * Pinlenen sözleşme:
 *  - Day plan + öğünler 24 AY, forecast 30 GÜN ve mobil komut makbuzları
 *    90 GÜN pencereleriyle kendi kapalı mutation authority'lerinde silinir.
 *  - Silme sırası: önce öğünler, sonra planlar, forecast ve makbuzlar — yarıda
 *    kesilen koşu öksüz öğün bırakamaz.
 *  - Her silme aynı verified tenant mutation session'ında koşar.
 */
const managerQuery = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (qr: { manager: { query: typeof managerQuery } }) => Promise<void>,
  ) => cb({ manager: { query: managerQuery } }),
}));

import { ProtocolFeedForecastExecutor } from '../executors/protocol-feed-forecast.executor';
import { FORECAST_RETENTION_DAYS } from '../executors/protocol-feed-forecast.executor';
import type { FeedingOperationSession } from '../feeding-operation-session';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { MealFinalizationAuthority } from '../services/meal-finalization.authority';
import { RecordingFeedingAggregateMutationPort } from '../../__tests__/support/durable-mutation-test-authority';
import {
  createScheduledFeedingOperationTestExecutor,
  createScheduledTenantFeedingOperationTestCommand,
} from '../../__tests__/support/feeding-protocol-test-authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION = Object.freeze({}) as FeedingOperationSession;
const MUTATION_SESSION = Object.freeze({}) as TenantMutationSession;
const OBSERVED_AT = new Date('2026-08-01T04:00:00.000Z');

jest.mock('../feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date(OBSERVED_AT.getTime())),
  readFeedingOperationSession: jest.fn(() => ({
    manager: { query: managerQuery },
    mutationSession: MUTATION_SESSION,
    tenantId: TENANT,
    operationId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    attempt: 1,
    observedAt: OBSERVED_AT,
    localDate: '2026-07-20',
    timezone: 'UTC',
    siteId: null,
    unitId: null,
  })),
}));

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('ScheduledFeedingOperationExecutor.purgeTenantRetention', () => {
  const feedingMutations = new RecordingFeedingAggregateMutationPort();
  const purgeBeforeRetention = jest.fn().mockResolvedValue(0);
  const service = createScheduledFeedingOperationTestExecutor({
    feedingMutations,
    dataSource: mock<DataSource>({}),
    generator: mock<MealPlanGeneratorService>({}),
    growthApplier: mock<BiomassGrowthApplierService>({}),
    mealFinalization: mock<MealFinalizationAuthority>({}),
    temperatureService: mock<WaterTemperatureService>({}),
    fcrCalculation: mock<FCRCalculationService>({}),
    outboxPublisher: mock<OutboxPublisher>({ enqueue: jest.fn() }),
    forecastExecutor: mock<ProtocolFeedForecastExecutor>({}),
    mobileCommandReceipts: mock<MobileCommandReceiptService>({ purgeBeforeRetention }),
  });
  const scheduledCommand = createScheduledTenantFeedingOperationTestCommand({
    jobId: 'v2.retention.purge',
    tenantId: TENANT,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    managerQuery.mockResolvedValue([{ count: 0 }]);
  });

  it('kanonik retention pencerelerini kapalı otoriteler üzerinden doğru sırada uygular', async () => {
    await service.executeScheduledOperation(SESSION, scheduledCommand);

    expect(feedingMutations.purgeMealsBeforeRetention).toHaveBeenCalledWith(MUTATION_SESSION, 24);
    expect(feedingMutations.purgeDayPlansBeforeRetention).toHaveBeenCalledWith(
      MUTATION_SESSION,
      24,
    );
    expect(feedingMutations.purgeForecastProjectionBefore).toHaveBeenCalledWith(
      MUTATION_SESSION,
      new Date(OBSERVED_AT.getTime() - FORECAST_RETENTION_DAYS * 24 * 60 * 60 * 1000),
    );
    expect(purgeBeforeRetention).toHaveBeenCalledWith(expect.anything(), {
      tableName: 'farm_mobile_command_receipts',
      tenantId: TENANT,
      retentionDays: 90,
    });

    expect(feedingMutations.purgeMealsBeforeRetention.mock.invocationCallOrder[0]).toBeLessThan(
      feedingMutations.purgeDayPlansBeforeRetention.mock.invocationCallOrder[0]!,
    );
    expect(feedingMutations.purgeDayPlansBeforeRetention.mock.invocationCallOrder[0]).toBeLessThan(
      feedingMutations.purgeForecastProjectionBefore.mock.invocationCallOrder[0]!,
    );
    expect(feedingMutations.purgeForecastProjectionBefore.mock.invocationCallOrder[0]).toBeLessThan(
      purgeBeforeRetention.mock.invocationCallOrder[0]!,
    );
    expect(managerQuery).not.toHaveBeenCalled();
  });
});
