/**
 * Scheduled 18:00 FCR alert süpürmesi (C-1) — İLK durable FCRAlert emisyonu.
 *
 * Pinlenen sözleşme:
 *  - Eşikler legacy analyzeFCR ile birebir: varyans >%10 warning, >%20
 *    critical; eşik altı batch event üretmez.
 *  - Hedef P-14 zincirinin bounded bulk projection'ından okunur.
 *  - Trend YALNIZ eşiği aşan batch'ler için tek bulk sorguda çözülür.
 *  - Event outbox'a AYNI tenant transaction manager'ıyla yazılır.
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
import { ScheduledFeedingOperationExecutor } from '../executors/scheduled-feeding-operation.executor';
import type { FeedingOperationSession } from '../feeding-operation-session';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { BiomassGrowthApplierService } from '../services/biomass-growth-applier.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import type { FCRAlertEvent } from '@platform/event-contracts';
import { MealFinalizationAuthority } from '../services/meal-finalization.authority';
import { RecordingFeedingAggregateMutationPort } from '../../__tests__/support/durable-mutation-test-authority';
import {
  createScheduledFeedingOperationTestExecutor,
  createScheduledSiteFeedingOperationTestCommand,
} from '../../__tests__/support/feeding-protocol-test-authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const SESSION = Object.freeze({}) as FeedingOperationSession;

jest.mock('../feeding-operation-session', () => ({
  readFeedingOperationSession: jest.fn(() => ({
    manager: { query: managerQuery },
    tenantId: TENANT,
    operationId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
    attempt: 1,
    localDate: '2026-07-20',
    timezone: 'UTC',
    siteId: SITE,
    unitId: null,
  })),
}));

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('ScheduledFeedingOperationExecutor.sweepFcrForTenant (C-1)', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const getTargetFCRForBatches = jest.fn();
  const analyzeFCRTrendMany = jest.fn();

  const service = createScheduledFeedingOperationTestExecutor({
    feedingMutations: new RecordingFeedingAggregateMutationPort(),
    dataSource: mock<DataSource>({}),
    generator: mock<MealPlanGeneratorService>({}),
    growthApplier: mock<BiomassGrowthApplierService>({}),
    mealFinalization: mock<MealFinalizationAuthority>({}),
    temperatureService: mock<WaterTemperatureService>({}),
    fcrCalculation: mock<FCRCalculationService>({
      getTargetFCRForBatches,
      analyzeFCRTrendMany,
    }),
    outboxPublisher: mock<OutboxPublisher>({ enqueue }),
    forecastExecutor: mock<ProtocolFeedForecastExecutor>({}),
    mobileCommandReceipts: mock<MobileCommandReceiptService>({}),
  });

  const scheduledCommand = createScheduledSiteFeedingOperationTestCommand({
    jobId: 'v2.fcr-alert.sweep',
    tenantId: TENANT,
    siteId: SITE,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getTargetFCRForBatches.mockImplementation(
      async (_tenantId: string, batchIds: readonly string[]) =>
        new Map(batchIds.map((batchId) => [batchId, 1.5])),
    );
    analyzeFCRTrendMany.mockImplementation(
      async (_tenantId: string, batchIds: readonly string[]) =>
        new Map(batchIds.map((batchId) => [batchId, { trend: 'declining' }])),
    );
  });

  it('emits warning (>%10) ve critical (>%20) — eşik altı batch event üretmez', async () => {
    managerQuery.mockResolvedValueOnce([
      { id: 'b-warning', actual: 1.72 }, // +14.7% → warning
      { id: 'b-ok', actual: 1.55 }, // +3.3% → eşik altı
      { id: 'b-critical', actual: 2.0 }, // +33.3% → critical
    ]);

    await service.executeScheduledOperation(SESSION, scheduledCommand);

    expect(enqueue).toHaveBeenCalledTimes(2);
    const events = enqueue.mock.calls.map((call) => call[0] as FCRAlertEvent);
    const warning = events.find((e) => e.batchId === 'b-warning');
    const critical = events.find((e) => e.batchId === 'b-critical');

    expect(warning).toMatchObject({
      eventType: 'FCRAlert',
      alertLevel: 'warning',
      currentFCR: 1.72,
      targetFCR: 1.5,
      trend: 'declining',
    });
    expect(warning!.variancePercent).toBeCloseTo(14.667, 3);
    expect(critical).toMatchObject({ alertLevel: 'critical', currentFCR: 2 });

    expect(getTargetFCRForBatches).toHaveBeenCalledWith(TENANT, [
      'b-warning',
      'b-ok',
      'b-critical',
    ]);
    // Trend yalnız eşiği aşan iki batch için TEK bulk projection'da çözüldü.
    expect(analyzeFCRTrendMany).toHaveBeenCalledTimes(1);
    expect(analyzeFCRTrendMany).toHaveBeenCalledWith(TENANT, [
      'b-warning',
      'b-critical',
    ]);
    // Outbox aynı tenant-tx manager'ıyla yazıldı.
    expect(enqueue.mock.calls[0]![1]).toMatchObject({ query: managerQuery });
  });

  it('hedefi P-14 zincirinden okur; hedef çözülemeyen batch atlanır', async () => {
    managerQuery.mockResolvedValueOnce([
      { id: 'b-1', actual: 2.0 },
      { id: 'b-no-target', actual: 2.0 },
    ]);
    getTargetFCRForBatches.mockImplementation(
      async (_tenantId: string, batchIds: readonly string[]) =>
        new Map(batchIds.map((batchId) => [batchId, batchId === 'b-no-target' ? 0 : 1.5])),
    );

    await service.executeScheduledOperation(SESSION, scheduledCommand);

    expect(getTargetFCRForBatches).toHaveBeenCalledWith(TENANT, ['b-1', 'b-no-target']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((enqueue.mock.calls[0]![0] as FCRAlertEvent).batchId).toBe('b-1');
  });

  it('hiç ihlal yoksa hiçbir event yazılmaz', async () => {
    managerQuery.mockResolvedValueOnce([{ id: 'b-ok', actual: 1.5 }]);

    await service.executeScheduledOperation(SESSION, scheduledCommand);

    expect(enqueue).not.toHaveBeenCalled();
    expect(analyzeFCRTrendMany).not.toHaveBeenCalled();
  });
});
