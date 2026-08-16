import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { StructuredLoggerService } from '@aquaculture/backend-common/logging';
import {
  FEEDING_DISPATCH_CONSUMER_TRIGGER,
  isSiteScheduledFeedingJobId,
  isTenantScheduledFeedingJobId,
} from '@aquaculture/feeding-contracts';
import { canonicalWireJsonSha256V1 } from '@aquaculture/shared-contracts';

import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../feeding-operation-command.port';
import {
  FeedingScheduleDispatchRepository,
  type ClaimedFeedingScheduleDispatch,
} from './feeding-schedule-dispatch.repository';

const FEEDING_DISPATCH_CONSUMER_MAX_CONCURRENCY = 4;
const FEEDING_DISPATCH_CONSUMER_MAX_BATCH = 40;

@Injectable()
export class FeedingScheduleDispatchConsumerService {
  private readonly logger = new StructuredLoggerService('farm-service');
  private readonly workerId = `farm-service/${randomUUID()}`;
  private drainInFlight: Promise<void> | undefined;

  constructor(
    private readonly repository: FeedingScheduleDispatchRepository,
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operations: Pick<FeedingOperationCommandPort, 'reconcileScheduled'>,
  ) {}

  @Interval(FEEDING_DISPATCH_CONSUMER_TRIGGER.name, FEEDING_DISPATCH_CONSUMER_TRIGGER.intervalMs)
  drainDueDispatches(): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;
    const drain = this.runBoundedDrain().finally(() => {
      if (this.drainInFlight === drain) this.drainInFlight = undefined;
    });
    this.drainInFlight = drain;
    return drain;
  }

  private async runBoundedDrain(): Promise<void> {
    let claims = 0;
    const workers = Array.from({ length: FEEDING_DISPATCH_CONSUMER_MAX_CONCURRENCY }, async () => {
      while (claims < FEEDING_DISPATCH_CONSUMER_MAX_BATCH) {
        claims += 1;
        const dispatch = await this.repository.claim(this.workerId);
        if (!dispatch) return;
        await this.execute(dispatch);
      }
    });
    await Promise.all(workers);
  }

  private async execute(dispatch: ClaimedFeedingScheduleDispatch): Promise<void> {
    const envelope = dispatch.envelope;
    try {
      const result = await this.operations.reconcileScheduled(
        envelope.targetKind === 'tenant'
          ? {
              jobId: this.tenantJobId(envelope.jobId),
              tenantId: envelope.tenantId,
              schedulerCut: this.cut(envelope),
              occurrence: this.occurrence(envelope),
              dispatchDigest: envelope.dispatchDigest,
            }
          : {
              jobId: this.siteJobId(envelope.jobId),
              tenantId: envelope.tenantId,
              siteId: envelope.targetId,
              schedulerCut: this.cut(envelope),
              occurrence: this.occurrence(envelope),
              dispatchDigest: envelope.dispatchDigest,
            },
      );
      if ((result.status !== 'executed' && result.status !== 'replayed') || !result.operationId) {
        await this.release(
          dispatch,
          result.status === 'leased' ? 'FEEDING_OPERATION_LEASED' : 'FEEDING_DISPATCH_NOT_DUE',
          result.status,
        );
        return;
      }
      await this.repository.complete(dispatch, result.operationId);
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const errorCode = 'FEEDING_DISPATCH_EXECUTION_FAILED';
      const errorDigest = await this.release(dispatch, errorCode, normalized.message);
      this.logger.error(
        'Feeding schedule dispatch execution failed',
        { dispatchId: dispatch.dispatchId, errorCode, errorDigest },
        FeedingScheduleDispatchConsumerService.name,
      );
    }
  }

  private siteJobId(jobId: ClaimedFeedingScheduleDispatch['envelope']['jobId']) {
    if (!isSiteScheduledFeedingJobId(jobId)) {
      throw new Error(`Tenant-scoped feeding job ${jobId} cannot target a site dispatch`);
    }
    return jobId;
  }

  private tenantJobId(jobId: ClaimedFeedingScheduleDispatch['envelope']['jobId']) {
    if (!isTenantScheduledFeedingJobId(jobId)) {
      throw new Error(`Site-scoped feeding job ${jobId} cannot target a tenant dispatch`);
    }
    return jobId;
  }

  private cut(envelope: ClaimedFeedingScheduleDispatch['envelope']) {
    return {
      schemaVersion: 'feeding-scheduler-cut/v1' as const,
      observedAt: new Date(envelope.observedAt),
      catalogRevision: envelope.catalogRevision,
      catalogDigest: envelope.catalogDigest,
      catalogAdmissionGeneration: envelope.catalogAdmissionGeneration,
      authorityGeneration: envelope.authorityGeneration,
      timezoneSource: envelope.timezoneSource,
      timezone: envelope.timezone,
      targetSetDigest: envelope.targetSetDigest,
      cutDigest: envelope.cutDigest,
    };
  }

  private occurrence(envelope: ClaimedFeedingScheduleDispatch['envelope']) {
    return {
      scheduleKey: envelope.scheduleKey,
      dueAt: new Date(envelope.dueAt),
      localDate: envelope.localDate,
      timezone: envelope.timezone,
      caughtUp: envelope.caughtUp,
      dstGapAdjusted: envelope.dstGapAdjusted,
    };
  }

  private async release(
    dispatch: ClaimedFeedingScheduleDispatch,
    errorCode: string,
    safeDetail: string,
  ): Promise<string> {
    const errorDigest = canonicalWireJsonSha256V1(
      {
        domain: 'aquaculture.feeding-schedule-dispatch-failure',
        schemaVersion: 'feeding-schedule-dispatch-failure/v1',
      },
      { dispatchId: dispatch.dispatchId, errorCode, safeDetail },
    );
    await this.repository.release(dispatch, errorCode, errorDigest);
    return errorDigest;
  }
}
