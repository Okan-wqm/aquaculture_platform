import { canonicalJsonSha256, createCanonicalJsonDocumentV1 } from '@aquaculture/shared-contracts';

import type {
  FeedingDueOccurrence,
  FeedingTimezoneSource,
  ScheduledFeedingJobId,
} from './feeding-job-catalog';
import {
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_SCHEDULED_JOB_IDS,
  feedingDueOccurrences,
  feedingJobDefinition,
} from './feeding-job-catalog';
import {
  compileFeedingTimezone,
  FEEDING_UTC_TIMEZONE,
  type FeedingTimezone,
} from './feeding-timezone';
import { feedingOperationCommandDigestV1 } from './feeding-operation-command-digest';

export const FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION = 'feeding-schedule-dispatch/v1' as const;

/** Immutable authority cut attached to one compiled scheduler target. */
export interface FeedingSchedulerCutV1 {
  readonly schemaVersion: 'feeding-scheduler-cut/v1';
  readonly observedAt: Date;
  readonly catalogRevision: string;
  readonly catalogDigest: string;
  readonly catalogAdmissionGeneration: number;
  readonly authorityGeneration: number;
  readonly timezoneSource: FeedingTimezoneSource;
  readonly timezone: FeedingTimezone;
  readonly targetSetDigest: string;
  readonly cutDigest: string;
}

export type FeedingScheduledDispatchTargetV1 =
  | {
      readonly targetKind: 'site';
      readonly targetId: string;
    }
  | {
      readonly targetKind: 'tenant';
      readonly targetId: null;
    };

interface FeedingScheduledDispatchEnvelopeBaseV1 {
  readonly schemaVersion: typeof FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION;
  readonly catalogRevision: string;
  readonly catalogDigest: string;
  readonly catalogAdmissionGeneration: number;
  readonly authorityGeneration: number;
  readonly jobId: ScheduledFeedingJobId;
  readonly tenantId: string;
  readonly timezone: FeedingTimezone;
  readonly timezoneSource: FeedingTimezoneSource;
  readonly targetSetDigest: string;
  readonly observedAt: string;
  readonly cutDigest: string;
  readonly scheduleKey: string;
  readonly localDate: string;
  readonly dueAt: string;
  readonly caughtUp: boolean;
  readonly dstGapAdjusted: boolean;
  readonly commandDigest: string;
  readonly dispatchDigest: string;
}

export type FeedingScheduledDispatchEnvelopeV1 = FeedingScheduledDispatchEnvelopeBaseV1 &
  FeedingScheduledDispatchTargetV1;

export type FeedingScheduledDispatchUnsignedV1 = Omit<
  FeedingScheduledDispatchEnvelopeBaseV1,
  'dispatchDigest'
> &
  FeedingScheduledDispatchTargetV1;

/**
 * One command identity implementation shared by scheduler admission and the
 * tenant executor. Scheduler cuts and wall-clock observations are deliberately
 * excluded: they fence admission, while the semantic command remains one
 * job/tenant/target operation.
 */
export function feedingScheduledCommandDigest(
  jobId: ScheduledFeedingJobId,
  tenantId: string,
  target: FeedingScheduledDispatchTargetV1,
): string {
  return target.targetKind === 'tenant'
    ? feedingOperationCommandDigestV1({ jobId, tenantId })
    : feedingOperationCommandDigestV1({ jobId, tenantId, siteId: target.targetId });
}

export function feedingScheduledDispatchDigest(
  envelope: FeedingScheduledDispatchUnsignedV1,
): string {
  return canonicalJsonSha256(
    {
      domain: 'aquaculture.feeding-schedule-dispatch',
      schemaVersion: FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
    },
    createCanonicalJsonDocumentV1(envelope),
  );
}

export function createFeedingScheduledDispatchEnvelope(input: {
  readonly jobId: ScheduledFeedingJobId;
  readonly tenantId: string;
  readonly target: FeedingScheduledDispatchTargetV1;
  readonly cut: FeedingSchedulerCutV1;
  readonly occurrence: FeedingDueOccurrence;
}): FeedingScheduledDispatchEnvelopeV1 {
  const commandDigest = feedingScheduledCommandDigest(input.jobId, input.tenantId, input.target);
  const base = Object.freeze({
    schemaVersion: FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
    catalogRevision: input.cut.catalogRevision,
    catalogDigest: input.cut.catalogDigest,
    catalogAdmissionGeneration: input.cut.catalogAdmissionGeneration,
    authorityGeneration: input.cut.authorityGeneration,
    jobId: input.jobId,
    tenantId: input.tenantId,
    timezone: input.cut.timezone,
    timezoneSource: input.cut.timezoneSource,
    targetSetDigest: input.cut.targetSetDigest,
    observedAt: input.cut.observedAt.toISOString(),
    cutDigest: input.cut.cutDigest,
    scheduleKey: input.occurrence.scheduleKey,
    localDate: input.occurrence.localDate,
    dueAt: input.occurrence.dueAt.toISOString(),
    caughtUp: input.occurrence.caughtUp,
    dstGapAdjusted: input.occurrence.dstGapAdjusted,
    commandDigest,
  });
  const unsigned: FeedingScheduledDispatchUnsignedV1 =
    input.target.targetKind === 'tenant'
      ? Object.freeze({ ...base, targetKind: 'tenant', targetId: null })
      : Object.freeze({
          ...base,
          targetKind: 'site',
          targetId: input.target.targetId,
        });
  return Object.freeze({
    ...unsigned,
    dispatchDigest: feedingScheduledDispatchDigest(unsigned),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DISPATCH_KEYS = Object.freeze([
  'schemaVersion',
  'catalogRevision',
  'catalogDigest',
  'catalogAdmissionGeneration',
  'authorityGeneration',
  'jobId',
  'tenantId',
  'targetKind',
  'targetId',
  'timezone',
  'timezoneSource',
  'targetSetDigest',
  'observedAt',
  'cutDigest',
  'scheduleKey',
  'localDate',
  'dueAt',
  'caughtUp',
  'dstGapAdjusted',
  'commandDigest',
  'dispatchDigest',
] as const);

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...DISPATCH_KEYS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function canonicalInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) || instant.toISOString() !== value ? undefined : instant;
}

/** Strict decoder used at the scheduler/API process boundary. */
export function parseFeedingScheduledDispatchEnvelope(
  value: unknown,
): FeedingScheduledDispatchEnvelopeV1 {
  if (!isRecord(value) || !exactKeys(value)) {
    throw new Error('Feeding schedule dispatch has unknown or missing fields');
  }
  const {
    schemaVersion,
    catalogRevision,
    catalogDigest,
    catalogAdmissionGeneration,
    authorityGeneration,
    jobId: jobIdValue,
    tenantId,
    targetKind,
    targetId,
    timezone: timezoneValue,
    timezoneSource,
    targetSetDigest,
    observedAt: observedAtValue,
    cutDigest,
    scheduleKey,
    localDate,
    dueAt: dueAtValue,
    caughtUp,
    dstGapAdjusted,
    commandDigest,
    dispatchDigest,
  } = value;
  const observedAt = canonicalInstant(observedAtValue);
  const dueAt = canonicalInstant(dueAtValue);
  const jobId = FEEDING_SCHEDULED_JOB_IDS.find((candidate) => candidate === jobIdValue);
  const positiveGeneration = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0;
  const digest = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate);
  if (
    schemaVersion !== FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION ||
    catalogRevision !== FEEDING_JOB_CATALOG_REVISION ||
    catalogDigest !== FEEDING_JOB_CATALOG_DIGEST ||
    !jobId ||
    !positiveGeneration(catalogAdmissionGeneration) ||
    !positiveGeneration(authorityGeneration) ||
    typeof tenantId !== 'string' ||
    typeof timezoneValue !== 'string' ||
    typeof timezoneSource !== 'string' ||
    !digest(targetSetDigest) ||
    !digest(cutDigest) ||
    !digest(commandDigest) ||
    !digest(dispatchDigest) ||
    !observedAt ||
    !dueAt ||
    typeof scheduleKey !== 'string' ||
    typeof localDate !== 'string' ||
    typeof caughtUp !== 'boolean' ||
    typeof dstGapAdjusted !== 'boolean'
  ) {
    throw new Error('Feeding schedule dispatch violates its typed value contract');
  }
  const timezone = compileFeedingTimezone(timezoneValue);
  const definition = feedingJobDefinition(jobId);
  let target: FeedingScheduledDispatchTargetV1 | undefined;
  if (targetKind === 'tenant' && targetId === null) {
    target = { targetKind: 'tenant', targetId: null };
  } else if (targetKind === 'site' && typeof targetId === 'string') {
    target = { targetKind: 'site', targetId };
  }
  if (
    !target ||
    target.targetKind !== definition.targetCardinality ||
    timezoneSource !== definition.timezoneSource ||
    (target.targetKind === 'tenant' && timezone !== FEEDING_UTC_TIMEZONE)
  ) {
    throw new Error('Feeding schedule dispatch target disagrees with its catalog job');
  }
  const occurrence = feedingDueOccurrences(definition, observedAt, timezone).find(
    (candidate) =>
      candidate.scheduleKey === scheduleKey &&
      candidate.dueAt.toISOString() === dueAtValue &&
      candidate.localDate === localDate &&
      candidate.caughtUp === caughtUp &&
      candidate.dstGapAdjusted === dstGapAdjusted,
  );
  if (!occurrence) {
    throw new Error('Feeding schedule dispatch is not due under the shared catalog');
  }
  const decodedBase = {
    schemaVersion: FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
    catalogRevision,
    catalogDigest,
    catalogAdmissionGeneration,
    authorityGeneration,
    jobId,
    tenantId,
    timezone,
    timezoneSource: definition.timezoneSource,
    targetSetDigest,
    observedAt: observedAt.toISOString(),
    cutDigest,
    scheduleKey,
    localDate,
    dueAt: dueAt.toISOString(),
    caughtUp,
    dstGapAdjusted,
    commandDigest,
    dispatchDigest,
  };
  const decoded: FeedingScheduledDispatchEnvelopeV1 =
    target.targetKind === 'tenant'
      ? { ...decodedBase, targetKind: 'tenant', targetId: null }
      : { ...decodedBase, targetKind: 'site', targetId: target.targetId };
  const { dispatchDigest: _dispatchDigest, ...unsigned } = decoded;
  if (
    feedingScheduledCommandDigest(jobId, tenantId, target) !== commandDigest ||
    feedingScheduledDispatchDigest(unsigned) !== dispatchDigest
  ) {
    throw new Error('Feeding schedule dispatch canonical digest is invalid');
  }
  return Object.freeze(decoded);
}
