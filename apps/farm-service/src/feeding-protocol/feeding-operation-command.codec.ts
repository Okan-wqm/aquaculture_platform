import { Role } from '@aquaculture/backend-common/decorators';
import type { RequiredMobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';
import {
  FEEDING_METHOD,
  FEEDING_MEAL_MOBILE_COMMAND_V1,
  FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
  decodeFeedingMealQuantityKgV1,
  decodeFeedingRecordEnvironment,
  decodeFeedingRecordFishBehavior,
  decodeFeedingRecordTime,
  decodeOptionalFeedingCurrency,
  feedingMealMobilePayloadSha256V1,
  feedingOperationCommandDigestV1,
  parseFeedingScheduledDispatchEnvelope,
  type FeedingJobId,
  type FeedingMethodValue,
  type OnDemandFeedingJobId,
  type FeedingOperationIntentV1,
  type FeedingScheduledDispatchEnvelopeV1,
  type SiteScheduledFeedingJobId,
  type TenantScheduledFeedingJobId,
} from '@aquaculture/feeding-contracts';
import {
  createCanonicalJsonDocumentV1,
  createWireJsonDocumentV1,
  type CanonicalJsonValue,
} from '@aquaculture/shared-contracts';

import type {
  FeedingOperationCaller,
  FeedingOperationCommand,
  FeedingOperationCommandFor,
  ManualFeedingRecordPayload,
  ScheduledSiteFeedingOperationCommand,
  ScheduledTenantFeedingOperationCommand,
  UpdateFeedingRecordPayload,
} from './feeding-operation-command';

type CanonicalObject = Readonly<Record<string, CanonicalJsonValue>>;

export interface FeedingOperationCommandArtifactV1<K extends FeedingJobId> {
  readonly schemaVersion: 'feeding-operation-command-artifact/v1';
  readonly payload: CanonicalJsonValue;
  readonly digest: string;
  readonly command: FeedingOperationCommandFor<K>;
}

interface RuntimeFeedingOperationCommandArtifactV1 {
  readonly schemaVersion: 'feeding-operation-command-artifact/v1';
  readonly payload: CanonicalJsonValue;
  readonly digest: string;
  readonly command: FeedingOperationCommand;
}

interface FeedingOperationCommandCodec {
  compile(command: FeedingOperationCommand): RuntimeFeedingOperationCommandArtifactV1;
  decode(payload: CanonicalJsonValue, intent: FeedingOperationIntentV1): FeedingOperationCommand;
}

type FeedingOperationCommandCodecMap = {
  readonly [K in FeedingJobId]: FeedingOperationCommandCodec;
};

function canonicalObject(
  value: CanonicalJsonValue,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): CanonicalObject {
  if (!isCanonicalObject(value)) {
    throw new TypeError(`${label} must be one canonical JSON object`);
  }
  const expected = [...required, ...optional].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length - optional.filter((key) => !(key in value)).length ||
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new TypeError(`${label} violates its exact key contract`);
  }
  return value;
}

function isCanonicalObject(value: CanonicalJsonValue): value is CanonicalObject {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function boundedString(value: CanonicalJsonValue | undefined, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function optionalString(
  value: CanonicalJsonValue | undefined,
  label: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function uuid(value: CanonicalJsonValue | undefined, label: string): string {
  const candidate = boundedString(value, label, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
  ) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
  return candidate;
}

function optionalUuid(value: CanonicalJsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : uuid(value, label);
}

function finiteNumber(value: CanonicalJsonValue | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: CanonicalJsonValue | undefined, label: string): number {
  const candidate = finiteNumber(value, label);
  if (candidate < 0) throw new TypeError(`${label} cannot be negative`);
  return candidate;
}

function optionalNonNegativeNumber(
  value: CanonicalJsonValue | undefined,
  label: string,
): number | undefined {
  return value === undefined ? undefined : nonNegativeNumber(value, label);
}

function booleanValue(value: CanonicalJsonValue | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}

function positiveInteger(
  value: CanonicalJsonValue | undefined,
  label: string,
  maximum?: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveInteger(
  value: CanonicalJsonValue | undefined,
  label: string,
  maximum?: number,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label, maximum);
}

function canonicalInstant(value: CanonicalJsonValue | undefined, label: string): Date {
  const candidate = boundedString(value, label, 32);
  const instant = new Date(candidate);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== candidate) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 instant`);
  }
  return Object.freeze(instant);
}

function optionalFeedingMethod(
  value: CanonicalJsonValue | undefined,
  label: string,
): FeedingMethodValue | undefined {
  if (value === undefined) return undefined;
  for (const candidate of Object.values(FEEDING_METHOD)) {
    if (value === candidate) return candidate;
  }
  throw new TypeError(`${label} is not in the feeding-method authority`);
}

function stringArray<T extends string>(
  value: CanonicalJsonValue | undefined,
  label: string,
  decode: (entry: CanonicalJsonValue, index: number) => T,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const decoded = value.map((entry, index) => decode(entry, index)).sort();
  if (new Set(decoded).size !== decoded.length) {
    throw new TypeError(`${label} cannot contain duplicate identities`);
  }
  return Object.freeze(decoded);
}

function decodeCaller(value: CanonicalJsonValue | undefined): FeedingOperationCaller {
  if (value === undefined) throw new TypeError('feeding command caller is required');
  const caller = canonicalObject(
    value,
    ['sub', 'roles'],
    ['assignedSiteIds'],
    'feeding command caller',
  );
  const roles = stringArray(caller.roles, 'feeding command caller.roles', (entry) => {
    for (const candidate of Object.values(Role)) {
      if (entry === candidate) return candidate;
    }
    throw new TypeError('feeding command caller.roles contains an unknown role');
  });
  if (!roles || roles.length < 1) {
    throw new TypeError('feeding command caller.roles requires at least one role');
  }
  const assignedSiteIds = stringArray(
    caller.assignedSiteIds,
    'feeding command caller.assignedSiteIds',
    (entry, index) => uuid(entry, `feeding command caller.assignedSiteIds[${index}]`),
  );
  return Object.freeze({
    sub: boundedString(caller.sub, 'feeding command caller.sub', 160),
    roles,
    ...(assignedSiteIds === undefined ? {} : { assignedSiteIds }),
  });
}

function decodeMobileEnvelope(
  value: CanonicalJsonValue | undefined,
  expectedPayloadHash: string,
): RequiredMobileCommandEnvelope {
  if (value === undefined) throw new TypeError('mobile command envelope is required');
  const envelope = canonicalObject(
    value,
    ['clientCommandId', 'payloadHash'],
    ['clientCreatedAt', 'deviceId', 'operationType', 'schemaVersion'],
    'mobile command envelope',
  );
  const clientCreatedAt = optionalString(
    envelope.clientCreatedAt,
    'mobile command envelope.clientCreatedAt',
    32,
  );
  if (clientCreatedAt !== undefined)
    canonicalInstant(clientCreatedAt, 'mobile command envelope.clientCreatedAt');
  const deviceId = optionalUuid(envelope.deviceId, 'mobile command envelope.deviceId');
  const operationType = optionalString(
    envelope.operationType,
    'mobile command envelope.operationType',
    80,
  );
  const schemaVersion = optionalString(
    envelope.schemaVersion,
    'mobile command envelope.schemaVersion',
    32,
  );
  const payloadHash = boundedString(
    envelope.payloadHash,
    'mobile command envelope.payloadHash',
    128,
  );
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) {
    throw new TypeError('mobile command envelope.payloadHash must be a lowercase SHA-256 digest');
  }
  if (payloadHash !== expectedPayloadHash) {
    throw new TypeError('mobile command envelope.payloadHash differs from its command payload');
  }
  if (
    operationType !== undefined &&
    operationType !== FEEDING_MEAL_MOBILE_COMMAND_V1.operationType
  ) {
    throw new TypeError(
      `mobile command envelope.operationType is not ${FEEDING_MEAL_MOBILE_COMMAND_V1.operationType}`,
    );
  }
  if (
    schemaVersion !== undefined &&
    schemaVersion !== FEEDING_MEAL_MOBILE_COMMAND_V1.schemaVersion
  ) {
    throw new TypeError('mobile command envelope.schemaVersion is unsupported');
  }
  return Object.freeze({
    clientCommandId: uuid(envelope.clientCommandId, 'mobile command envelope.clientCommandId'),
    payloadHash,
    ...(clientCreatedAt === undefined ? {} : { clientCreatedAt }),
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(operationType === undefined ? {} : { operationType }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
  });
}

function decodeManualFeedingPayload(
  value: CanonicalJsonValue | undefined,
): ManualFeedingRecordPayload {
  if (value === undefined) throw new TypeError('manual feeding payload is required');
  const payload = canonicalObject(
    value,
    ['batchId', 'feedingDate', 'feedingTime', 'feedId', 'plannedAmount', 'actualAmount', 'fedBy'],
    [
      'tankId',
      'pondId',
      'batchLocationId',
      'feedingSequence',
      'totalMealsToday',
      'feedBatchNumber',
      'wasteAmount',
      'environment',
      'fishBehavior',
      'feedingMethod',
      'equipmentId',
      'feedingDurationMinutes',
      'feedCost',
      'currency',
      'notes',
      'skipReason',
    ],
    'manual feeding payload',
  );
  const tankId = optionalUuid(payload.tankId, 'manual feeding payload.tankId');
  const pondId = optionalUuid(payload.pondId, 'manual feeding payload.pondId');
  const batchLocationId = optionalUuid(
    payload.batchLocationId,
    'manual feeding payload.batchLocationId',
  );
  const feedingSequence = optionalPositiveInteger(
    payload.feedingSequence,
    'manual feeding payload.feedingSequence',
    20,
  );
  const totalMealsToday = optionalPositiveInteger(
    payload.totalMealsToday,
    'manual feeding payload.totalMealsToday',
    20,
  );
  const feedBatchNumber = optionalString(
    payload.feedBatchNumber,
    'manual feeding payload.feedBatchNumber',
    100,
  );
  const wasteAmount = optionalNonNegativeNumber(
    payload.wasteAmount,
    'manual feeding payload.wasteAmount',
  );
  const environment = decodeFeedingRecordEnvironment(payload.environment);
  const fishBehavior = decodeFeedingRecordFishBehavior(payload.fishBehavior);
  const feedingMethod = optionalFeedingMethod(
    payload.feedingMethod,
    'manual feeding payload.feedingMethod',
  );
  const equipmentId = optionalUuid(payload.equipmentId, 'manual feeding payload.equipmentId');
  const feedingDurationMinutes = optionalPositiveInteger(
    payload.feedingDurationMinutes,
    'manual feeding payload.feedingDurationMinutes',
  );
  const feedCost = optionalNonNegativeNumber(payload.feedCost, 'manual feeding payload.feedCost');
  const currency = decodeOptionalFeedingCurrency(payload.currency);
  const notes = optionalString(payload.notes, 'manual feeding payload.notes', 4_000);
  const skipReason = optionalString(payload.skipReason, 'manual feeding payload.skipReason', 500);
  return Object.freeze({
    batchId: uuid(payload.batchId, 'manual feeding payload.batchId'),
    ...(tankId === undefined ? {} : { tankId }),
    ...(pondId === undefined ? {} : { pondId }),
    ...(batchLocationId === undefined ? {} : { batchLocationId }),
    feedingDate: canonicalInstant(payload.feedingDate, 'manual feeding payload.feedingDate'),
    feedingTime: decodeFeedingRecordTime(payload.feedingTime),
    ...(feedingSequence === undefined ? {} : { feedingSequence }),
    ...(totalMealsToday === undefined ? {} : { totalMealsToday }),
    feedId: uuid(payload.feedId, 'manual feeding payload.feedId'),
    ...(feedBatchNumber === undefined ? {} : { feedBatchNumber }),
    plannedAmount: nonNegativeNumber(payload.plannedAmount, 'manual feeding payload.plannedAmount'),
    actualAmount: nonNegativeNumber(payload.actualAmount, 'manual feeding payload.actualAmount'),
    ...(wasteAmount === undefined ? {} : { wasteAmount }),
    ...(environment === undefined ? {} : { environment }),
    ...(fishBehavior === undefined ? {} : { fishBehavior }),
    ...(feedingMethod === undefined ? {} : { feedingMethod }),
    ...(equipmentId === undefined ? {} : { equipmentId }),
    ...(feedingDurationMinutes === undefined ? {} : { feedingDurationMinutes }),
    ...(feedCost === undefined ? {} : { feedCost }),
    ...(currency === undefined ? {} : { currency }),
    fedBy: uuid(payload.fedBy, 'manual feeding payload.fedBy'),
    ...(notes === undefined ? {} : { notes }),
    ...(skipReason === undefined ? {} : { skipReason }),
  });
}

function decodeUpdateFeedingPayload(
  value: CanonicalJsonValue | undefined,
): UpdateFeedingRecordPayload {
  if (value === undefined) throw new TypeError('feeding update payload is required');
  const payload = canonicalObject(
    value,
    [],
    ['actualAmount', 'wasteAmount', 'environment', 'fishBehavior', 'notes', 'verifiedBy'],
    'feeding update payload',
  );
  const actualAmount = optionalNonNegativeNumber(
    payload.actualAmount,
    'feeding update payload.actualAmount',
  );
  const wasteAmount = optionalNonNegativeNumber(
    payload.wasteAmount,
    'feeding update payload.wasteAmount',
  );
  const environment = decodeFeedingRecordEnvironment(payload.environment);
  const fishBehavior = decodeFeedingRecordFishBehavior(payload.fishBehavior);
  const notes = optionalString(payload.notes, 'feeding update payload.notes', 4_000);
  const verifiedBy = optionalUuid(payload.verifiedBy, 'feeding update payload.verifiedBy');
  return Object.freeze({
    ...(actualAmount === undefined ? {} : { actualAmount }),
    ...(wasteAmount === undefined ? {} : { wasteAmount }),
    ...(environment === undefined ? {} : { environment }),
    ...(fishBehavior === undefined ? {} : { fishBehavior }),
    ...(notes === undefined ? {} : { notes }),
    ...(verifiedBy === undefined ? {} : { verifiedBy }),
  });
}

function assertOnDemandIdentity(
  command: {
    readonly jobId: FeedingJobId;
    readonly tenantId: string;
    readonly actorId: string;
    readonly requestId: string;
  },
  intent: FeedingOperationIntentV1,
): void {
  if (
    intent.jobId !== command.jobId ||
    intent.tenantId !== command.tenantId ||
    intent.actorId !== command.actorId ||
    intent.requestId !== command.requestId
  ) {
    throw new TypeError('Persisted feeding command payload differs from its intent identity');
  }
}

interface MealCommandIdentity {
  readonly tenantId: string;
  readonly actorId: string;
  readonly requestId: string;
  readonly caller: FeedingOperationCaller;
  readonly mealId: string;
}

function decodeMealCommandIdentity(value: CanonicalObject, label: string): MealCommandIdentity {
  const actorId = boundedString(value.actorId, `${label} actorId`, 160);
  const caller = decodeCaller(value.caller);
  if (actorId !== caller.sub) {
    throw new TypeError(`${label} actorId differs from its authenticated caller`);
  }
  return Object.freeze({
    tenantId: uuid(value.tenantId, `${label} tenantId`),
    actorId,
    requestId: boundedString(value.requestId, `${label} requestId`, 200),
    caller,
    mealId: uuid(value.mealId, `${label} mealId`),
  });
}

function onDemandCodec<K extends OnDemandFeedingJobId>(
  decodePayload: (payload: CanonicalJsonValue) => FeedingOperationCommandFor<K>,
): FeedingOperationCommandCodec {
  return Object.freeze({
    compile(command: FeedingOperationCommand): RuntimeFeedingOperationCommandArtifactV1 {
      const admitted = decodePayload(createWireJsonDocumentV1(command).value);
      const payload = createWireJsonDocumentV1(admitted).value;
      return Object.freeze({
        schemaVersion: 'feeding-operation-command-artifact/v1',
        payload,
        digest: feedingOperationCommandDigestV1(payload),
        command: admitted,
      });
    },
    decode(payload: CanonicalJsonValue, intent: FeedingOperationIntentV1): FeedingOperationCommand {
      const command = decodePayload(createCanonicalJsonDocumentV1(payload).value);
      assertOnDemandIdentity(command, intent);
      return command;
    },
  });
}

function scheduledEnvelopeFromCommand(
  command: ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand,
): FeedingScheduledDispatchEnvelopeV1 {
  const target =
    'siteId' in command
      ? { targetKind: 'site' as const, targetId: command.siteId }
      : { targetKind: 'tenant' as const, targetId: null };
  return parseFeedingScheduledDispatchEnvelope({
    schemaVersion: FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
    catalogRevision: command.schedulerCut.catalogRevision,
    catalogDigest: command.schedulerCut.catalogDigest,
    catalogAdmissionGeneration: command.schedulerCut.catalogAdmissionGeneration,
    authorityGeneration: command.schedulerCut.authorityGeneration,
    jobId: command.jobId,
    tenantId: command.tenantId,
    targetKind: target.targetKind,
    targetId: target.targetId,
    timezone: command.schedulerCut.timezone,
    timezoneSource: command.schedulerCut.timezoneSource,
    targetSetDigest: command.schedulerCut.targetSetDigest,
    observedAt: command.schedulerCut.observedAt.toISOString(),
    cutDigest: command.schedulerCut.cutDigest,
    scheduleKey: command.occurrence.scheduleKey,
    localDate: command.occurrence.localDate,
    dueAt: command.occurrence.dueAt.toISOString(),
    caughtUp: command.occurrence.caughtUp,
    dstGapAdjusted: command.occurrence.dstGapAdjusted,
    commandDigest: feedingOperationCommandDigestV1(
      target.targetKind === 'tenant'
        ? { jobId: command.jobId, tenantId: command.tenantId }
        : { jobId: command.jobId, tenantId: command.tenantId, siteId: target.targetId },
    ),
    dispatchDigest: command.dispatchDigest,
  });
}

function scheduledEnvelopeFromIntent(
  intent: FeedingOperationIntentV1,
): FeedingScheduledDispatchEnvelopeV1 {
  return parseFeedingScheduledDispatchEnvelope({
    schemaVersion: FEEDING_SCHEDULE_DISPATCH_SCHEMA_VERSION,
    catalogRevision: intent.catalogRevision,
    catalogDigest: intent.catalogDigest,
    catalogAdmissionGeneration: intent.catalogAdmissionGeneration,
    authorityGeneration: intent.authorityGeneration,
    jobId: intent.jobId,
    tenantId: intent.tenantId,
    targetKind: intent.targetKind,
    targetId: intent.targetId,
    timezone: intent.timezone,
    timezoneSource: intent.timezoneSource,
    targetSetDigest: intent.targetSetDigest,
    observedAt: intent.observedAt,
    cutDigest: intent.schedulerCutDigest,
    scheduleKey: intent.scheduleKey,
    localDate: intent.localDate,
    dueAt: intent.dueAt,
    caughtUp: intent.caughtUp,
    dstGapAdjusted: intent.dstGapAdjusted,
    commandDigest: intent.commandDigest,
    dispatchDigest: intent.dispatchDigest,
  });
}

function siteScheduledCommand<K extends SiteScheduledFeedingJobId>(
  jobId: K,
  envelope: FeedingScheduledDispatchEnvelopeV1,
): ScheduledSiteFeedingOperationCommand {
  if (envelope.jobId !== jobId || envelope.targetKind !== 'site') {
    throw new TypeError(`Persisted scheduled command is not ${jobId}/site`);
  }
  return Object.freeze({
    jobId,
    tenantId: envelope.tenantId,
    siteId: envelope.targetId,
    schedulerCut: Object.freeze({
      schemaVersion: 'feeding-scheduler-cut/v1',
      observedAt: canonicalInstant(envelope.observedAt, 'scheduled command observedAt'),
      catalogRevision: envelope.catalogRevision,
      catalogDigest: envelope.catalogDigest,
      catalogAdmissionGeneration: envelope.catalogAdmissionGeneration,
      authorityGeneration: envelope.authorityGeneration,
      timezoneSource: envelope.timezoneSource,
      timezone: envelope.timezone,
      targetSetDigest: envelope.targetSetDigest,
      cutDigest: envelope.cutDigest,
    }),
    occurrence: Object.freeze({
      scheduleKey: envelope.scheduleKey,
      dueAt: canonicalInstant(envelope.dueAt, 'scheduled command dueAt'),
      localDate: envelope.localDate,
      timezone: envelope.timezone,
      caughtUp: envelope.caughtUp,
      dstGapAdjusted: envelope.dstGapAdjusted,
    }),
    dispatchDigest: envelope.dispatchDigest,
  });
}

function tenantScheduledCommand<K extends TenantScheduledFeedingJobId>(
  jobId: K,
  envelope: FeedingScheduledDispatchEnvelopeV1,
): ScheduledTenantFeedingOperationCommand {
  if (envelope.jobId !== jobId || envelope.targetKind !== 'tenant') {
    throw new TypeError(`Persisted scheduled command is not ${jobId}/tenant`);
  }
  return Object.freeze({
    jobId,
    tenantId: envelope.tenantId,
    schedulerCut: Object.freeze({
      schemaVersion: 'feeding-scheduler-cut/v1',
      observedAt: canonicalInstant(envelope.observedAt, 'scheduled command observedAt'),
      catalogRevision: envelope.catalogRevision,
      catalogDigest: envelope.catalogDigest,
      catalogAdmissionGeneration: envelope.catalogAdmissionGeneration,
      authorityGeneration: envelope.authorityGeneration,
      timezoneSource: envelope.timezoneSource,
      timezone: envelope.timezone,
      targetSetDigest: envelope.targetSetDigest,
      cutDigest: envelope.cutDigest,
    }),
    occurrence: Object.freeze({
      scheduleKey: envelope.scheduleKey,
      dueAt: canonicalInstant(envelope.dueAt, 'scheduled command dueAt'),
      localDate: envelope.localDate,
      timezone: envelope.timezone,
      caughtUp: envelope.caughtUp,
      dstGapAdjusted: envelope.dstGapAdjusted,
    }),
    dispatchDigest: envelope.dispatchDigest,
  });
}

function siteScheduledCodec<K extends SiteScheduledFeedingJobId>(
  jobId: K,
): FeedingOperationCommandCodec {
  return Object.freeze({
    compile(command: FeedingOperationCommand): RuntimeFeedingOperationCommandArtifactV1 {
      if (!isScheduledCommand(command) || !('siteId' in command) || command.jobId !== jobId) {
        throw new TypeError(`Feeding command is not ${jobId}/site`);
      }
      const admitted = siteScheduledCommand(jobId, scheduledEnvelopeFromCommand(command));
      const payload = createCanonicalJsonDocumentV1({
        jobId,
        tenantId: admitted.tenantId,
        siteId: admitted.siteId,
      }).value;
      return Object.freeze({
        schemaVersion: 'feeding-operation-command-artifact/v1',
        payload,
        digest: feedingOperationCommandDigestV1(payload),
        command: admitted,
      });
    },
    decode(payload: CanonicalJsonValue, intent: FeedingOperationIntentV1): FeedingOperationCommand {
      const semantic = canonicalObject(
        payload,
        ['jobId', 'tenantId', 'siteId'],
        [],
        'scheduled command payload',
      );
      if (
        semantic.jobId !== jobId ||
        semantic.tenantId !== intent.tenantId ||
        semantic.siteId !== intent.siteId ||
        intent.jobId !== jobId
      ) {
        throw new TypeError('Scheduled command payload differs from its persisted intent');
      }
      return siteScheduledCommand(jobId, scheduledEnvelopeFromIntent(intent));
    },
  });
}

function tenantScheduledCodec<K extends TenantScheduledFeedingJobId>(
  jobId: K,
): FeedingOperationCommandCodec {
  return Object.freeze({
    compile(command: FeedingOperationCommand): RuntimeFeedingOperationCommandArtifactV1 {
      if (!isScheduledCommand(command) || 'siteId' in command || command.jobId !== jobId) {
        throw new TypeError(`Feeding command is not ${jobId}/tenant`);
      }
      const admitted = tenantScheduledCommand(jobId, scheduledEnvelopeFromCommand(command));
      const payload = createCanonicalJsonDocumentV1({ jobId, tenantId: admitted.tenantId }).value;
      return Object.freeze({
        schemaVersion: 'feeding-operation-command-artifact/v1',
        payload,
        digest: feedingOperationCommandDigestV1(payload),
        command: admitted,
      });
    },
    decode(payload: CanonicalJsonValue, intent: FeedingOperationIntentV1): FeedingOperationCommand {
      const semantic = canonicalObject(
        payload,
        ['jobId', 'tenantId'],
        [],
        'scheduled command payload',
      );
      if (
        semantic.jobId !== jobId ||
        semantic.tenantId !== intent.tenantId ||
        intent.jobId !== jobId
      ) {
        throw new TypeError('Scheduled command payload differs from its persisted intent');
      }
      return tenantScheduledCommand(jobId, scheduledEnvelopeFromIntent(intent));
    },
  });
}

const FEEDING_OPERATION_COMMAND_CODECS: FeedingOperationCommandCodecMap = Object.freeze({
  'v2.day-plan.generate': siteScheduledCodec('v2.day-plan.generate'),
  'v2.meal-window.sweep': siteScheduledCodec('v2.meal-window.sweep'),
  'v2.morning.sweep': siteScheduledCodec('v2.morning.sweep'),
  'v2.daily-summary.publish': siteScheduledCodec('v2.daily-summary.publish'),
  'v2.stock-coverage.refresh': tenantScheduledCodec('v2.stock-coverage.refresh'),
  'v2.fcr-alert.sweep': siteScheduledCodec('v2.fcr-alert.sweep'),
  'v2.retention.purge': tenantScheduledCodec('v2.retention.purge'),
  'v2.forecast.refresh': onDemandCodec<'v2.forecast.refresh'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'siteId', 'actorId', 'requestId', 'emitCoverageEvents'],
      [],
      'forecast refresh command',
    );
    if (value.jobId !== 'v2.forecast.refresh')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'v2.forecast.refresh',
      tenantId: uuid(value.tenantId, 'forecast refresh tenantId'),
      siteId: uuid(value.siteId, 'forecast refresh siteId'),
      actorId: boundedString(value.actorId, 'forecast refresh actorId', 160),
      requestId: boundedString(value.requestId, 'forecast refresh requestId', 200),
      emitCoverageEvents: booleanValue(
        value.emitCoverageEvents,
        'forecast refresh emitCoverageEvents',
      ),
    });
  }),
  'manual.day-plan.regenerate': onDemandCodec<'manual.day-plan.regenerate'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'unitId', 'actorId', 'requestId'],
      [],
      'day-plan regenerate command',
    );
    if (value.jobId !== 'manual.day-plan.regenerate')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.day-plan.regenerate',
      tenantId: uuid(value.tenantId, 'day-plan regenerate tenantId'),
      unitId: uuid(value.unitId, 'day-plan regenerate unitId'),
      actorId: boundedString(value.actorId, 'day-plan regenerate actorId', 160),
      requestId: boundedString(value.requestId, 'day-plan regenerate requestId', 200),
    });
  }),
  'manual.feed.transition': onDemandCodec<'manual.feed.transition'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'unitId', 'toFeedId', 'actorId', 'requestId'],
      [],
      'feed transition command',
    );
    if (value.jobId !== 'manual.feed.transition')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.feed.transition',
      tenantId: uuid(value.tenantId, 'feed transition tenantId'),
      unitId: uuid(value.unitId, 'feed transition unitId'),
      toFeedId: uuid(value.toFeedId, 'feed transition toFeedId'),
      actorId: boundedString(value.actorId, 'feed transition actorId', 160),
      requestId: boundedString(value.requestId, 'feed transition requestId', 200),
    });
  }),
  'manual.feeding.record': onDemandCodec<'manual.feeding.record'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'actorId', 'requestId', 'payload'],
      [],
      'manual feeding command',
    );
    if (value.jobId !== 'manual.feeding.record')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.feeding.record',
      tenantId: uuid(value.tenantId, 'manual feeding tenantId'),
      actorId: boundedString(value.actorId, 'manual feeding actorId', 160),
      requestId: boundedString(value.requestId, 'manual feeding requestId', 200),
      payload: decodeManualFeedingPayload(value.payload),
    });
  }),
  'manual.feeding.update': onDemandCodec<'manual.feeding.update'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'actorId', 'requestId', 'feedingRecordId', 'payload'],
      [],
      'feeding update command',
    );
    if (value.jobId !== 'manual.feeding.update')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.feeding.update',
      tenantId: uuid(value.tenantId, 'feeding update tenantId'),
      actorId: boundedString(value.actorId, 'feeding update actorId', 160),
      requestId: boundedString(value.requestId, 'feeding update requestId', 200),
      feedingRecordId: uuid(value.feedingRecordId, 'feeding update feedingRecordId'),
      payload: decodeUpdateFeedingPayload(value.payload),
    });
  }),
  'manual.meal.correct': onDemandCodec<'manual.meal.correct'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'actorId', 'requestId', 'caller', 'mealId', 'pourIndex', 'correctedKg'],
      [],
      'meal correction command',
    );
    if (value.jobId !== 'manual.meal.correct')
      throw new TypeError('Unexpected feeding command job');
    const identity = decodeMealCommandIdentity(value, 'meal correction');
    const pourIndex = finiteNumber(value.pourIndex, 'meal correction pourIndex');
    if (!Number.isSafeInteger(pourIndex) || pourIndex < 0)
      throw new TypeError('meal correction pourIndex must be a non-negative safe integer');
    return Object.freeze({
      jobId: 'manual.meal.correct',
      ...identity,
      pourIndex,
      correctedKg: decodeFeedingMealQuantityKgV1(value.correctedKg, 'meal correction correctedKg'),
    });
  }),
  'manual.meal.finalize': onDemandCodec<'manual.meal.finalize'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'actorId', 'requestId', 'caller', 'mealId'],
      [],
      'meal finalize command',
    );
    if (value.jobId !== 'manual.meal.finalize')
      throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.meal.finalize',
      ...decodeMealCommandIdentity(value, 'meal finalize'),
    });
  }),
  'manual.meal.skip': onDemandCodec<'manual.meal.skip'>((payload) => {
    const value = canonicalObject(
      payload,
      ['jobId', 'tenantId', 'actorId', 'requestId', 'caller', 'mealId', 'reason'],
      [],
      'meal skip command',
    );
    if (value.jobId !== 'manual.meal.skip') throw new TypeError('Unexpected feeding command job');
    return Object.freeze({
      jobId: 'manual.meal.skip',
      ...decodeMealCommandIdentity(value, 'meal skip'),
      reason: boundedString(value.reason, 'meal skip reason', 500),
    });
  }),
  'mobile.meal.record': onDemandCodec<'mobile.meal.record'>((payload) => {
    const value = canonicalObject(
      payload,
      [
        'jobId',
        'tenantId',
        'actorId',
        'requestId',
        'caller',
        'mealId',
        'pourKg',
        'finalize',
        'envelope',
      ],
      ['feedingMethod', 'notes'],
      'mobile meal command',
    );
    if (value.jobId !== 'mobile.meal.record') throw new TypeError('Unexpected feeding command job');
    const identity = decodeMealCommandIdentity(value, 'mobile meal');
    const pourKg = decodeFeedingMealQuantityKgV1(value.pourKg, 'mobile meal pourKg');
    const finalize = booleanValue(value.finalize, 'mobile meal finalize');
    const feedingMethod = optionalFeedingMethod(value.feedingMethod, 'mobile meal feedingMethod');
    const notes = optionalString(value.notes, 'mobile meal notes', 1_000);
    const envelope = decodeMobileEnvelope(
      value.envelope,
      feedingMealMobilePayloadSha256V1({
        mealId: identity.mealId,
        pourKg,
        finalize,
        ...(feedingMethod === undefined ? {} : { feedingMethod }),
        ...(notes === undefined ? {} : { notes }),
      }),
    );
    if (identity.requestId !== envelope.clientCommandId)
      throw new TypeError('mobile meal requestId differs from its envelope identity');
    return Object.freeze({
      jobId: 'mobile.meal.record',
      ...identity,
      pourKg,
      finalize,
      ...(feedingMethod === undefined ? {} : { feedingMethod }),
      ...(notes === undefined ? {} : { notes }),
      envelope,
    });
  }),
});

function isScheduledCommand(
  command: FeedingOperationCommand,
): command is ScheduledSiteFeedingOperationCommand | ScheduledTenantFeedingOperationCommand {
  return 'schedulerCut' in command;
}

function commandCodec(jobId: FeedingJobId): FeedingOperationCommandCodec {
  return FEEDING_OPERATION_COMMAND_CODECS[jobId];
}

/** Snapshots and validates a caller command before the first asynchronous boundary. */
export function compileFeedingOperationCommandArtifactV1<K extends FeedingJobId>(
  command: FeedingOperationCommandFor<K>,
): FeedingOperationCommandArtifactV1<K>;
export function compileFeedingOperationCommandArtifactV1(
  command: FeedingOperationCommand,
): RuntimeFeedingOperationCommandArtifactV1 {
  return commandCodec(command.jobId).compile(command);
}

/** Reconstructs the only executable command from the database-returned intent artifact. */
export function decodeFeedingOperationCommandFromIntentV1<K extends FeedingJobId>(
  expectedJobId: K,
  intent: FeedingOperationIntentV1,
): FeedingOperationCommandFor<K>;
export function decodeFeedingOperationCommandFromIntentV1(
  expectedJobId: FeedingJobId,
  intent: FeedingOperationIntentV1,
): FeedingOperationCommand {
  if (intent.jobId !== expectedJobId) {
    throw new TypeError(`Persisted feeding intent job ${intent.jobId} is not ${expectedJobId}`);
  }
  return commandCodec(expectedJobId).decode(intent.commandPayload, intent);
}
