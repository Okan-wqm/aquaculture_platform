import {
  createCanonicalJsonDocumentV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';

import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  type FeedingJobId,
  feedingDueOccurrences,
} from './feeding-job-catalog';
import { feedingOperationCommandDigestV1 } from './feeding-operation-command-digest';
import {
  compileFeedingTimezone,
  feedingClockSnapshot,
  type FeedingTimezone,
} from './feeding-timezone';
import { compileFeedingOperationLockSetDigestV1 } from './feeding-operation-envelope';

const EXACT_INTENT_KEYS_V1 = Object.freeze([
  'actorId',
  'authorityGeneration',
  'catalogAdmissionGeneration',
  'catalogDigest',
  'catalogJobCount',
  'catalogRevision',
  'caughtUp',
  'commandDigest',
  'commandPayload',
  'dispatchDigest',
  'dstGapAdjusted',
  'dueAt',
  'generation',
  'jobId',
  'localDate',
  'lockSetDigest',
  'observedAt',
  'operationId',
  'reason',
  'requestId',
  'scheduleKey',
  'schedulerCutDigest',
  'schemaVersion',
  'siteId',
  'targetId',
  'targetKind',
  'targetSetDigest',
  'tenantId',
  'timezone',
  'timezoneSource',
  'unitId',
] as const);

export interface FeedingOperationIntentV1 {
  readonly schemaVersion: 'feeding-operation-intent/v1';
  readonly operationId: string;
  readonly generation: number;
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly requestId: string | null;
  readonly jobId: FeedingJobId;
  readonly targetKind: 'tenant' | 'site' | 'unit';
  readonly targetId: string | null;
  readonly siteId: string | null;
  readonly unitId: string | null;
  readonly reason: 'scheduled_reconciliation' | 'operator_request' | 'device_request';
  readonly catalogRevision: typeof FEEDING_JOB_CATALOG_REVISION;
  readonly catalogDigest: typeof FEEDING_JOB_CATALOG_DIGEST;
  readonly catalogJobCount: number;
  readonly commandDigest: string;
  readonly commandPayload: CanonicalJsonValue;
  readonly lockSetDigest: string;
  readonly observedAt: string;
  readonly dueAt: string;
  readonly scheduleKey: string;
  readonly localDate: string;
  readonly timezone: FeedingTimezone;
  readonly caughtUp: boolean;
  readonly dstGapAdjusted: boolean;
  readonly timezoneSource: 'tenant_site_catalog' | 'utc_global';
  readonly catalogAdmissionGeneration: number | null;
  readonly authorityGeneration: number | null;
  readonly targetSetDigest: string | null;
  readonly schedulerCutDigest: string | null;
  readonly dispatchDigest: string | null;
}

function isRecord(
  value: CanonicalJsonValue,
): value is Readonly<Record<string, CanonicalJsonValue>> {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function record(value: CanonicalJsonValue): Readonly<Record<string, CanonicalJsonValue>> {
  if (!isRecord(value)) {
    throw new TypeError('Feeding operation intent must be one canonical JSON object');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== EXACT_INTENT_KEYS_V1.length ||
    keys.some((key, index) => key !== EXACT_INTENT_KEYS_V1[index])
  ) {
    throw new TypeError('Feeding operation intent violates its exact key contract');
  }
  return value;
}

function stringValue(
  source: Readonly<Record<string, CanonicalJsonValue>>,
  key: string,
  maxLength: number,
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`Feeding operation intent ${key} must be a bounded string`);
  }
  return value;
}

function nullableString(
  source: Readonly<Record<string, CanonicalJsonValue>>,
  key: string,
  maxLength: number,
): string | null {
  return source[key] === null ? null : stringValue(source, key, maxLength);
}

function positiveInteger(value: CanonicalJsonValue | undefined, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Feeding operation intent ${name} must be a positive safe integer`);
  }
  return value;
}

function nullablePositiveInteger(
  value: CanonicalJsonValue | undefined,
  name: string,
): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function digest(value: string, name: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`Feeding operation intent ${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function nullableDigest(value: string | null, name: string): string | null {
  return value === null ? null : digest(value, name);
}

function uuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError(`Feeding operation intent ${name} must be a canonical UUID`);
  }
  return value;
}

function nullableUuid(value: string | null, name: string): string | null {
  return value === null ? null : uuid(value, name);
}

function instant(value: string, name: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`Feeding operation intent ${name} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

/** Strictly decodes the single persisted DB intent artifact used by every execution attempt. */
export function decodeFeedingOperationIntentV1(value: unknown): FeedingOperationIntentV1 {
  const source = record(createCanonicalJsonDocumentV1(value).value);
  if (source['schemaVersion'] !== 'feeding-operation-intent/v1') {
    throw new TypeError('Unknown feeding operation intent schema version');
  }
  const operationId = uuid(stringValue(source, 'operationId', 36), 'operationId');
  const generation = positiveInteger(source['generation'], 'generation');
  const jobIdValue = stringValue(source, 'jobId', 160);
  const definition = FEEDING_JOB_CATALOG.find((job) => job.id === jobIdValue);
  if (!definition) throw new TypeError(`Unknown feeding operation intent job ${jobIdValue}`);
  const jobId = definition.id;
  const targetKind = stringValue(source, 'targetKind', 16);
  if (targetKind !== 'tenant' && targetKind !== 'site' && targetKind !== 'unit') {
    throw new TypeError('Feeding operation intent has an unknown target kind');
  }
  const targetId = nullableUuid(nullableString(source, 'targetId', 36), 'targetId');
  const siteId = nullableUuid(nullableString(source, 'siteId', 36), 'siteId');
  const unitId = nullableUuid(nullableString(source, 'unitId', 36), 'unitId');
  if (
    (targetKind === 'tenant' && (targetId !== null || siteId !== null || unitId !== null)) ||
    (targetKind === 'site' && (targetId === null || siteId !== targetId || unitId !== null)) ||
    (targetKind === 'unit' && (targetId === null || unitId !== targetId || siteId === null))
  ) {
    throw new TypeError('Feeding operation intent target projection is inconsistent');
  }
  if (
    (definition.targetCardinality === 'tenant' && targetKind !== 'tenant') ||
    (definition.targetCardinality === 'site' && targetKind !== 'site') ||
    (definition.targetCardinality === 'operation_target' && targetKind === 'tenant')
  ) {
    throw new TypeError('Feeding operation intent target differs from the job catalog');
  }

  const actorId = nullableString(source, 'actorId', 160);
  const requestId = nullableString(source, 'requestId', 200);
  const reason = stringValue(source, 'reason', 32);
  const expectedReason =
    definition.capability === 'scheduled.v2'
      ? 'scheduled_reconciliation'
      : definition.capability === 'operator.manual'
        ? 'operator_request'
        : 'device_request';
  if (
    reason !== expectedReason ||
    (definition.capability === 'scheduled.v2'
      ? actorId !== null || requestId !== null
      : actorId === null || requestId === null)
  ) {
    throw new TypeError('Feeding operation intent admission identity differs from the job catalog');
  }
  if (
    source['catalogRevision'] !== FEEDING_JOB_CATALOG_REVISION ||
    source['catalogDigest'] !== FEEDING_JOB_CATALOG_DIGEST ||
    source['catalogJobCount'] !== FEEDING_JOB_CATALOG.length
  ) {
    throw new TypeError('Feeding operation intent catalog identity is stale');
  }

  const commandDigest = digest(stringValue(source, 'commandDigest', 64), 'commandDigest');
  const commandPayload = source['commandPayload'];
  if (commandPayload === undefined) {
    throw new TypeError('Feeding operation intent commandPayload is required');
  }
  if (feedingOperationCommandDigestV1(commandPayload) !== commandDigest) {
    throw new TypeError('Feeding operation intent command payload digest is invalid');
  }
  const lockSetDigest = digest(stringValue(source, 'lockSetDigest', 64), 'lockSetDigest');
  const observedAtValue = stringValue(source, 'observedAt', 32);
  const dueAtValue = stringValue(source, 'dueAt', 32);
  const observedAt = instant(observedAtValue, 'observedAt');
  const dueAt = instant(dueAtValue, 'dueAt');
  if (dueAt.getTime() > observedAt.getTime()) {
    throw new TypeError('Feeding operation intent dueAt cannot follow observedAt');
  }
  const scheduleKey = stringValue(source, 'scheduleKey', 200);
  const localDate = stringValue(source, 'localDate', 10);
  const timezone = compileFeedingTimezone(stringValue(source, 'timezone', 64));
  if (feedingClockSnapshot(dueAt, timezone).localDate !== localDate) {
    throw new TypeError('Feeding operation intent localDate differs from dueAt/timezone');
  }
  const caughtUp = source['caughtUp'];
  const dstGapAdjusted = source['dstGapAdjusted'];
  if (typeof caughtUp !== 'boolean' || typeof dstGapAdjusted !== 'boolean') {
    throw new TypeError('Feeding operation intent catch-up coordinates must be boolean');
  }
  const timezoneSource = stringValue(source, 'timezoneSource', 32);
  if (timezoneSource !== definition.timezoneSource) {
    throw new TypeError('Feeding operation intent timezone source differs from the job catalog');
  }
  const canonicalOccurrence = feedingDueOccurrences(
    definition,
    observedAt,
    timezone,
    requestId ?? undefined,
  ).find(
    (occurrence) =>
      occurrence.scheduleKey === scheduleKey &&
      occurrence.dueAt.toISOString() === dueAtValue &&
      occurrence.localDate === localDate &&
      occurrence.timezone === timezone &&
      occurrence.caughtUp === caughtUp &&
      occurrence.dstGapAdjusted === dstGapAdjusted,
  );
  if (!canonicalOccurrence) {
    throw new TypeError('Feeding operation intent differs from its canonical catalog occurrence');
  }
  const tenantId = uuid(stringValue(source, 'tenantId', 36), 'tenantId');
  const recomputedLockSetDigest = compileFeedingOperationLockSetDigestV1({
    tenantId,
    jobId,
    targetKind,
    targetId,
    localDate,
  });
  if (lockSetDigest !== recomputedLockSetDigest) {
    throw new TypeError('Feeding operation intent lock set digest differs from its coordinates');
  }

  const catalogAdmissionGeneration = nullablePositiveInteger(
    source['catalogAdmissionGeneration'],
    'catalogAdmissionGeneration',
  );
  const authorityGeneration = nullablePositiveInteger(
    source['authorityGeneration'],
    'authorityGeneration',
  );
  const targetSetDigest = nullableDigest(
    nullableString(source, 'targetSetDigest', 64),
    'targetSetDigest',
  );
  const schedulerCutDigest = nullableDigest(
    nullableString(source, 'schedulerCutDigest', 64),
    'schedulerCutDigest',
  );
  const dispatchDigest = nullableDigest(
    nullableString(source, 'dispatchDigest', 64),
    'dispatchDigest',
  );
  if (
    definition.capability === 'scheduled.v2'
      ? catalogAdmissionGeneration === null ||
        authorityGeneration !== generation ||
        targetSetDigest === null ||
        schedulerCutDigest === null ||
        dispatchDigest === null
      : catalogAdmissionGeneration !== null ||
        authorityGeneration !== null ||
        targetSetDigest !== null ||
        schedulerCutDigest !== null ||
        dispatchDigest !== null
  ) {
    throw new TypeError(
      'Feeding operation intent scheduler authority coordinates are inconsistent',
    );
  }

  return Object.freeze({
    schemaVersion: 'feeding-operation-intent/v1',
    operationId,
    generation,
    tenantId,
    actorId,
    requestId,
    jobId,
    targetKind,
    targetId,
    siteId,
    unitId,
    reason,
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    commandDigest,
    commandPayload,
    lockSetDigest,
    observedAt: observedAtValue,
    dueAt: dueAtValue,
    scheduleKey,
    localDate,
    timezone,
    caughtUp,
    dstGapAdjusted,
    timezoneSource,
    catalogAdmissionGeneration,
    authorityGeneration,
    targetSetDigest,
    schedulerCutDigest,
    dispatchDigest,
  } satisfies FeedingOperationIntentV1);
}
