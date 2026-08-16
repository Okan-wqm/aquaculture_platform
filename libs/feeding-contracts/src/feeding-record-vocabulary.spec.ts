import {
  MOBILE_COMMAND_ENVELOPE_CONTRACT_V1,
  mobileCommandPayloadSha256V1,
} from '@aquaculture/shared-contracts';

import {
  FEEDING_MEAL_MOBILE_COMMAND_V1,
  FEEDING_MEAL_QUANTITY_POLICY_V1,
  compileFeedingMealMobilePayloadV1,
  decodeFeedingMealQuantityKgV1,
  decodeFeedingRecordTime,
  decodeOptionalFeedingCurrency,
  feedingMealMobilePayloadSha256V1,
} from './feeding-record-vocabulary';
import { FEEDING_MUTATION_AUTHORITY_CATALOG_V1 } from './feeding-mutation-catalog';

describe('feeding record vocabulary authorities', () => {
  it('derives the feeding operation schema from the cross-stack envelope authority', () => {
    expect(FEEDING_MEAL_MOBILE_COMMAND_V1.schemaVersion).toBe(
      MOBILE_COMMAND_ENVELOPE_CONTRACT_V1.schemaVersion,
    );
  });

  it('publishes one immutable versioned meal quantity policy derived from storage scale', () => {
    expect(Object.isFrozen(FEEDING_MEAL_QUANTITY_POLICY_V1)).toBe(true);
    expect(FEEDING_MEAL_QUANTITY_POLICY_V1).toMatchObject({
      schemaVersion: 'feeding-meal-quantity-policy/v1',
      unit: 'kg',
      minimumKg: FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
      storageScale: FEEDING_MEAL_QUANTITY_POLICY_V1.decimalPlaces,
    });
    expect(FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg).toBe(
      10 ** -FEEDING_MEAL_QUANTITY_POLICY_V1.storageScale,
    );
  });

  it.each([
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg,
    12.345,
    FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg,
  ])('admits a storage-exact meal quantity: %s', (value) => {
    expect(decodeFeedingMealQuantityKgV1(value)).toBe(value);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    FEEDING_MEAL_QUANTITY_POLICY_V1.minimumKg - FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    FEEDING_MEAL_QUANTITY_POLICY_V1.maximumKg + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg,
    1 + FEEDING_MEAL_QUANTITY_POLICY_V1.inputStepKg / 10,
  ])('rejects an unpersistable meal quantity without rounding: %s', (value) => {
    expect(() => decodeFeedingMealQuantityKgV1(value)).toThrow(/in .* kilogram increments/);
  });

  it('projects the mobile identity to exactly one backend mutation authority', () => {
    const matchingAuthorities = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
      (authority) =>
        authority.ingress.kind === 'graphql_mutation' &&
        authority.ingress.method === FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
    );

    expect(matchingAuthorities).toHaveLength(1);
    expect(matchingAuthorities[0]).toMatchObject({
      runtimeServiceId: 'farm-service',
      operationJobIds: ['mobile.meal.record'],
      ingress: {
        kind: 'graphql_mutation',
        provider: 'MealExecutionResolver',
        method: FEEDING_MEAL_MOBILE_COMMAND_V1.operationType,
      },
    });
  });

  it('projects the domain feeding method back to the exact client wire payload', () => {
    const payload = {
      mealId: '11111111-1111-4111-8111-111111111111',
      pourKg: 12.5,
      finalize: true,
      feedingMethod: 'manual' as const,
      notes: 'observed',
    };

    expect(compileFeedingMealMobilePayloadV1(payload)).toEqual({
      mealId: payload.mealId,
      pourKg: 12.5,
      finalize: true,
      feedingMethod: 'MANUAL',
      notes: 'observed',
    });
    expect(feedingMealMobilePayloadSha256V1(payload)).toBe(
      mobileCommandPayloadSha256V1({
        mealId: payload.mealId,
        pourKg: 12.5,
        finalize: true,
        feedingMethod: 'MANUAL',
        notes: 'observed',
      }),
    );
  });

  it('normalizes omitted optional mobile fields before hashing', () => {
    const base = {
      mealId: '11111111-1111-4111-8111-111111111111',
      pourKg: 1,
      finalize: false,
    };

    expect(feedingMealMobilePayloadSha256V1({ ...base, feedingMethod: undefined })).toBe(
      feedingMealMobilePayloadSha256V1(base),
    );
    expect(compileFeedingMealMobilePayloadV1({ ...base, notes: undefined })).toEqual(base);
  });

  it.each(['00:00', '23:59', '12:34:56'])('admits canonical civil feeding time %s', (value) => {
    expect(decodeFeedingRecordTime(value)).toBe(value);
  });

  it.each(['24:00', '12:60', '12:34:60', '1:00', '12:34:56.000'])(
    'rejects non-civil feeding time %s',
    (value) => {
      expect(() => decodeFeedingRecordTime(value)).toThrow(/feedingTime/);
    },
  );

  it('admits only optional uppercase three-letter currency codes', () => {
    expect(decodeOptionalFeedingCurrency(undefined)).toBeUndefined();
    expect(decodeOptionalFeedingCurrency('NOK')).toBe('NOK');
    expect(() => decodeOptionalFeedingCurrency('nok')).toThrow(/currency/);
    expect(() => decodeOptionalFeedingCurrency('EURO')).toThrow(/currency/);
  });
});
