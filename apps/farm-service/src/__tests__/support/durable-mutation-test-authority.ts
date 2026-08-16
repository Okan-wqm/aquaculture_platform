import {
  runInTenantTransaction,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { Test, type TestingModule } from '@nestjs/testing';
import { mockTenantTransactionControlQuery } from '@aquaculture/testing';
import { DataSource, type EntityManager } from 'typeorm';

import {
  BATCH_AGGREGATE_MUTATION_PORT_PROVIDER,
  BatchAggregateMutationPort,
} from '../../batch/batch-aggregate-mutation.port';
import {
  FEEDING_AGGREGATE_MUTATION_PORT_PROVIDER,
  FeedingAggregateMutationPort,
} from '../../feeding-protocol/feeding-aggregate-mutation.writer';
import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';

/**
 * Test composition for the same closed mutation adapters used by production.
 * The provider bindings remain the single authority for concrete adapter choice.
 */
export interface FarmDurableMutationTestComposition {
  readonly batchMutations: BatchAggregateMutationPort;
  readonly feedingMutations: FeedingAggregateMutationPort;
  close(): Promise<void>;
}

/**
 * Observation-only persistence seam for closed-intent mutation spies.
 *
 * Unit tests may assert which aggregate the mutation authority persisted, but
 * they must not pretend that a partial object is a TypeORM EntityManager. The
 * production mutation port remains closed over domain intents; this recorder
 * exists only to expose the test framework's call ledger.
 */
interface DurableMutationPersistenceRecorderV1 {
  readonly save: EntityManager['save'];
}

export async function createFarmDurableMutationTestComposition(): Promise<FarmDurableMutationTestComposition> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [BATCH_AGGREGATE_MUTATION_PORT_PROVIDER, FEEDING_AGGREGATE_MUTATION_PORT_PROVIDER],
  }).compile();

  return Object.freeze({
    batchMutations: moduleRef.get(BatchAggregateMutationPort),
    feedingMutations: moduleRef.get(FeedingAggregateMutationPort),
    close: () => moduleRef.close(),
  });
}

/** Closed-intent spy for unit tests; it deliberately exposes no ORM primitive. */
export class RecordingBatchAggregateMutationPort extends BatchAggregateMutationPort {
  constructor(private readonly recorder?: DurableMutationPersistenceRecorderV1) {
    super();
  }

  override commitBatchTransition: jest.MockedFunction<
    BatchAggregateMutationPort['commitBatchTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(Batch, input.aggregate)) ?? input.aggregate;
  });

  override commitTankBatchTransition: jest.MockedFunction<
    BatchAggregateMutationPort['commitTankBatchTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(TankBatch, input.aggregate)) ?? input.aggregate;
  });

  override commitTankBatchTransitions: jest.MockedFunction<
    BatchAggregateMutationPort['commitTankBatchTransitions']
  > = jest.fn(async (_session, input) => {
    const aggregates = [...input.aggregates];
    return (await this.recorder?.save(TankBatch, aggregates)) ?? aggregates;
  });

  override commitTankTransition: jest.MockedFunction<
    BatchAggregateMutationPort['commitTankTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(Tank, input.aggregate)) ?? input.aggregate;
  });

  override replaceTankBiomassProjection: jest.MockedFunction<
    BatchAggregateMutationPort['replaceTankBiomassProjection']
  > = jest.fn(
    async (..._args: Parameters<BatchAggregateMutationPort['replaceTankBiomassProjection']>) =>
      undefined,
  );

  override replaceTankCountProjection: jest.MockedFunction<
    BatchAggregateMutationPort['replaceTankCountProjection']
  > = jest.fn(
    async (..._args: Parameters<BatchAggregateMutationPort['replaceTankCountProjection']>) =>
      undefined,
  );

  override replaceTankStockProjection: jest.MockedFunction<
    BatchAggregateMutationPort['replaceTankStockProjection']
  > = jest.fn(
    async (..._args: Parameters<BatchAggregateMutationPort['replaceTankStockProjection']>) =>
      undefined,
  );

  override deactivateDepartmentTanks: jest.MockedFunction<
    BatchAggregateMutationPort['deactivateDepartmentTanks']
  > = jest.fn(
    async (..._args: Parameters<BatchAggregateMutationPort['deactivateDepartmentTanks']>) =>
      undefined,
  );

  override pruneEmptyTankBatchProjection: jest.MockedFunction<
    BatchAggregateMutationPort['pruneEmptyTankBatchProjection']
  > = jest.fn(
    async (..._args: Parameters<BatchAggregateMutationPort['pruneEmptyTankBatchProjection']>) =>
      undefined,
  );
}

/** Closed-intent spy for feeding-owned aggregate unit tests. */
export class RecordingFeedingAggregateMutationPort extends FeedingAggregateMutationPort {
  constructor(private readonly recorder?: DurableMutationPersistenceRecorderV1) {
    super();
  }

  override commitFeedingRecordTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitFeedingRecordTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(input.aggregate)) ?? input.aggregate;
  });

  override commitDayPlanTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitDayPlanTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(input.aggregate)) ?? input.aggregate;
  });

  override commitMealTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitMealTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(input.aggregate)) ?? input.aggregate;
  });

  override createScheduledMeal: jest.MockedFunction<
    FeedingAggregateMutationPort['createScheduledMeal']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['createScheduledMeal']>) => undefined,
  );

  override commitProtocolAssignmentTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitProtocolAssignmentTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(input.aggregate)) ?? input.aggregate;
  });

  override commitProtocolDefinitionTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitProtocolDefinitionTransition']
  > = jest.fn(async (_session, input) => {
    return (await this.recorder?.save(input.aggregate)) ?? input.aggregate;
  });

  override clearDefaultProtocolForSpecies: jest.MockedFunction<
    FeedingAggregateMutationPort['clearDefaultProtocolForSpecies']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['clearDefaultProtocolForSpecies']>) =>
      undefined,
  );

  override reconcileForecastProjection: jest.MockedFunction<
    FeedingAggregateMutationPort['reconcileForecastProjection']
  > = jest.fn(
    async (...args: Parameters<FeedingAggregateMutationPort['reconcileForecastProjection']>) => ({
      generationId: '00000000-0000-4000-8000-000000000001',
      exactSetDigest: '0'.repeat(64),
      writtenCount: args[1].snapshots.length,
      retiredSnapshotCount: 0,
      replayed: false,
    }),
  );

  override purgeForecastProjectionBefore: jest.MockedFunction<
    FeedingAggregateMutationPort['purgeForecastProjectionBefore']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['purgeForecastProjectionBefore']>) =>
      0,
  );

  override createDayPlanIfAbsent: jest.MockedFunction<
    FeedingAggregateMutationPort['createDayPlanIfAbsent']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['createDayPlanIfAbsent']>) => null,
  );

  override incrementDayPlanUnplannedActual: jest.MockedFunction<
    FeedingAggregateMutationPort['incrementDayPlanUnplannedActual']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['incrementDayPlanUnplannedActual']>) =>
      undefined,
  );

  override markMealWindowNotified: jest.MockedFunction<
    FeedingAggregateMutationPort['markMealWindowNotified']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['markMealWindowNotified']>) =>
      undefined,
  );

  override recordDayPlanGrowthApplication: jest.MockedFunction<
    FeedingAggregateMutationPort['recordDayPlanGrowthApplication']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['recordDayPlanGrowthApplication']>) =>
      undefined,
  );

  override commitDayPlanStatusTransition: jest.MockedFunction<
    FeedingAggregateMutationPort['commitDayPlanStatusTransition']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['commitDayPlanStatusTransition']>) =>
      undefined,
  );

  override purgeMealsBeforeRetention: jest.MockedFunction<
    FeedingAggregateMutationPort['purgeMealsBeforeRetention']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['purgeMealsBeforeRetention']>) => 0,
  );

  override purgeDayPlansBeforeRetention: jest.MockedFunction<
    FeedingAggregateMutationPort['purgeDayPlansBeforeRetention']
  > = jest.fn(
    async (..._args: Parameters<FeedingAggregateMutationPort['purgeDayPlansBeforeRetention']>) => 0,
  );
}

/**
 * Runs a unit-level service invocation inside the real tenant transaction
 * boundary, so even tests cannot mint or retain mutation capabilities directly.
 */
export function runInFarmMutationTestTransaction<T>(
  manager: EntityManager,
  tenantId: string,
  work: (session: TenantMutationSession) => Promise<T>,
): Promise<T> {
  const dataSource = new DataSource({ type: 'postgres', database: 'farm_mutation_test' });
  const queryRunner = dataSource.createQueryRunner();
  Object.assign(queryRunner.manager, manager);
  jest.spyOn(queryRunner, 'connect').mockResolvedValue(undefined);
  jest.spyOn(queryRunner, 'startTransaction').mockResolvedValue(undefined);
  jest.spyOn(queryRunner, 'commitTransaction').mockResolvedValue(undefined);
  jest.spyOn(queryRunner, 'rollbackTransaction').mockResolvedValue(undefined);
  jest.spyOn(queryRunner, 'release').mockResolvedValue(undefined);
  jest.spyOn(queryRunner, 'query').mockImplementation(mockTenantTransactionControlQuery);
  jest.spyOn(dataSource, 'createQueryRunner').mockReturnValue(queryRunner);

  return runInTenantTransaction(dataSource, 'farm', tenantId, (_queryRunner, session) =>
    work(session),
  );
}
