import { Inject, Injectable, type Provider } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_UTC_TIMEZONE,
  type FeedingDueOccurrence,
  type FeedingCapability,
  type FeedingJobId,
  type FeedingOperationIntentV1,
  type FeedingTimezone,
  compileFeedingResultArtifactV1,
  compileFeedingOperationEnvelopeV1,
  compileFeedingOperationLockSetDigestV1,
  decodeFeedingOperationIntentV1,
  feedingDueOccurrences,
  feedingJobDefinition,
  verifyFeedingResultArtifactV1,
} from '@aquaculture/feeding-contracts';
import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import {
  canonicalJsonSha256,
  canonicalJsonStringify,
  canonicalWireJsonStringifyV1,
  createCanonicalJsonDocumentV1,
} from '@aquaculture/shared-contracts';
import { DataSource } from 'typeorm';

import type {
  FeedingOperationCommand,
  FeedingOperationCommandFor,
  FeedingOperationCommandResult,
  ScheduledSiteFeedingOperationCommand,
  ScheduledTenantFeedingOperationCommand,
} from '../feeding-operation-command';
import {
  compileFeedingOperationCommandArtifactV1,
  decodeFeedingOperationCommandFromIntentV1,
  type FeedingOperationCommandArtifactV1,
} from '../feeding-operation-command.codec';
import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
  type FeedingReconciliationResult,
} from '../feeding-operation-command.port';
import {
  FEEDING_OPERATION_HANDLER_ADAPTER,
  type FeedingOperationHandlerAdapterPort,
} from '../feeding-operation-handler.adapter';
import { mintFeedingOperationSession } from '../feeding-operation-session';
import type {
  FeedingOperationTarget,
  FeedingTimezoneResolution,
} from './feeding-timezone-authority.service';
import { FeedingTimezoneAuthorityService } from './feeding-timezone-authority.service';
import { executeWithFeedingTransactionRetry } from '../feeding-operation-transaction-retry.authority';

interface FeedingLeaseRow {
  readonly disposition: 'execute' | 'replay' | 'leased';
  readonly operationId: string;
  readonly leaseToken: string | null;
  readonly generation: string;
  readonly attempt: number;
  readonly leaseExpiresAt: Date;
  readonly intent: unknown;
  readonly resultSchema: string | null;
  readonly resultPayload: string | null;
  readonly resultDigest: string | null;
}

interface FeedingTargetCoordinates {
  readonly kind: 'tenant' | 'site' | 'unit';
  readonly id: string | null;
}

interface ClaimedFeedingLease<K extends FeedingJobId> {
  readonly lease: FeedingLeaseRow;
  readonly intent: FeedingOperationIntentV1;
  readonly command: FeedingOperationCommandFor<K>;
}

interface FeedingOperationIntentEvidenceV1 {
  readonly schemaVersion: 'feeding-operation-intent/v1';
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly jobId: FeedingJobId;
  readonly targetKind: FeedingTargetCoordinates['kind'];
  readonly targetId: string | null;
  readonly siteId: string | null;
  readonly unitId: string | null;
  readonly reason: FeedingOperationReason;
  readonly catalogRevision: typeof FEEDING_JOB_CATALOG_REVISION;
  readonly catalogDigest: typeof FEEDING_JOB_CATALOG_DIGEST;
  readonly catalogJobCount: number;
  readonly commandDigest: string;
  readonly commandPayload: FeedingOperationIntentV1['commandPayload'];
  readonly lockSetDigest: string;
  readonly observedAt: string;
  readonly dueAt: string;
  readonly scheduleKey: string;
  readonly localDate: string;
  readonly timezone: string;
  readonly caughtUp: boolean;
  readonly dstGapAdjusted: boolean;
  readonly timezoneSource: string;
  readonly catalogAdmissionGeneration: number | null;
  readonly authorityGeneration: number | null;
  readonly targetSetDigest: string | null;
  readonly schedulerCutDigest: string | null;
  readonly dispatchDigest: string | null;
}

interface FeedingOperationSucceededEvidenceV1 {
  readonly schemaVersion: 'feeding-operation-result/v1';
  readonly operationId: string;
  readonly jobId: FeedingJobId;
  readonly generation: number;
  readonly outcome: 'succeeded';
  readonly catalogRevision: typeof FEEDING_JOB_CATALOG_REVISION;
  readonly catalogDigest: typeof FEEDING_JOB_CATALOG_DIGEST;
  readonly resultSchema: string;
  readonly resultDigest: string;
  readonly operationEnvelopeDigest: string;
}

interface FeedingOperationFailedEvidenceV1 {
  readonly schemaVersion: 'feeding-operation-result/v1';
  readonly operationId: string;
  readonly jobId: FeedingJobId;
  readonly generation: number;
  readonly outcome: 'failed';
  readonly catalogRevision: typeof FEEDING_JOB_CATALOG_REVISION;
  readonly catalogDigest: typeof FEEDING_JOB_CATALOG_DIGEST;
  readonly errorCode: FeedingFailureCode;
  readonly errorClass: FeedingFailureClass;
  readonly safeMessage: string;
  readonly errorDigest: string;
  readonly operationEnvelopeDigest: string;
}

type FeedingFailureClass = 'authority' | 'validation' | 'conflict' | 'dependency' | 'internal';
type FeedingFailureCode =
  | 'FEEDING_AUTHORITY_REJECTED'
  | 'FEEDING_INPUT_REJECTED'
  | 'FEEDING_STATE_CONFLICT'
  | 'FEEDING_DEPENDENCY_FAILED'
  | 'FEEDING_INTERNAL_FAILED';

type FeedingOperationReason = 'scheduled_reconciliation' | 'operator_request' | 'device_request';

const REASON_BY_CAPABILITY: Readonly<Record<FeedingCapability, FeedingOperationReason>> =
  Object.freeze({
    'scheduled.v2': 'scheduled_reconciliation',
    'operator.manual': 'operator_request',
    'device.mobile': 'device_request',
  });

function strictJson(value: unknown): string {
  return canonicalJsonStringify(createCanonicalJsonDocumentV1(value));
}

interface BooleanRow {
  readonly accepted: boolean;
}

class FeedingOperationAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedingOperationAuthorityError';
  }
}

/**
 * The sole feeding-operation execution authority. Protocol-definition CRUD is
 * a separate catalogued configuration authority and cannot enter this ledger.
 *
 * Callers submit one closed, job-specific command. They cannot supply a
 * callback, transaction object, evidence bag, schedule policy or catalogue
 * coordinate. The coordinator resolves a statically enumerated handler set at
 * bootstrap and verifies exact equality with the compiled catalogue before it
 * will accept work.
 *
 * Claim/intent is committed in transaction one. Domain + outbox + completion
 * fencing CAS commit atomically in transaction two. A failed domain
 * transaction is followed by typed failure evidence in transaction three.
 */
@Injectable()
class FeedingOperationCoordinatorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly timezoneAuthority: FeedingTimezoneAuthorityService,
    @Inject(FEEDING_OPERATION_HANDLER_ADAPTER)
    private readonly handlerAdapter: FeedingOperationHandlerAdapterPort,
  ) {}

  async execute<K extends FeedingOperationCommand['jobId']>(
    command: FeedingOperationCommandFor<K>,
  ): Promise<FeedingOperationCommandResult<K>> {
    const result = await this.executeClaimed(command);
    if (result.status === 'leased' || result.status === 'not_due') {
      throw new FeedingOperationAuthorityError(
        `Feeding operation ${command.jobId}/${this.requestKey(command) ?? 'scheduled'} is ${result.status}`,
      );
    }
    return result.value;
  }

  async reconcile(
    command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
  ): Promise<FeedingReconciliationResult> {
    const result = await this.executeClaimed(command);
    return result.status === 'not_due'
      ? { status: 'not_due' }
      : { status: result.status, operationId: result.operationId };
  }

  private async executeClaimed<K extends FeedingOperationCommand['jobId']>(
    command: FeedingOperationCommandFor<K>,
  ): Promise<
    | {
        readonly status: 'executed';
        readonly operationId: string;
        readonly value: FeedingOperationCommandResult<K>;
      }
    | {
        readonly status: 'replayed';
        readonly operationId: string;
        readonly value: FeedingOperationCommandResult<K>;
      }
    | { readonly status: 'leased'; readonly operationId: string }
    | { readonly status: 'not_due' }
  > {
    const candidate = compileFeedingOperationCommandArtifactV1(command);
    const admittedCommand = candidate.command;
    const definition = feedingJobDefinition(admittedCommand.jobId);
    if (!definition.enabled) {
      throw new FeedingOperationAuthorityError(`Feeding job ${definition.id} is retired`);
    }
    const claimed = await this.claim(candidate);
    if (!claimed) return { status: 'not_due' };
    if (claimed.lease.disposition === 'leased') {
      return { status: 'leased', operationId: claimed.lease.operationId };
    }
    if (claimed.lease.disposition === 'replay') {
      if (!claimed.lease.resultSchema || !claimed.lease.resultDigest) {
        throw new FeedingOperationAuthorityError('Terminal feeding replay has no typed result');
      }
      if (claimed.lease.resultPayload === null) {
        throw new FeedingOperationAuthorityError('Terminal feeding replay has no payload bytes');
      }
      const replayArtifact = (() => {
        try {
          return verifyFeedingResultArtifactV1({
            resultSchema: claimed.lease.resultSchema,
            payloadJson: claimed.lease.resultPayload,
            digest: claimed.lease.resultDigest,
          });
        } catch {
          throw new FeedingOperationAuthorityError(
            'Terminal feeding replay violates its canonical result artifact',
          );
        }
      })();
      return {
        status: 'replayed',
        operationId: claimed.lease.operationId,
        value: this.handlerAdapter.decode(
          claimed.command.jobId,
          claimed.lease.resultSchema,
          replayArtifact.payload,
        ),
      };
    }
    if (!claimed.lease.leaseToken) {
      throw new FeedingOperationAuthorityError('Executable feeding claim has no lease token');
    }
    const generation = Number.parseInt(claimed.lease.generation, 10);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new FeedingOperationAuthorityError('Database returned an invalid feeding generation');
    }

    const operationEnvelope = compileFeedingOperationEnvelopeV1({
      observedAt: claimed.intent.observedAt,
      catalogDigest: claimed.intent.catalogDigest,
      commandDigest: claimed.intent.commandDigest,
      authorityGeneration: generation,
      lockSetDigest: claimed.intent.lockSetDigest,
    });

    try {
      const value = await executeWithFeedingTransactionRetry(() =>
        runInTenantTransaction(
          this.dataSource,
          'farm',
          claimed.command.tenantId,
          async (queryRunner, mutationSession) => {
            const persistedCommand = decodeFeedingOperationCommandFromIntentV1(
              claimed.command.jobId,
              claimed.intent,
            );
            const session = mintFeedingOperationSession({
              manager: queryRunner.manager,
              mutationSession,
              tenantId: claimed.command.tenantId,
              operationId: claimed.lease.operationId,
              attempt: claimed.lease.attempt,
              operationEnvelope,
              localDate: claimed.intent.localDate,
              timezone: claimed.intent.timezone,
              siteId: claimed.intent.siteId,
              unitId: claimed.intent.unitId,
            });
            const domainResult = await this.handlerAdapter.execute(session, persistedCommand);
            const result = this.handlerAdapter.encode(persistedCommand.jobId, domainResult);
            const normalizedResult = this.handlerAdapter.decode(
              persistedCommand.jobId,
              result.schema,
              result.payload,
            );
            const resultArtifact = compileFeedingResultArtifactV1(result.schema, result.payload);
            const completed: BooleanRow[] = await queryRunner.query(
              `SELECT farm.complete_feeding_job(
               $1::uuid, $2::uuid, $3::varchar, $4::varchar,
               $5::varchar, $6::text, $7::varchar, $8::jsonb
             ) AS accepted`,
              [
                claimed.lease.operationId,
                claimed.lease.leaseToken,
                FEEDING_JOB_CATALOG_REVISION,
                FEEDING_JOB_CATALOG_DIGEST,
                result.schema,
                resultArtifact.payloadJson,
                resultArtifact.digest,
                strictJson(
                  this.successEvidence(
                    claimed,
                    generation,
                    result.schema,
                    resultArtifact.digest,
                    operationEnvelope.digest,
                  ),
                ),
              ],
            );
            if (completed[0]?.accepted !== true) {
              throw new FeedingOperationAuthorityError(
                `Feeding operation ${claimed.lease.operationId} lost its generation or lease before commit`,
              );
            }
            return normalizedResult;
          },
        ),
      );
      return { status: 'executed', operationId: claimed.lease.operationId, value };
    } catch (error: unknown) {
      const failure = this.normalizeFailure(error);
      try {
        await this.persistFailure(claimed, generation, operationEnvelope.digest, failure);
      } catch (persistenceError: unknown) {
        const persistenceFailure = this.normalizeFailure(persistenceError);
        throw new AggregateError(
          [failure, persistenceFailure],
          `Feeding operation ${claimed.lease.operationId} failed and its failure evidence could not be persisted`,
        );
      }
      throw failure;
    }
  }

  private async claim<K extends FeedingOperationCommand['jobId']>(
    candidate: FeedingOperationCommandArtifactV1<K>,
  ): Promise<ClaimedFeedingLease<K> | undefined> {
    const command = candidate.command;
    const definition = feedingJobDefinition(command.jobId);
    const targetRequest = this.targetFor(command);
    const commandDigest = candidate.digest;
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      command.tenantId,
      async (queryRunner, mutationSession) => {
        const observedAt = this.isScheduled(command)
          ? command.schedulerCut.observedAt
          : mutationInstantDateV1(await readTenantMutationInstantV1(mutationSession, 'farm'));
        const timezone =
          definition.clockProfile === 'utc_global'
            ? this.globalClock(targetRequest)
            : await this.timezoneAuthority.resolveTarget(
                queryRunner.manager,
                command.tenantId,
                targetRequest,
              );
        const target = this.targetCoordinates(targetRequest, timezone);
        this.assertCatalogTarget(definition.targetCardinality, target, definition.id);
        this.assertSchedulerCut(command, timezone);
        const occurrences = this.isScheduled(command)
          ? [this.assertScheduledOccurrence(command, observedAt, timezone.timezone)]
          : feedingDueOccurrences(
              definition,
              observedAt,
              timezone.timezone,
              this.requestKey(command),
            );
        let lastReplay: ClaimedFeedingLease<K> | undefined;
        for (const occurrence of occurrences) {
          const lockSetDigest = compileFeedingOperationLockSetDigestV1({
            tenantId: command.tenantId,
            jobId: command.jobId,
            targetKind: target.kind,
            targetId: target.id,
            localDate: occurrence.localDate,
          });
          const claims: FeedingLeaseRow[] = await queryRunner.query(
            `SELECT disposition, "operationId", "leaseToken", generation::text AS generation,
                    attempt, "leaseExpiresAt", intent,
                    "resultSchema", "resultPayload", "resultDigest"
               FROM farm.claim_feeding_job(
                 $1::uuid, $2::varchar, $3::varchar, $4::date, $5::varchar,
                 $6::varchar, $7::varchar, $8::varchar, $9::uuid,
                 $10::varchar, $11::varchar, $12::varchar,
                 $13::bigint, $14::bigint, $15::varchar, $16::jsonb
               )`,
            [
              command.tenantId,
              definition.id,
              occurrence.scheduleKey,
              occurrence.localDate,
              timezone.timezone,
              definition.timezoneSource,
              definition.clockProfile,
              target.kind,
              target.id,
              FEEDING_JOB_CATALOG_REVISION,
              FEEDING_JOB_CATALOG_DIGEST,
              commandDigest,
              this.isScheduled(command) ? command.schedulerCut.catalogAdmissionGeneration : null,
              this.isScheduled(command) ? command.schedulerCut.authorityGeneration : null,
              this.isScheduled(command) ? command.schedulerCut.targetSetDigest : null,
              strictJson(
                this.intentEvidence(
                  command,
                  target,
                  timezone,
                  occurrence,
                  observedAt,
                  commandDigest,
                  candidate.payload,
                  lockSetDigest,
                ),
              ),
            ],
          );
          if (claims[0]) {
            const intent = decodeFeedingOperationIntentV1(claims[0].intent);
            const persistedCommand = decodeFeedingOperationCommandFromIntentV1(
              command.jobId,
              intent,
            );
            if (
              intent.operationId !== claims[0].operationId ||
              intent.generation !== Number(claims[0].generation) ||
              intent.tenantId !== command.tenantId ||
              intent.commandDigest !== commandDigest
            ) {
              throw new FeedingOperationAuthorityError(
                `Feeding claim ${claims[0].operationId} returned a mismatched persisted intent`,
              );
            }
            const claimed: ClaimedFeedingLease<K> = {
              lease: claims[0],
              intent,
              command: persistedCommand,
            };
            if (!this.isScheduled(command) || claims[0].disposition !== 'replay') {
              return claimed;
            }
            lastReplay = claimed;
          }
        }
        return lastReplay;
      },
    );
  }

  private async persistFailure<K extends FeedingOperationCommand['jobId']>(
    claimed: ClaimedFeedingLease<K>,
    generation: number,
    operationEnvelopeDigest: string,
    failure: Error,
  ): Promise<void> {
    const command = claimed.command;
    const accepted = await runInTenantTransaction(
      this.dataSource,
      'farm',
      command.tenantId,
      async (queryRunner) => {
        const rows: BooleanRow[] = await queryRunner.query(
          `SELECT farm.fail_feeding_job(
             $1::uuid, $2::uuid, $3::varchar, $4::varchar, $5::jsonb
           ) AS accepted`,
          [
            claimed.lease.operationId,
            claimed.lease.leaseToken,
            FEEDING_JOB_CATALOG_REVISION,
            FEEDING_JOB_CATALOG_DIGEST,
            strictJson(this.failureEvidence(claimed, generation, operationEnvelopeDigest, failure)),
          ],
        );
        return rows[0]?.accepted === true;
      },
    );
    if (!accepted) {
      throw new FeedingOperationAuthorityError(
        `Feeding operation ${claimed.lease.operationId} failed after its lease was fenced`,
      );
    }
  }

  private intentEvidence(
    command: FeedingOperationCommand,
    target: FeedingTargetCoordinates,
    timezone: FeedingTimezoneResolution,
    occurrence: FeedingDueOccurrence,
    observedAt: Date,
    commandDigest: string,
    commandPayload: FeedingOperationIntentV1['commandPayload'],
    lockSetDigest: string,
  ): FeedingOperationIntentEvidenceV1 {
    const scheduled = this.isScheduled(command);
    return {
      schemaVersion: 'feeding-operation-intent/v1',
      tenantId: command.tenantId,
      actorId: scheduled ? null : command.actorId,
      requestId: scheduled ? null : command.requestId,
      jobId: command.jobId,
      targetKind: target.kind,
      targetId: target.id,
      siteId: timezone.siteId,
      unitId: timezone.unitId,
      reason: this.reasonFor(command),
      catalogRevision: FEEDING_JOB_CATALOG_REVISION,
      catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
      catalogJobCount: FEEDING_JOB_CATALOG.length,
      commandDigest,
      commandPayload,
      lockSetDigest,
      observedAt: observedAt.toISOString(),
      dueAt: occurrence.dueAt.toISOString(),
      scheduleKey: occurrence.scheduleKey,
      localDate: occurrence.localDate,
      timezone: occurrence.timezone,
      caughtUp: occurrence.caughtUp,
      dstGapAdjusted: occurrence.dstGapAdjusted,
      timezoneSource: feedingJobDefinition(command.jobId).timezoneSource,
      catalogAdmissionGeneration: scheduled
        ? command.schedulerCut.catalogAdmissionGeneration
        : null,
      authorityGeneration: scheduled ? command.schedulerCut.authorityGeneration : null,
      targetSetDigest: scheduled ? command.schedulerCut.targetSetDigest : null,
      schedulerCutDigest: scheduled ? command.schedulerCut.cutDigest : null,
      dispatchDigest: scheduled ? command.dispatchDigest : null,
    };
  }

  private successEvidence<K extends FeedingJobId>(
    claimed: ClaimedFeedingLease<K>,
    generation: number,
    resultSchema: string,
    resultDigest: string,
    operationEnvelopeDigest: string,
  ): FeedingOperationSucceededEvidenceV1 {
    return {
      schemaVersion: 'feeding-operation-result/v1',
      operationId: claimed.lease.operationId,
      jobId: claimed.command.jobId,
      generation,
      outcome: 'succeeded',
      catalogRevision: FEEDING_JOB_CATALOG_REVISION,
      catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
      resultSchema,
      resultDigest,
      operationEnvelopeDigest,
    };
  }

  private failureEvidence<K extends FeedingJobId>(
    claimed: ClaimedFeedingLease<K>,
    generation: number,
    operationEnvelopeDigest: string,
    failure: Error,
  ): FeedingOperationFailedEvidenceV1 {
    const classified = this.classifyFailure(failure);
    return {
      schemaVersion: 'feeding-operation-result/v1',
      operationId: claimed.lease.operationId,
      jobId: claimed.command.jobId,
      generation,
      outcome: 'failed',
      catalogRevision: FEEDING_JOB_CATALOG_REVISION,
      catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
      ...classified,
      operationEnvelopeDigest,
      errorDigest: canonicalJsonSha256(
        {
          domain: 'aquaculture.feeding-operation-failure',
          schemaVersion: 'feeding-operation-failure/v1',
        },
        createCanonicalJsonDocumentV1({
          operationId: claimed.lease.operationId,
          errorName: failure.name,
          errorMessage: failure.message,
        }),
      ),
    };
  }

  private classifyFailure(
    failure: Error,
  ): Pick<FeedingOperationFailedEvidenceV1, 'errorCode' | 'errorClass' | 'safeMessage'> {
    if (failure.name === 'FeedingOperationAuthorityError') {
      return {
        errorCode: 'FEEDING_AUTHORITY_REJECTED',
        errorClass: 'authority',
        safeMessage: 'The feeding authority rejected the operation.',
      };
    }
    if (
      failure.name === 'BadRequestException' ||
      failure.name === 'TypeError' ||
      failure.name === 'FeedingTimezoneAuthorityError'
    ) {
      return {
        errorCode: 'FEEDING_INPUT_REJECTED',
        errorClass: 'validation',
        safeMessage: 'The feeding operation did not satisfy its input contract.',
      };
    }
    if (failure.name === 'ConflictException' || failure.name === 'NotFoundException') {
      return {
        errorCode: 'FEEDING_STATE_CONFLICT',
        errorClass: 'conflict',
        safeMessage: 'The governed feeding state changed or was unavailable.',
      };
    }
    if (failure.name === 'QueryFailedError' || failure.name === 'TimeoutError') {
      return {
        errorCode: 'FEEDING_DEPENDENCY_FAILED',
        errorClass: 'dependency',
        safeMessage: 'A required feeding dependency failed.',
      };
    }
    return {
      errorCode: 'FEEDING_INTERNAL_FAILED',
      errorClass: 'internal',
      safeMessage: 'The feeding operation failed.',
    };
  }

  private targetFor(command: FeedingOperationCommand): FeedingOperationTarget {
    switch (command.jobId) {
      case 'v2.day-plan.generate':
      case 'v2.meal-window.sweep':
      case 'v2.morning.sweep':
      case 'v2.daily-summary.publish':
      case 'v2.fcr-alert.sweep':
      case 'v2.forecast.refresh':
        return { kind: 'site', siteId: command.siteId };
      case 'v2.stock-coverage.refresh':
      case 'v2.retention.purge':
        return { kind: 'tenant' };
      case 'manual.day-plan.regenerate':
      case 'manual.feed.transition':
        return { kind: 'unit', unitId: command.unitId };
      case 'manual.feeding.record':
        return {
          kind: 'feeding_record',
          batchId: command.payload.batchId,
          tankId: command.payload.tankId,
          pondId: command.payload.pondId,
          batchLocationId: command.payload.batchLocationId,
        };
      case 'manual.feeding.update':
        return {
          kind: 'existing_feeding_record',
          feedingRecordId: command.feedingRecordId,
        };
      case 'manual.meal.correct':
      case 'manual.meal.finalize':
      case 'manual.meal.skip':
      case 'mobile.meal.record':
        return { kind: 'meal', mealId: command.mealId };
    }
  }

  private reasonFor(command: FeedingOperationCommand): FeedingOperationReason {
    return REASON_BY_CAPABILITY[feedingJobDefinition(command.jobId).capability];
  }

  private requestKey(command: FeedingOperationCommand): string | undefined {
    return this.isScheduled(command) ? undefined : command.requestId;
  }

  private isScheduled(
    command: FeedingOperationCommand,
  ): command is ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand {
    return feedingJobDefinition(command.jobId).capability === 'scheduled.v2';
  }

  private globalClock(target: FeedingOperationTarget): FeedingTimezoneResolution {
    if (target.kind !== 'tenant') {
      throw new FeedingOperationAuthorityError('A global feeding clock requires a tenant target');
    }
    return { timezone: FEEDING_UTC_TIMEZONE, source: 'utc_global', siteId: null, unitId: null };
  }

  private targetCoordinates(
    target: FeedingOperationTarget,
    resolution: FeedingTimezoneResolution,
  ): FeedingTargetCoordinates {
    if (target.kind === 'tenant') return { kind: 'tenant', id: null };
    if (target.kind === 'site') return { kind: 'site', id: target.siteId };
    if (!resolution.unitId) {
      throw new FeedingOperationAuthorityError(
        'Operation target did not resolve one physical unit',
      );
    }
    return { kind: 'unit', id: resolution.unitId };
  }

  private assertCatalogTarget(
    cardinality: 'site' | 'tenant' | 'operation_target',
    target: FeedingTargetCoordinates,
    jobId: FeedingJobId,
  ): void {
    if (
      (cardinality === 'site' && target.kind !== 'site') ||
      (cardinality === 'tenant' && target.kind !== 'tenant') ||
      (cardinality === 'operation_target' && target.kind === 'tenant')
    ) {
      throw new FeedingOperationAuthorityError(
        `Feeding job ${jobId} target ${target.kind} violates catalog cardinality ${cardinality}`,
      );
    }
  }

  private assertSchedulerCut(
    command: FeedingOperationCommand,
    timezone: FeedingTimezoneResolution,
  ): void {
    if (!this.isScheduled(command)) return;
    const definition = feedingJobDefinition(command.jobId);
    const cut = command.schedulerCut;
    if (
      cut.schemaVersion !== 'feeding-scheduler-cut/v1' ||
      cut.catalogRevision !== FEEDING_JOB_CATALOG_REVISION ||
      cut.catalogDigest !== FEEDING_JOB_CATALOG_DIGEST ||
      cut.timezoneSource !== definition.timezoneSource ||
      cut.timezone !== timezone.timezone ||
      cut.targetSetDigest.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(cut.cutDigest) ||
      !/^[0-9a-f]{64}$/.test(command.dispatchDigest) ||
      !Number.isSafeInteger(cut.catalogAdmissionGeneration) ||
      cut.catalogAdmissionGeneration < 1 ||
      !Number.isSafeInteger(cut.authorityGeneration) ||
      cut.authorityGeneration < 1
    ) {
      throw new FeedingOperationAuthorityError(
        `Feeding scheduler cut for ${command.jobId} is stale or malformed`,
      );
    }
  }

  private assertScheduledOccurrence(
    command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
    observedAt: Date,
    timezone: FeedingTimezone,
  ): FeedingDueOccurrence {
    const occurrence = command.occurrence;
    const exact = feedingDueOccurrences(
      feedingJobDefinition(command.jobId),
      observedAt,
      timezone,
    ).find(
      (candidate) =>
        candidate.scheduleKey === occurrence.scheduleKey &&
        candidate.dueAt.toISOString() === occurrence.dueAt.toISOString() &&
        candidate.localDate === occurrence.localDate &&
        candidate.timezone === occurrence.timezone &&
        candidate.caughtUp === occurrence.caughtUp &&
        candidate.dstGapAdjusted === occurrence.dstGapAdjusted,
    );
    if (!exact) {
      throw new FeedingOperationAuthorityError(
        `Feeding dispatch occurrence ${occurrence.scheduleKey} is outside its admitted schedule`,
      );
    }
    return exact;
  }

  private normalizeFailure(error: unknown): Error {
    if (error instanceof Error) return error;
    let detail: string;
    try {
      detail = canonicalWireJsonStringifyV1(error, { maxBytes: 1_024 });
    } catch {
      detail = String(error);
    }
    const failure = new Error(`Non-Error feeding failure: ${detail.slice(0, 900)}`);
    failure.name = 'NonErrorFeedingFailure';
    return failure;
  }
}

/** Private adapter: job identities are attached behind the one exported port token. */
@Injectable()
class FeedingOperationCommandPortBinding implements FeedingOperationCommandPort {
  constructor(private readonly coordinator: FeedingOperationCoordinatorService) {}

  refreshForecast(
    command: Parameters<FeedingOperationCommandPort['refreshForecast']>[0],
  ): ReturnType<FeedingOperationCommandPort['refreshForecast']> {
    return this.coordinator.execute({ jobId: 'v2.forecast.refresh', ...command });
  }

  regenerateDayPlan(
    command: Parameters<FeedingOperationCommandPort['regenerateDayPlan']>[0],
  ): ReturnType<FeedingOperationCommandPort['regenerateDayPlan']> {
    return this.coordinator.execute({ jobId: 'manual.day-plan.regenerate', ...command });
  }

  transitionFeed(
    command: Parameters<FeedingOperationCommandPort['transitionFeed']>[0],
  ): ReturnType<FeedingOperationCommandPort['transitionFeed']> {
    return this.coordinator.execute({ jobId: 'manual.feed.transition', ...command });
  }

  recordFeeding(
    command: Parameters<FeedingOperationCommandPort['recordFeeding']>[0],
  ): ReturnType<FeedingOperationCommandPort['recordFeeding']> {
    return this.coordinator.execute({ jobId: 'manual.feeding.record', ...command });
  }

  updateFeeding(
    command: Parameters<FeedingOperationCommandPort['updateFeeding']>[0],
  ): ReturnType<FeedingOperationCommandPort['updateFeeding']> {
    return this.coordinator.execute({ jobId: 'manual.feeding.update', ...command });
  }

  correctMeal(
    command: Parameters<FeedingOperationCommandPort['correctMeal']>[0],
  ): ReturnType<FeedingOperationCommandPort['correctMeal']> {
    return this.coordinator.execute({ jobId: 'manual.meal.correct', ...command });
  }

  finalizeMeal(
    command: Parameters<FeedingOperationCommandPort['finalizeMeal']>[0],
  ): ReturnType<FeedingOperationCommandPort['finalizeMeal']> {
    return this.coordinator.execute({ jobId: 'manual.meal.finalize', ...command });
  }

  skipMeal(
    command: Parameters<FeedingOperationCommandPort['skipMeal']>[0],
  ): ReturnType<FeedingOperationCommandPort['skipMeal']> {
    return this.coordinator.execute({ jobId: 'manual.meal.skip', ...command });
  }

  recordMeal(
    command: Parameters<FeedingOperationCommandPort['recordMeal']>[0],
  ): ReturnType<FeedingOperationCommandPort['recordMeal']> {
    return this.coordinator.execute({ jobId: 'mobile.meal.record', ...command });
  }

  reconcileScheduled(
    command: Parameters<FeedingOperationCommandPort['reconcileScheduled']>[0],
  ): ReturnType<FeedingOperationCommandPort['reconcileScheduled']> {
    return this.coordinator.reconcile(command);
  }
}

/** Composition-root hook whose value type does not expose either concrete class. */
export const FEEDING_OPERATION_PRIVATE_PROVIDERS: readonly Provider[] = Object.freeze([
  FeedingOperationCoordinatorService,
  FeedingOperationCommandPortBinding,
  {
    provide: FEEDING_OPERATION_COMMAND_PORT,
    useExisting: FeedingOperationCommandPortBinding,
  },
]);
