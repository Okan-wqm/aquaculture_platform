import { Role } from '@aquaculture/backend-common/decorators';
import {
  FEEDING_JOB_CATALOG,
  FEEDING_JOB_CATALOG_DIGEST,
  FEEDING_JOB_CATALOG_REVISION,
  FEEDING_MEAL_MOBILE_COMMAND_V1,
  FEEDING_MEAL_QUANTITY_POLICY_V1,
  compileFeedingOperationLockSetDigestV1,
  compileFeedingTimezone,
  decodeFeedingOperationIntentV1,
  feedingDueOccurrences,
  feedingMealMobilePayloadSha256V1,
  feedingOperationCommandDigestV1,
  feedingJobDefinition,
} from '@aquaculture/feeding-contracts';
import { createWireJsonDocumentV1 } from '@aquaculture/shared-contracts';

import type { RecordMealOperationCommand } from '../feeding-operation-command';
import {
  compileFeedingOperationCommandArtifactV1,
  decodeFeedingOperationCommandFromIntentV1,
} from '../feeding-operation-command.codec';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const UNIT_ID = '33333333-3333-4333-8333-333333333333';
const MEAL_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const CLIENT_COMMAND_ID = '66666666-6666-4666-8666-666666666666';
const ACTOR_ID = 'operator-1';

function mobileCommand(
  overrides: Partial<RecordMealOperationCommand> = {},
): RecordMealOperationCommand {
  const payload = {
    mealId: MEAL_ID,
    pourKg: 2.5,
    finalize: false,
    feedingMethod: 'manual' as const,
    notes: 'observed',
  };
  return {
    jobId: 'mobile.meal.record',
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    requestId: CLIENT_COMMAND_ID,
    caller: { sub: ACTOR_ID, roles: [Role.MODULE_USER], assignedSiteIds: [SITE_ID] },
    ...payload,
    envelope: {
      clientCommandId: CLIENT_COMMAND_ID,
      clientCreatedAt: '2026-08-05T04:00:20.000Z',
      deviceId: '77777777-7777-4777-8777-777777777777',
      operationType: FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
      schemaVersion: FEEDING_MEAL_MOBILE_COMMAND_V1.schemaVersion,
      payloadHash: feedingMealMobilePayloadSha256V1(payload),
    },
    ...overrides,
  };
}

function mobileIntent(commandPayload: RecordMealOperationCommand) {
  const observedAt = new Date('2026-08-05T04:00:30.000Z');
  const occurrence = feedingDueOccurrences(
    feedingJobDefinition('mobile.meal.record'),
    observedAt,
    compileFeedingTimezone('UTC'),
    CLIENT_COMMAND_ID,
  )[0];
  if (!occurrence) throw new Error('mobile command fixture has no canonical occurrence');
  const payload = compileFeedingOperationCommandArtifactV1(commandPayload).payload;
  return decodeFeedingOperationIntentV1({
    schemaVersion: 'feeding-operation-intent/v1',
    operationId: OPERATION_ID,
    generation: 1,
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    requestId: CLIENT_COMMAND_ID,
    jobId: 'mobile.meal.record',
    targetKind: 'unit',
    targetId: UNIT_ID,
    siteId: SITE_ID,
    unitId: UNIT_ID,
    reason: 'device_request',
    catalogRevision: FEEDING_JOB_CATALOG_REVISION,
    catalogDigest: FEEDING_JOB_CATALOG_DIGEST,
    catalogJobCount: FEEDING_JOB_CATALOG.length,
    commandDigest: feedingOperationCommandDigestV1(payload),
    commandPayload: payload,
    lockSetDigest: compileFeedingOperationLockSetDigestV1({
      tenantId: TENANT_ID,
      jobId: 'mobile.meal.record',
      targetKind: 'unit',
      targetId: UNIT_ID,
      localDate: occurrence.localDate,
    }),
    observedAt: observedAt.toISOString(),
    dueAt: occurrence.dueAt.toISOString(),
    scheduleKey: occurrence.scheduleKey,
    localDate: occurrence.localDate,
    timezone: occurrence.timezone,
    caughtUp: occurrence.caughtUp,
    dstGapAdjusted: occurrence.dstGapAdjusted,
    timezoneSource: 'tenant_site_catalog',
    catalogAdmissionGeneration: null,
    authorityGeneration: null,
    targetSetDigest: null,
    schedulerCutDigest: null,
    dispatchDigest: null,
  });
}

describe('feeding operation command codec authority', () => {
  it('requires every meal actor identity to equal the authenticated caller', () => {
    expect(() =>
      compileFeedingOperationCommandArtifactV1({
        jobId: 'manual.meal.finalize',
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        requestId: 'finalize-1',
        caller: { sub: 'different-operator', roles: [Role.MODULE_USER] },
        mealId: MEAL_ID,
      }),
    ).toThrow(/actorId differs from its authenticated caller/);
  });

  it('rejects a changed mobile payload under the same client command identity', () => {
    const original = mobileCommand();

    expect(() =>
      compileFeedingOperationCommandArtifactV1({ ...original, pourKg: original.pourKg + 1 }),
    ).toThrow(/payloadHash differs from its command payload/);
  });

  it('recomputes optional-field normalization and exact mobile envelope coordinates', () => {
    const payload = { mealId: MEAL_ID, pourKg: 1, finalize: true };
    const admitted = compileFeedingOperationCommandArtifactV1(
      mobileCommand({
        ...payload,
        feedingMethod: undefined,
        notes: undefined,
        envelope: {
          clientCommandId: CLIENT_COMMAND_ID,
          operationType: FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
          schemaVersion: FEEDING_MEAL_MOBILE_COMMAND_V1.schemaVersion,
          payloadHash: feedingMealMobilePayloadSha256V1(payload),
        },
      }),
    );

    expect(admitted.command).toMatchObject(payload);
    expect(admitted.command).not.toHaveProperty('feedingMethod');
    expect(admitted.command).not.toHaveProperty('notes');
    expect(() =>
      compileFeedingOperationCommandArtifactV1(
        mobileCommand({
          envelope: {
            ...mobileCommand().envelope,
            operationType: 'recordMortality',
          },
        }),
      ),
    ).toThrow(/operationType/);
    expect(() =>
      compileFeedingOperationCommandArtifactV1(
        mobileCommand({
          envelope: {
            ...mobileCommand().envelope,
            schemaVersion: 'mobile-command-v2',
          },
        }),
      ),
    ).toThrow(/schemaVersion/);
  });

  it.each([
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg - FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg / 2,
    FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    1 + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg / 10,
  ])('rejects mobile quantities outside the versioned storage contract: %s', (pourKg) => {
    expect(() => compileFeedingOperationCommandArtifactV1(mobileCommand({ pourKg }))).toThrow(
      /must be between/,
    );
  });

  it.each([
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg - FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg / 2,
    FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    1 + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg / 10,
  ])('rejects correction quantities outside the versioned storage contract: %s', (correctedKg) => {
    expect(() =>
      compileFeedingOperationCommandArtifactV1({
        jobId: 'manual.meal.correct',
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        requestId: 'correction-1',
        caller: { sub: ACTOR_ID, roles: [Role.MODULE_MANAGER] },
        mealId: MEAL_ID,
        pourIndex: 0,
        correctedKg,
      }),
    ).toThrow(/must be between/);
  });

  it('rejects a re-hashed persisted snapshot whose envelope still attests different bytes', () => {
    const original = mobileCommand();
    const persisted = mobileIntent(original);
    const tamperedPayload = createWireJsonDocumentV1({
      ...original,
      pourKg: original.pourKg + 4,
    }).value;
    const tamperedIntent = {
      ...persisted,
      commandPayload: tamperedPayload,
      commandDigest: feedingOperationCommandDigestV1(tamperedPayload),
    };

    expect(() =>
      decodeFeedingOperationCommandFromIntentV1(
        'mobile.meal.record',
        decodeFeedingOperationIntentV1(tamperedIntent),
      ),
    ).toThrow(/payloadHash differs from its command payload/);
  });
});
