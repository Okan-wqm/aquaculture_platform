import Ajv, { type ValidateFunction } from 'ajv';

import { VALIDATE_TENANT_MEMBERSHIP_MAX_USER_IDS } from '../auth-user-queries';

import { UUID_SCHEMA } from './common.schema';

/**
 * Trust-boundary schemas for the auth-user membership query
 * (request/reply — these are NOT BaseEvent envelopes, so they live
 * beside, not inside, the event-type-keyed validator map).
 *
 * `additionalProperties: false` on BOTH sides is load-bearing
 * (security review condition 3): the Result shape is the lock that
 * keeps PII fields from ever being added to this surface, and the
 * Query shape stops a compromised peer from smuggling extra keys past
 * the handler.
 */

const VALIDATE_TENANT_MEMBERSHIP_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'userIds'],
  properties: {
    tenantId: UUID_SCHEMA,
    userIds: {
      type: 'array',
      items: UUID_SCHEMA,
      maxItems: VALIDATE_TENANT_MEMBERSHIP_MAX_USER_IDS,
    },
    requireActive: { type: 'boolean' },
    correlationId: UUID_SCHEMA,
  },
} as const;

const VALIDATE_TENANT_MEMBERSHIP_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'allValid', 'validUserIds', 'invalidUserIds', 'inactiveUserIds'],
  properties: {
    success: { type: 'boolean' },
    allValid: { type: 'boolean' },
    validUserIds: { type: 'array', items: UUID_SCHEMA },
    invalidUserIds: { type: 'array', items: UUID_SCHEMA },
    inactiveUserIds: { type: 'array', items: UUID_SCHEMA },
    errorCode: { type: 'string', enum: ['VALIDATION_ERROR', 'INTERNAL_ERROR'] },
    error: { type: 'string', maxLength: 500 },
  },
} as const;

// Compile once at module load (same amortisation rationale as
// validator.ts — the admission path runs on every channel mutation).
const ajv = new Ajv({ strict: false, allErrors: true });

export const validateTenantMembershipQuerySchema: ValidateFunction = ajv.compile(
  VALIDATE_TENANT_MEMBERSHIP_QUERY_SCHEMA,
);

export const validateTenantMembershipResultSchema: ValidateFunction = ajv.compile(
  VALIDATE_TENANT_MEMBERSHIP_RESULT_SCHEMA,
);
