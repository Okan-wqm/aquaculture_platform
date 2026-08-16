/**
 * Tenant lifecycle / provisioning event JSON-Schema validator tests (MEDIUM-007).
 *
 * Pins the contract for every tenant event the outbox publishes:
 *   - A maximal valid fixture (ALL declared fields) validates — this also
 *     catches a schema that is MISSING a real contract field, because
 *     additionalProperties:false would reject the fixture.
 *   - Every TENANT_EVENT_SCHEMAS key has a fixture (coverage guard).
 *   - Unknown event type, extra field, and missing required field all reject.
 *   - The wire shape (timestamp as an ISO string) is what is validated.
 */
import { TENANT_EVENT_SCHEMAS, type TenantEventType } from '../tenant-events.schema';
import { validateTenantEvent, type TenantEventValidationResult } from '../validator';
import {
  TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET,
  TENANT_ERASURE_TARGET_SERVICES,
  type TenantErasureOutcomeEventType,
} from '../../tenant-erasure-targets';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OP_ID = '33333333-3333-4333-8333-333333333333';
const MODULE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';

function withBase(
  eventType: TenantEventType,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType,
    timestamp: '2026-06-12T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    ...payload,
  };
}

const OUTCOME_FIXTURES = Object.fromEntries(
  TENANT_ERASURE_TARGET_SERVICES.flatMap((targetService) => {
    const eventTypes = TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET[targetService];
    return [
      [
        eventTypes.erased,
        withBase(eventTypes.erased, {
          operationId: OP_ID,
          targetService,
          erasedAt: '2026-06-12T12:00:00.000Z',
          dryRun: false,
          matchedRecordCount: 42,
          erasedRecordCount: 42,
          proofHash: 'sha256:tenant-data-erased-proof',
        }),
      ],
      [
        eventTypes.failed,
        withBase(eventTypes.failed, {
          operationId: OP_ID,
          targetService,
          failedAt: '2026-06-12T12:00:00.000Z',
          errorCode: 'ERASURE_FAILED',
          errorMessage: 'target erasure failed',
          retryable: true,
        }),
      ],
      [
        eventTypes.blocked,
        withBase(eventTypes.blocked, {
          operationId: OP_ID,
          blockedAt: '2026-06-12T12:00:00.000Z',
          blockedByService: targetService,
          reason: 'active legal hold',
          legalMatterId: 'matter-2026-001',
        }),
      ],
    ] as const;
  }),
) as Record<TenantErasureOutcomeEventType, Record<string, unknown>>;

// Maximal fixtures — every declared field present, so a schema missing a real
// contract field fails here via additionalProperties:false.
const VALID_FIXTURES: Record<TenantEventType, Record<string, unknown>> = {
  TenantCreated: withBase('TenantCreated', {
    name: 'Acme Aqua',
    slug: 'acme-aqua',
    plan: 'professional',
    status: 'ACTIVE',
  }),
  TenantProvisioningRequested: withBase('TenantProvisioningRequested', {
    operationId: OP_ID,
    name: 'Acme Aqua',
    slug: 'acme-aqua',
    moduleIds: [MODULE_ID],
  }),
  TenantOnboardingRequested: withBase('TenantOnboardingRequested', {
    operationId: OP_ID,
    name: 'Acme Aqua',
    slug: 'acme-aqua',
    moduleIds: [MODULE_ID],
    generation: 1,
  }),
  TenantOnboardingAck: withBase('TenantOnboardingAck', {
    operationId: OP_ID,
    service: 'farm-service',
    acknowledgedAt: '2026-06-12T12:01:00.000Z',
    generation: 1,
  }),
  TenantOnboardingFailed: withBase('TenantOnboardingFailed', {
    operationId: OP_ID,
    service: 'farm-service',
    error: 'farm onboarding projection failed',
    generation: 1,
  }),
  TenantProvisioned: withBase('TenantProvisioned', {
    operationId: OP_ID,
    name: 'Acme Aqua',
    slug: 'acme-aqua',
  }),
  TenantUpdated: withBase('TenantUpdated', {
    name: 'Acme Aqua',
    plan: 'professional',
    status: 'ACTIVE',
    maxUsers: 25,
  }),
  TenantStatusChanged: withBase('TenantStatusChanged', {
    previousStatus: 'PROVISIONING',
    newStatus: 'ACTIVE',
    reason: 'provisioning completed',
  }),
  TenantSuspended: withBase('TenantSuspended', {
    reason: 'non-payment',
    suspendedBy: USER_ID,
  }),
  TenantActivated: withBase('TenantActivated', { activatedBy: USER_ID }),
  TenantArchived: withBase('TenantArchived', { archivedBy: USER_ID }),
  TenantErasureRequested: withBase('TenantErasureRequested', {
    operationId: OP_ID,
    requestedBy: USER_ID,
    requestedAt: '2026-06-12T11:55:00.000Z',
    legalHoldCheckedAt: '2026-06-12T11:55:01.000Z',
    dryRun: false,
    targetServiceCount: 10,
  }),
  ...OUTCOME_FIXTURES,
  TenantErased: withBase('TenantErased', {
    operationId: OP_ID,
    requestedAt: '2026-06-12T11:55:00.000Z',
    requestedBy: USER_ID,
    legalHoldCheckedAt: '2026-06-12T11:55:01.000Z',
    completedAt: '2026-06-12T12:05:00.000Z',
    targetServiceCount: 10,
    proofHash: 'sha256:final-tenant-erasure-proof',
    proofVersion: 1,
  }),
  TenantProvisioningFailed: withBase('TenantProvisioningFailed', {
    error: 'schema creation failed',
    stepCount: 5,
    durationMs: 1200,
    failedStepName: 'schema_creation',
    failedStepError: 'permission denied',
    failedStepIndex: 2,
    completedStepCount: 2,
  }),
  TenantSubscriptionChanged: withBase('TenantSubscriptionChanged', {
    previousPlan: 'free',
    newPlan: 'professional',
    effectiveDate: '2026-06-12T12:00:00.000Z',
    // DATA-LOW-001 projection fields — present here so the schema is proven to
    // accept them (additionalProperties:false would otherwise reject extras).
    // A null trialEndsAt (no trial) exercises the nullable date branch.
    trialEndsAt: null,
    subscriptionEndsAt: '2027-06-12T12:00:00.000Z',
    subscriptionStatus: 'active',
  }),
  TenantModulesAssigned: withBase('TenantModulesAssigned', {
    moduleIds: [MODULE_ID],
    moduleCodes: ['FARM', 'SENSOR'],
    pricingMonthlyTotal: 199,
    pricingAnnualTotal: 1990,
    pricingTier: 'professional',
    pricingCurrency: 'USD',
    assignedBy: USER_ID,
  }),
};

function expectValid(result: TenantEventValidationResult): void {
  if (!result.valid) {
    throw new Error(`expected valid, got: ${result.errors}`);
  }
  expect(result.valid).toBe(true);
}

describe('validateTenantEvent (MEDIUM-007)', () => {
  const schemaKeys = Object.keys(TENANT_EVENT_SCHEMAS) as TenantEventType[];

  it('has a validator + fixture for every registered tenant event schema', () => {
    expect(schemaKeys.length).toBe(16 + TENANT_ERASURE_TARGET_SERVICES.length * 3);
    for (const key of schemaKeys) {
      expect(VALID_FIXTURES[key]).toBeDefined();
    }
    // No orphan fixtures either.
    for (const key of Object.keys(VALID_FIXTURES)) {
      expect(schemaKeys).toContain(key as TenantEventType);
    }
  });

  it.each(schemaKeys)('accepts a maximal valid %s event', (eventType) => {
    expectValid(validateTenantEvent(eventType, VALID_FIXTURES[eventType]));
  });

  it('rejects an unknown tenant event type', () => {
    const result = validateTenantEvent('NotATenantEvent', VALID_FIXTURES.TenantCreated);
    expect(result.valid).toBe(false);
  });

  it('rejects an extra (unknown) field — additionalProperties:false closes the footgun', () => {
    const result = validateTenantEvent('TenantCreated', {
      ...VALID_FIXTURES.TenantCreated,
      injectedField: 'evil',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects a missing required payload field', () => {
    const { slug: _omitted, ...withoutSlug } = VALID_FIXTURES.TenantCreated as {
      slug: unknown;
    } & Record<string, unknown>;
    const result = validateTenantEvent('TenantCreated', withoutSlug);
    expect(result.valid).toBe(false);
  });

  it('rejects a missing required base field (tenantId)', () => {
    const { tenantId: _omitted, ...withoutTenant } = VALID_FIXTURES.TenantActivated as {
      tenantId: unknown;
    } & Record<string, unknown>;
    const result = validateTenantEvent('TenantActivated', withoutTenant);
    expect(result.valid).toBe(false);
  });

  it('rejects a non-object payload', () => {
    expect(validateTenantEvent('TenantCreated', null).valid).toBe(false);
    expect(validateTenantEvent('TenantCreated', 'string').valid).toBe(false);
  });
});
