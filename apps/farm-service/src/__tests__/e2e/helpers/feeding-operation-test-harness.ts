import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import {
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_UTC_TIMEZONE,
  compileFeedingOperationEnvelopeV1,
  compileFeedingOperationLockSetDigestV1,
  feedingCalendarDay,
} from '@aquaculture/feeding-contracts';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { BatchAggregateMutationPort } from '../../../batch/batch-aggregate-mutation.port';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../../batch/services/batch-lifecycle-policy.service';
import { BackdatePolicyService } from '../../../common/services/backdate-policy.service';
import { CreateFeedingRecordOperationExecutor } from '../../../feeding/executors/create-feeding-record-operation.executor';
import { CreateFeedingRecordHandler } from '../../../feeding/handlers/create-feeding-record.handler';
import { FeedingLedgerService } from '../../../feeding/services/feeding-ledger.service';
import type { StockMovementService } from '../../../storage/services/stock-movement.service';
import type { OutboxPublisher } from '@platform/outbox';
import { FinanceSettingsService } from '../../../finance/services/finance-settings.service';
import { FeedingAggregateMutationPort } from '../../../feeding-protocol/feeding-aggregate-mutation.writer';
import type { FeedingOperationCommandPort } from '../../../feeding-protocol/feeding-operation-command.port';
import { mintFeedingOperationSession } from '../../../feeding-protocol/feeding-operation-session';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { noOpDayPlanRecalcTestAuthority } from './batch-command-test-harness';

interface FeedingPhysicalCoordinates {
  readonly siteId: string;
  readonly unitId: string;
}

class TenantIsolationFeedingOperationPort implements FeedingOperationCommandPort {
  constructor(
    private readonly dataSource: DataSource,
    private readonly executor: CreateFeedingRecordOperationExecutor,
  ) {}

  recordFeeding(
    command: Parameters<FeedingOperationCommandPort['recordFeeding']>[0],
  ): ReturnType<FeedingOperationCommandPort['recordFeeding']> {
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      command.tenantId,
      async (queryRunner, mutationSession) => {
        const coordinates = await this.resolveCoordinates(
          queryRunner.manager,
          command.tenantId,
          command.payload.tankId,
        );
        const observedAt = new Date();
        const localDate = feedingCalendarDay(observedAt, FEEDING_UTC_TIMEZONE);
        const session = mintFeedingOperationSession({
          manager: queryRunner.manager,
          mutationSession,
          tenantId: command.tenantId,
          operationId: command.requestId,
          attempt: 1,
          operationEnvelope: compileFeedingOperationEnvelopeV1({
            observedAt,
            catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
            commandDigest: '0'.repeat(64),
            authorityGeneration: 1,
            lockSetDigest: compileFeedingOperationLockSetDigestV1({
              tenantId: command.tenantId,
              jobId: 'manual.feeding.record',
              targetKind: 'unit',
              targetId: coordinates.unitId,
              localDate,
            }),
          }),
          localDate,
          timezone: FEEDING_UTC_TIMEZONE,
          siteId: coordinates.siteId,
          unitId: coordinates.unitId,
        });
        return this.executor.executeFeedingRecordOperation(session, {
          jobId: 'manual.feeding.record',
          ...command,
        });
      },
    );
  }

  refreshForecast(
    ..._args: Parameters<FeedingOperationCommandPort['refreshForecast']>
  ): ReturnType<FeedingOperationCommandPort['refreshForecast']> {
    throw this.unsupported('refreshForecast');
  }

  regenerateDayPlan(
    ..._args: Parameters<FeedingOperationCommandPort['regenerateDayPlan']>
  ): ReturnType<FeedingOperationCommandPort['regenerateDayPlan']> {
    throw this.unsupported('regenerateDayPlan');
  }

  transitionFeed(
    ..._args: Parameters<FeedingOperationCommandPort['transitionFeed']>
  ): ReturnType<FeedingOperationCommandPort['transitionFeed']> {
    throw this.unsupported('transitionFeed');
  }

  updateFeeding(
    ..._args: Parameters<FeedingOperationCommandPort['updateFeeding']>
  ): ReturnType<FeedingOperationCommandPort['updateFeeding']> {
    throw this.unsupported('updateFeeding');
  }

  correctMeal(
    ..._args: Parameters<FeedingOperationCommandPort['correctMeal']>
  ): ReturnType<FeedingOperationCommandPort['correctMeal']> {
    throw this.unsupported('correctMeal');
  }

  finalizeMeal(
    ..._args: Parameters<FeedingOperationCommandPort['finalizeMeal']>
  ): ReturnType<FeedingOperationCommandPort['finalizeMeal']> {
    throw this.unsupported('finalizeMeal');
  }

  skipMeal(
    ..._args: Parameters<FeedingOperationCommandPort['skipMeal']>
  ): ReturnType<FeedingOperationCommandPort['skipMeal']> {
    throw this.unsupported('skipMeal');
  }

  recordMeal(
    ..._args: Parameters<FeedingOperationCommandPort['recordMeal']>
  ): ReturnType<FeedingOperationCommandPort['recordMeal']> {
    throw this.unsupported('recordMeal');
  }

  reconcileScheduled(
    ..._args: Parameters<FeedingOperationCommandPort['reconcileScheduled']>
  ): ReturnType<FeedingOperationCommandPort['reconcileScheduled']> {
    throw this.unsupported('reconcileScheduled');
  }

  private async resolveCoordinates(
    manager: Parameters<typeof mintFeedingOperationSession>[0]['manager'],
    tenantId: string,
    tankId: string | undefined,
  ): Promise<FeedingPhysicalCoordinates> {
    if (!tankId) {
      throw new Error('Tenant-isolation feeding commands require a tank target');
    }
    const rows: Array<{ siteId: string }> = await manager.query(
      `SELECT department."siteId"
         FROM tanks tank
         JOIN departments department
           ON department.id = tank."departmentId"
          AND department."tenantId" = tank."tenantId"
        WHERE tank.id = $1 AND tank."tenantId" = $2`,
      [tankId, tenantId],
    );
    const siteId = rows[0]?.siteId;
    if (!siteId) {
      throw new Error(`Tank ${tankId} has no governed Site coordinate`);
    }
    return Object.freeze({ siteId, unitId: tankId });
  }

  private unsupported(operation: keyof FeedingOperationCommandPort): Error {
    return new Error(`${operation} is outside the feeding-record tenant-isolation harness`);
  }
}

export function createFeedingRecordCommandTestHandler(input: {
  readonly dataSource: DataSource;
  readonly feedingMutations: FeedingAggregateMutationPort;
  readonly batchMutations: BatchAggregateMutationPort;
  readonly stockMovementService: StockMovementService;
  readonly outboxPublisher: OutboxPublisher;
}): CreateFeedingRecordHandler {
  const executor = new CreateFeedingRecordOperationExecutor(
    input.feedingMutations,
    new BackdatePolicyService(new ConfigService({ FEEDING_BACKDATE_LIMIT_DAYS: 3_650 })),
    new BatchDomainService(new BatchLifecyclePolicyService()),
    new FeedingLedgerService(
      input.feedingMutations,
      input.batchMutations,
      input.stockMovementService,
      new FinanceSettingsService(input.dataSource),
      input.outboxPublisher,
    ),
    new BiomassGrowthApplierService(input.batchMutations),
    noOpDayPlanRecalcTestAuthority(input.feedingMutations, input.outboxPublisher),
  );
  return new CreateFeedingRecordHandler(
    new TenantIsolationFeedingOperationPort(input.dataSource, executor),
  );
}
