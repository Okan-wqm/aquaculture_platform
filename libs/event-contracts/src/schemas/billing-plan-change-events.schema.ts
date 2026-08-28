import { BillingPlanTier } from '../billing/billing-plan-tier';
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  MAX_FREE_TEXT_LENGTH,
  UUID_SCHEMA,
} from './common.schema';

export type BillingPlanChangeEventType =
  | 'SubscriptionPlanChangeScheduled'
  | 'SubscriptionPlanChangeReconciliationRequired';

const PLAN_TIER = {
  type: 'string',
  enum: Object.values(BillingPlanTier),
} as const;

const PLAN_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_FREE_TEXT_LENGTH,
} as const;

const ISO_DATE_TIME = {
  type: 'string',
  format: 'date-time',
} as const;

function billingPlanChangeEventSchema(
  eventType: BillingPlanChangeEventType,
  properties: Record<string, unknown>,
  requiredPayload: readonly string[],
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { const: eventType },
      ...properties,
    },
    required: Array.from(new Set([...BASE_EVENT_REQUIRED, ...requiredPayload])),
  };
}

const REASON_CODE = {
  // Mirrors the saga's lastAttemptErrorCode column (varchar(64)) — an open,
  // length-bounded string. The closed vocabulary lands with the saga service
  // that produces these codes, never ahead of it.
  type: 'string',
  minLength: 1,
  maxLength: 64,
} as const;

export const BILLING_PLAN_CHANGE_EVENT_SCHEMAS = {
  SubscriptionPlanChangeScheduled: billingPlanChangeEventSchema(
    'SubscriptionPlanChangeScheduled',
    {
      operationId: UUID_SCHEMA,
      subscriptionId: UUID_SCHEMA,
      previousTier: PLAN_TIER,
      newTier: PLAN_TIER,
      previousPlanName: PLAN_NAME,
      newPlanName: PLAN_NAME,
      newPlanId: UUID_SCHEMA,
      applyAfter: ISO_DATE_TIME,
    },
    [
      'operationId',
      'subscriptionId',
      'previousTier',
      'newTier',
      'previousPlanName',
      'newPlanName',
      'newPlanId',
      'applyAfter',
    ],
  ),
  SubscriptionPlanChangeReconciliationRequired: billingPlanChangeEventSchema(
    'SubscriptionPlanChangeReconciliationRequired',
    {
      operationId: UUID_SCHEMA,
      subscriptionId: UUID_SCHEMA,
      reasonCode: REASON_CODE,
      detectedAt: ISO_DATE_TIME,
    },
    ['operationId', 'subscriptionId', 'reasonCode', 'detectedAt'],
  ),
} as const;
