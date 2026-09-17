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

/**
 * MSGFIX-FAZ2 2.3: trust-boundary schema for the caller-capabilities query
 * (request.auth.user.resolveCallerCapabilities). Same posture as the
 * membership queries — additionalProperties:false on both sides; the Result
 * whitelists ONLY role codes + resource permission codes (no PII), and the
 * Query stops extra keys at the trust boundary.
 */
const RESOLVE_CALLER_CAPABILITIES_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tenantId', 'userId'],
  properties: {
    tenantId: UUID_SCHEMA,
    userId: UUID_SCHEMA,
    correlationId: UUID_SCHEMA,
  },
} as const;

const RESOLVE_CALLER_CAPABILITIES_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'found', 'active', 'roles', 'resourcePermissions'],
  properties: {
    success: { type: 'boolean' },
    found: { type: 'boolean' },
    active: { type: 'boolean' },
    roles: {
      type: 'array',
      items: { type: 'string', maxLength: 64 },
    },
    resourcePermissions: {
      type: 'array',
      items: { type: 'string', maxLength: 128 },
    },
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

export const validateResolveCallerCapabilitiesQuerySchema: ValidateFunction = ajv.compile(
  RESOLVE_CALLER_CAPABILITIES_QUERY_SCHEMA,
);

export const validateResolveCallerCapabilitiesResultSchema: ValidateFunction = ajv.compile(
  RESOLVE_CALLER_CAPABILITIES_RESULT_SCHEMA,
);
