/**
 * @module TenantEventSchemas
 *
 * AJV JSON-Schema definitions for the tenant lifecycle / provisioning events
 * (MEDIUM-007 / DATA-MEDIUM-001). These are the durable, cross-service events the
 * outbox publishes and that messaging / billing / farm / sensor consumers read;
 * before this, no trust-boundary validator rejected a malformed tenant event.
 *
 * Mirrors the farm/messaging/sensor schema pattern: each event is `BaseEvent`
 * fields + a per-event payload, `additionalProperties: false` (closes the
 * unknown-field footgun), with required = base-required ∪ the event's
 * non-optional payload fields. Status/plan/tier/cycle fields are validated as
 * bounded strings (the canonical TenantStatusMachine governs transition legality
 * separately); `Date`-typed contract fields (effectiveDate) validate as the ISO
 * string they become on the JSONB/NATS wire.
 *
 * @see libs/event-contracts/src/schemas/messaging-events.schema.ts
 * @see libs/event-contracts/src/schemas/validator.ts
 */
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  MAX_FREE_TEXT_LENGTH,
  MAX_SHORT_CODE_LENGTH,
  UUID_SCHEMA,
} from './common.schema';
import { TENANT_ERASURE_TARGET_SERVICES } from '../tenant-erasure-targets';

export type TenantEventType =
  | 'TenantCreated'
  | 'TenantProvisioningRequested'
  | 'TenantProvisioned'
  | 'TenantUpdated'
  | 'TenantStatusChanged'
  | 'TenantSuspended'
  | 'TenantActivated'
  | 'TenantArchived'
  | 'TenantErasureRequested'
  | 'TenantDataErased'
  | 'TenantDataErasureFailed'
  | 'TenantErasureBlocked'
  | 'TenantErased'
  | 'TenantProvisioningFailed'
  | 'TenantSubscriptionChanged'
  | 'TenantModulesAssigned';

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

// DATA-LOW-001: subscription projection dates serialize to an ISO string OR
// null (a tenant with no trial / no fixed end date), so the schema admits both.
const NULLABLE_ISO_DATE_TIME = {
  type: ['string', 'null'],
  format: 'date-time',
} as const;

const UUID_ARRAY = {
  type: 'array',
  items: UUID_SCHEMA,
  maxItems: 1000,
} as const;

const SHORT_CODE_ARRAY = {
  type: 'array',
  items: STRING,
  maxItems: 1000,
} as const;

const NON_NEGATIVE_INT = {
  type: 'integer',
  minimum: 0,
} as const;

const BOOLEAN = {
  type: 'boolean',
} as const;

const TENANT_ERASURE_TARGET_SERVICE = {
  type: 'string',
  enum: [...TENANT_ERASURE_TARGET_SERVICES],
} as const;

const TENANT_ERASURE_BLOCK_SOURCE = {
  type: 'string',
  enum: [...TENANT_ERASURE_TARGET_SERVICES, 'platform-orchestrator'],
} as const;

function tenantEventSchema(
  eventType: TenantEventType,
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

export const TENANT_EVENT_SCHEMAS = {
  TenantCreated: tenantEventSchema(
    'TenantCreated',
    { name: LONG_STRING, slug: STRING, plan: STRING, status: STRING },
    ['name', 'slug'],
  ),
  TenantProvisioningRequested: tenantEventSchema(
    'TenantProvisioningRequested',
    { operationId: UUID_SCHEMA, name: LONG_STRING, slug: STRING, moduleIds: UUID_ARRAY },
    ['operationId', 'name', 'slug', 'moduleIds'],
  ),
  TenantProvisioned: tenantEventSchema(
    'TenantProvisioned',
    { operationId: UUID_SCHEMA, name: LONG_STRING, slug: STRING },
    ['operationId', 'name', 'slug'],
  ),
  TenantUpdated: tenantEventSchema('TenantUpdated', {
    name: LONG_STRING,
    plan: STRING,
    status: STRING,
    maxUsers: NON_NEGATIVE_INT,
    // W5: tenant lokalizasyonu — yalnız lokalizasyon değişiminde dolu.
    timezone: STRING,
    locale: STRING,
  }),
  TenantStatusChanged: tenantEventSchema(
    'TenantStatusChanged',
    { previousStatus: STRING, newStatus: STRING, reason: LONG_STRING },
    ['previousStatus', 'newStatus'],
  ),
  TenantSuspended: tenantEventSchema('TenantSuspended', {
    reason: LONG_STRING,
    suspendedBy: UUID_SCHEMA,
  }),
  TenantActivated: tenantEventSchema('TenantActivated', { activatedBy: UUID_SCHEMA }),
  TenantArchived: tenantEventSchema('TenantArchived', { archivedBy: UUID_SCHEMA }),
  TenantErasureRequested: tenantEventSchema(
    'TenantErasureRequested',
    {
      operationId: UUID_SCHEMA,
      requestedBy: UUID_SCHEMA,
      requestedAt: ISO_DATE_TIME,
      legalHoldCheckedAt: ISO_DATE_TIME,
      dryRun: BOOLEAN,
      targetServiceCount: NON_NEGATIVE_INT,
    },
    [
      'operationId',
      'requestedBy',
      'requestedAt',
      'legalHoldCheckedAt',
      'dryRun',
      'targetServiceCount',
    ],
  ),
  TenantDataErased: tenantEventSchema(
    'TenantDataErased',
    {
      operationId: UUID_SCHEMA,
      targetService: TENANT_ERASURE_TARGET_SERVICE,
      erasedAt: ISO_DATE_TIME,
      dryRun: BOOLEAN,
      matchedRecordCount: NON_NEGATIVE_INT,
      erasedRecordCount: NON_NEGATIVE_INT,
      proofHash: STRING,
    },
    [
      'operationId',
      'targetService',
      'erasedAt',
      'dryRun',
      'matchedRecordCount',
      'erasedRecordCount',
      'proofHash',
    ],
  ),
  TenantDataErasureFailed: tenantEventSchema(
    'TenantDataErasureFailed',
    {
      operationId: UUID_SCHEMA,
      targetService: TENANT_ERASURE_TARGET_SERVICE,
      failedAt: ISO_DATE_TIME,
      errorCode: STRING,
      errorMessage: LONG_STRING,
      retryable: BOOLEAN,
    },
    ['operationId', 'targetService', 'failedAt', 'errorCode', 'errorMessage', 'retryable'],
  ),
  TenantErasureBlocked: tenantEventSchema(
    'TenantErasureBlocked',
    {
      operationId: UUID_SCHEMA,
      blockedAt: ISO_DATE_TIME,
      blockedByService: TENANT_ERASURE_BLOCK_SOURCE,
      reason: LONG_STRING,
      legalMatterId: STRING,
    },
    ['operationId', 'blockedAt', 'blockedByService', 'reason'],
  ),
  TenantErased: tenantEventSchema(
    'TenantErased',
    {
      operationId: UUID_SCHEMA,
      requestedAt: ISO_DATE_TIME,
      requestedBy: UUID_SCHEMA,
      legalHoldCheckedAt: ISO_DATE_TIME,
      completedAt: ISO_DATE_TIME,
      targetServiceCount: NON_NEGATIVE_INT,
      proofHash: STRING,
      proofVersion: NON_NEGATIVE_INT,
    },
    [
      'operationId',
      'requestedAt',
      'requestedBy',
      'legalHoldCheckedAt',
      'completedAt',
      'targetServiceCount',
      'proofHash',
      'proofVersion',
    ],
  ),
  TenantProvisioningFailed: tenantEventSchema('TenantProvisioningFailed', {
    error: LONG_STRING,
    stepCount: NON_NEGATIVE_INT,
    durationMs: NON_NEGATIVE_INT,
    failedStepName: STRING,
    failedStepError: LONG_STRING,
    failedStepIndex: NON_NEGATIVE_INT,
    completedStepCount: NON_NEGATIVE_INT,
  }),
  TenantSubscriptionChanged: tenantEventSchema(
    'TenantSubscriptionChanged',
    {
      previousPlan: STRING,
      newPlan: STRING,
      effectiveDate: ISO_DATE_TIME,
      // DATA-LOW-001 projection fields (optional, additive).
      trialEndsAt: NULLABLE_ISO_DATE_TIME,
      subscriptionEndsAt: NULLABLE_ISO_DATE_TIME,
      subscriptionStatus: STRING,
    },
    ['previousPlan', 'newPlan', 'effectiveDate'],
  ),
  TenantModulesAssigned: tenantEventSchema(
    'TenantModulesAssigned',
    {
      moduleIds: UUID_ARRAY,
      moduleCodes: SHORT_CODE_ARRAY,
      pricingMonthlyTotal: NON_NEGATIVE_INT,
      pricingAnnualTotal: NON_NEGATIVE_INT,
      pricingTier: STRING,
      pricingCurrency: STRING,
      assignedBy: UUID_SCHEMA,
    },
    ['moduleIds', 'assignedBy'],
  ),
} as const satisfies Record<TenantEventType, Record<string, unknown>>;
