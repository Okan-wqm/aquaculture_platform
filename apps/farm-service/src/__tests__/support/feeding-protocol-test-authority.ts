import {
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_UTC_TIMEZONE,
  compileFeedingTimezone,
  createFeedingScheduledDispatchEnvelope,
  feedingDueOccurrences,
  feedingJobDefinition,
  feedingWallTimeToInstant,
  feedingClockSnapshot,
  type FeedingSchedulerCutV1,
  type FeedingTimezone,
  type ScheduledFeedingJobId,
  type SiteScheduledFeedingJobId,
  type TenantScheduledFeedingJobId,
} from '@aquaculture/feeding-contracts';
import { canonicalJsonSha256, createCanonicalJsonDocumentV1 } from '@aquaculture/shared-contracts';
import type { MutationInstantV1 } from '@aquaculture/backend-common/database';
import { mintMutationInstantV1 } from '@aquaculture/backend-common/database/mutation-instant-authority';
import { TEST_DATABASE_MUTATION_INSTANT_ISO } from '@aquaculture/testing';

import type {
  ScheduledSiteFeedingOperationCommand,
  ScheduledTenantFeedingOperationCommand,
} from '../../feeding-protocol/feeding-operation-command';
import { ScheduledFeedingOperationExecutor } from '../../feeding-protocol/executors/scheduled-feeding-operation.executor';
import { ProtocolRateService } from '../../feeding-protocol/services/protocol-rate.service';
import { ProtocolResolutionAuthority } from '../../feeding-protocol/services/protocol-resolution.authority';

export const FEEDING_PROTOCOL_TEST_TIMEZONES = Object.freeze({
  UTC: FEEDING_UTC_TIMEZONE,
  ISTANBUL: compileFeedingTimezone('Europe/Istanbul'),
});

export const FEEDING_PROTOCOL_TEST_MUTATION_INSTANT_ISO = TEST_DATABASE_MUTATION_INSTANT_ISO;

/** Sole test-only mint adapter; production cannot manufacture mutation clocks. */
export function feedingProtocolTestMutationInstant(
  observedAt = FEEDING_PROTOCOL_TEST_MUTATION_INSTANT_ISO,
): MutationInstantV1 {
  return mintMutationInstantV1('test_authority', observedAt);
}

/** Uses the same rate and resolution authority composition as the production module. */
export function createProtocolResolutionTestAuthority(): ProtocolResolutionAuthority {
  return new ProtocolResolutionAuthority(new ProtocolRateService());
}

export interface ScheduledFeedingOperationExecutorTestDependencies {
  readonly feedingMutations: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[0];
  readonly dataSource: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[1];
  readonly generator: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[2];
  readonly growthApplier: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[3];
  readonly mealFinalization: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[4];
  readonly temperatureService: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[5];
  readonly fcrCalculation: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[6];
  readonly outboxPublisher: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[7];
  readonly forecastExecutor: ConstructorParameters<typeof ScheduledFeedingOperationExecutor>[8];
  readonly mobileCommandReceipts: ConstructorParameters<
    typeof ScheduledFeedingOperationExecutor
  >[9];
}

/** Constructor-order SSoT for scheduled-operation tests. */
export function createScheduledFeedingOperationTestExecutor(
  dependencies: ScheduledFeedingOperationExecutorTestDependencies,
): ScheduledFeedingOperationExecutor {
  return new ScheduledFeedingOperationExecutor(
    dependencies.feedingMutations,
    dependencies.dataSource,
    dependencies.generator,
    dependencies.growthApplier,
    dependencies.mealFinalization,
    dependencies.temperatureService,
    dependencies.fcrCalculation,
    dependencies.outboxPublisher,
    dependencies.forecastExecutor,
    dependencies.mobileCommandReceipts,
  );
}

interface ScheduledCommandAuthorityInput {
  readonly tenantId: string;
  readonly observedAt?: Date;
  readonly timezone?: FeedingTimezone;
  readonly occurrenceIndex?: number;
}

interface ScheduledSiteCommandAuthorityInput extends ScheduledCommandAuthorityInput {
  readonly jobId: SiteScheduledFeedingJobId;
  readonly siteId: string;
}

interface ScheduledTenantCommandAuthorityInput extends ScheduledCommandAuthorityInput {
  readonly jobId: TenantScheduledFeedingJobId;
}

const TEST_LOCAL_DATE = '2026-08-08';

/**
 * Materializes a due instant from the catalog itself. Tests own only a stable
 * calendar anchor; local time, weekday/day-of-month and interval cadence remain
 * single-sourced by the production feeding job definition.
 */
function defaultObservedAt(jobId: ScheduledFeedingJobId, timezone: FeedingTimezone): Date {
  const definition = feedingJobDefinition(jobId);
  switch (definition.scheduleKind) {
    case 'local_daily':
      return feedingWallTimeToInstant(TEST_LOCAL_DATE, definition.localTime, timezone);
    case 'local_monthly':
      return feedingWallTimeToInstant(
        `${TEST_LOCAL_DATE.slice(0, 8)}${String(definition.localDayOfMonth).padStart(2, '0')}`,
        definition.localTime,
        timezone,
      );
    case 'local_weekly': {
      const anchor = new Date(`${TEST_LOCAL_DATE}T00:00:00.000Z`);
      for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
        const localDate = new Date(anchor.getTime() + dayOffset * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const instant = feedingWallTimeToInstant(localDate, definition.localTime, timezone);
        if (feedingClockSnapshot(instant, timezone).localWeekday === definition.localWeekday) {
          return instant;
        }
      }
      throw new Error(`No weekly catalog occurrence could be materialized for ${jobId}`);
    }
    case 'absolute_interval': {
      const anchor = new Date(`${TEST_LOCAL_DATE}T12:34:00.000Z`);
      const intervalMs = definition.intervalMinutes * 60_000;
      return new Date(Math.floor(anchor.getTime() / intervalMs) * intervalMs);
    }
    case 'on_demand':
      throw new Error(`${jobId} is not a scheduled feeding job`);
  }
}

function digest(domain: string, value: ReturnType<typeof createCanonicalJsonDocumentV1>): string {
  return canonicalJsonSha256(
    { domain, schemaVersion: 'feeding-protocol-test-authority/v1' },
    value,
  );
}

function schedulerCut(
  jobId: ScheduledFeedingJobId,
  tenantId: string,
  targetId: string | null,
  observedAt: Date,
  timezone: FeedingTimezone,
): FeedingSchedulerCutV1 {
  const definition = feedingJobDefinition(jobId);
  const targetSetDigest = digest(
    'aquaculture.feeding-protocol-test-target-set',
    createCanonicalJsonDocumentV1({ jobId, tenantId, targetId, timezone }),
  );
  return Object.freeze({
    schemaVersion: 'feeding-scheduler-cut/v1',
    observedAt,
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogAdmissionGeneration: 1,
    authorityGeneration: 1,
    timezoneSource: definition.timezoneSource,
    timezone,
    targetSetDigest,
    cutDigest: digest(
      'aquaculture.feeding-protocol-test-scheduler-cut',
      createCanonicalJsonDocumentV1({
        jobId,
        tenantId,
        targetId,
        observedAt: observedAt.toISOString(),
        timezone,
        targetSetDigest,
      }),
    ),
  });
}

function dueOccurrence(
  jobId: ScheduledFeedingJobId,
  observedAt: Date,
  timezone: FeedingTimezone,
  occurrenceIndex: number | undefined,
) {
  const occurrences = feedingDueOccurrences(feedingJobDefinition(jobId), observedAt, timezone);
  const index = occurrenceIndex ?? occurrences.length - 1;
  const occurrence = occurrences[index];
  if (!occurrence) {
    throw new Error(`No catalogued occurrence ${index} is due for ${jobId}`);
  }
  return occurrence;
}

export function createScheduledSiteFeedingOperationTestCommand(
  input: ScheduledSiteCommandAuthorityInput,
): ScheduledSiteFeedingOperationCommand {
  const timezone = input.timezone ?? FEEDING_UTC_TIMEZONE;
  const observedAt = input.observedAt ?? defaultObservedAt(input.jobId, timezone);
  const cut = schedulerCut(input.jobId, input.tenantId, input.siteId, observedAt, timezone);
  const occurrence = dueOccurrence(input.jobId, observedAt, timezone, input.occurrenceIndex);
  const envelope = createFeedingScheduledDispatchEnvelope({
    jobId: input.jobId,
    tenantId: input.tenantId,
    target: { targetKind: 'site', targetId: input.siteId },
    cut,
    occurrence,
  });
  return Object.freeze({
    jobId: input.jobId,
    tenantId: input.tenantId,
    siteId: input.siteId,
    schedulerCut: cut,
    occurrence,
    dispatchDigest: envelope.dispatchDigest,
  });
}

export function createScheduledTenantFeedingOperationTestCommand(
  input: ScheduledTenantCommandAuthorityInput,
): ScheduledTenantFeedingOperationCommand {
  const timezone = input.timezone ?? FEEDING_UTC_TIMEZONE;
  const observedAt = input.observedAt ?? defaultObservedAt(input.jobId, timezone);
  const cut = schedulerCut(input.jobId, input.tenantId, null, observedAt, timezone);
  const occurrence = dueOccurrence(input.jobId, observedAt, timezone, input.occurrenceIndex);
  const envelope = createFeedingScheduledDispatchEnvelope({
    jobId: input.jobId,
    tenantId: input.tenantId,
    target: { targetKind: 'tenant', targetId: null },
    cut,
    occurrence,
  });
  return Object.freeze({
    jobId: input.jobId,
    tenantId: input.tenantId,
    schedulerCut: cut,
    occurrence,
    dispatchDigest: envelope.dispatchDigest,
  });
}
