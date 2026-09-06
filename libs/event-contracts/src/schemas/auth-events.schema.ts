/**
 * @module AuthEventSchemas
 *
 * AJV JSON-Schema definitions for the auth-domain events crossing the NATS
 * trust boundary (DATA-MEDIUM-001). These complete the tenant-event validators
 * (tenant-events.schema.ts) so every durable auth/tenant event the outbox
 * publishes and downstream services consume (notification, ai, messaging,
 * billing) is validated before it is acted on.
 *
 * Covers the canonical `AuthEvent` union (UserLoggedIn, InvitationAccepted,
 * PasswordReset{Requested,Completed}, UserDeleted, UserDataAnonymized,
 * GdprAnonymizeRequested, Consent{Recorded,Withdrawn}) plus the auth-published
 * UserInvited delivery event. Same posture as the farm/messaging/sensor schemas:
 * BaseEvent fields + per-event payload, additionalProperties:false. Enum-valued
 * fields (initiatedBy, method, credentialType) validate against their exact
 * literal set; opaque token/key references validate as bounded strings (they may
 * be a UUID or a SHA-256 hash, never raw PII).
 *
 * Tenancy (SEC-HIGH-159): events about a principal whose tenantId is nullable
 * (super admins live in auth.users with tenantId NULL) are PLATFORM-CAPABLE and
 * admit the reserved platform segment on `tenantId` via
 * TENANT_OR_PLATFORM_TENANT_ID_SCHEMA. UserInvited is structurally tenant-bound
 * (an invitation always targets a tenant) and keeps the UUID-only base shape.
 *
 * @see libs/event-contracts/src/schemas/tenant-events.schema.ts
 * @see libs/event-contracts/src/schemas/validator.ts
 */
import {
  ACCESS_TOKEN_INVALIDATION_REASONS,
  USER_ACCESS_TOKEN_INVALIDATION_REASONS,
} from '../auth-events';
import { TENANT_OR_PLATFORM_TENANT_ID_SCHEMA } from '../tenant-scope';
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  MAX_FREE_TEXT_LENGTH,
  MAX_SHORT_CODE_LENGTH,
  UUID_SCHEMA,
} from './common.schema';

export type AuthEventType =
  | 'UserLoggedIn'
  | 'UserAccountLocked'
  | 'InvitationAccepted'
  | 'PasswordResetRequested'
  | 'PasswordResetCompleted'
  | 'UserAccessTokenInvalidationRequested'
  | 'AccessTokenInvalidationRequested'
  | 'UserDeleted'
  | 'UserDataAnonymized'
  | 'GdprAnonymizeRequested'
  | 'ConsentRecorded'
  | 'ConsentWithdrawn'
  | 'UserInvited';

const STRING = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SHORT_CODE_LENGTH,
} as const;

const LONG_STRING = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_FREE_TEXT_LENGTH,
} as const;

const ISO_DATE_TIME = {
  type: 'string',
  format: 'date-time',
} as const;

// Opaque token / key reference: a UUID or a SHA-256 hex digest, never raw PII.
const OPAQUE_REF = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
} as const;

const BOOLEAN = { type: 'boolean' } as const;
const MAX_DATE_EPOCH_SECONDS = 8_640_000_000_000;

const INITIATED_BY = {
  type: 'string',
  enum: ['user', 'admin', 'gdpr-erasure'],
} as const;

function authEventSchema(
  eventType: AuthEventType,
  properties: Record<string, unknown>,
  requiredPayload: readonly string[] = [],
): Record<string, unknown> {
  const required = Array.from(new Set([...BASE_EVENT_REQUIRED, ...requiredPayload]));
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { const: eventType },
      ...properties,
    },
    required,
  } as const;
}

export const AUTH_EVENT_SCHEMAS = {
  UserLoggedIn: authEventSchema(
    'UserLoggedIn',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      userId: UUID_SCHEMA,
      ipAddress: STRING,
      userAgent: LONG_STRING,
    },
    ['userId'],
  ),
  UserAccountLocked: authEventSchema(
    'UserAccountLocked',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      userId: UUID_SCHEMA,
      failedAttempts: { type: 'integer', minimum: 1, maximum: 1000 },
      lockedUntil: ISO_DATE_TIME,
    },
    ['userId', 'failedAttempts', 'lockedUntil'],
  ),
  InvitationAccepted: authEventSchema(
    'InvitationAccepted',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      userId: UUID_SCHEMA,
      invitationId: UUID_SCHEMA,
      email: LONG_STRING,
    },
    ['userId'],
  ),
  PasswordResetRequested: authEventSchema(
    'PasswordResetRequested',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      userId: UUID_SCHEMA,
      actionTokenId: OPAQUE_REF,
      cryptoShredKeyId: OPAQUE_REF,
    },
    ['userId', 'actionTokenId', 'cryptoShredKeyId'],
  ),
  PasswordResetCompleted: authEventSchema(
    'PasswordResetCompleted',
    { tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA, userId: UUID_SCHEMA },
    ['userId'],
  ),
  UserAccessTokenInvalidationRequested: authEventSchema(
    'UserAccessTokenInvalidationRequested',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      targetUserId: UUID_SCHEMA,
      invalidatedAtEpochSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DATE_EPOCH_SECONDS,
      },
      reason: { type: 'string', enum: USER_ACCESS_TOKEN_INVALIDATION_REASONS },
    },
    ['targetUserId', 'invalidatedAtEpochSeconds', 'reason'],
  ),
  AccessTokenInvalidationRequested: authEventSchema(
    'AccessTokenInvalidationRequested',
    {
      tenantId: TENANT_OR_PLATFORM_TENANT_ID_SCHEMA,
      targetJti: UUID_SCHEMA,
      expiresAtEpochSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_DATE_EPOCH_SECONDS,
      },
      reason: { type: 'string', enum: ACCESS_TOKEN_INVALIDATION_REASONS },
    },
    ['targetJti', 'expiresAtEpochSeconds', 'reason'],
  ),
  UserDeleted: authEventSchema(
    'UserDeleted',
    {
      deletedUserId: UUID_SCHEMA,
      hardDelete: BOOLEAN,
      cascadeRequested: BOOLEAN,
      initiatedBy: INITIATED_BY,
      cryptoShredKeyId: OPAQUE_REF,
    },
    ['deletedUserId', 'hardDelete', 'cascadeRequested', 'initiatedBy', 'cryptoShredKeyId'],
  ),
  UserDataAnonymized: authEventSchema(
    'UserDataAnonymized',
    {
      userId: UUID_SCHEMA,
      method: { type: 'string', enum: ['pii-fields-nulled', 'crypto-shredded'] },
      initiatedBy: INITIATED_BY,
      cryptoShredKeyId: OPAQUE_REF,
    },
    ['userId', 'method', 'initiatedBy'],
  ),
  GdprAnonymizeRequested: authEventSchema(
    'GdprAnonymizeRequested',
    {
      userId: UUID_SCHEMA,
      requestId: UUID_SCHEMA,
      fulfilByIso: ISO_DATE_TIME,
      reason: LONG_STRING,
    },
    ['userId', 'requestId', 'fulfilByIso'],
  ),
  ConsentRecorded: authEventSchema(
    'ConsentRecorded',
    {
      userId: UUID_SCHEMA,
      consentType: STRING,
      consentVersion: STRING,
      legalBasis: STRING,
    },
    ['userId', 'consentType', 'consentVersion', 'legalBasis'],
  ),
  ConsentWithdrawn: authEventSchema(
    'ConsentWithdrawn',
    { userId: UUID_SCHEMA, consentType: STRING, reason: LONG_STRING },
    ['userId', 'consentType'],
  ),
  UserInvited: authEventSchema(
    'UserInvited',
    {
      userId: UUID_SCHEMA,
      role: STRING,
      invitedBy: UUID_SCHEMA,
      credentialType: { type: 'string', enum: ['temporary_password', 'reset_token'] },
      actionTokenId: OPAQUE_REF,
      cryptoShredKeyId: OPAQUE_REF,
    },
    ['userId', 'role', 'credentialType', 'actionTokenId', 'cryptoShredKeyId'],
  ),
} as const satisfies Record<AuthEventType, Record<string, unknown>>;
