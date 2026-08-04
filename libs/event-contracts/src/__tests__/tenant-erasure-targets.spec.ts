import {
  resolveTenantErasureOutcomeEventType,
  TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET,
  TENANT_ERASURE_OUTCOME_KINDS,
  TENANT_ERASURE_TARGET_SERVICES,
  tenantErasureOutcomeEventType,
  tenantErasureOutcomeSubject,
} from '../tenant-erasure-targets';

describe('tenant-erasure certificate-bound outcome registry', () => {
  it('assigns three globally unique event types and exact subject patterns to every target', () => {
    const eventTypes = new Set<string>();

    for (const targetService of TENANT_ERASURE_TARGET_SERVICES) {
      for (const outcome of TENANT_ERASURE_OUTCOME_KINDS) {
        const eventType = tenantErasureOutcomeEventType(targetService, outcome);
        expect(eventType).toBe(
          TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET[targetService][outcome],
        );
        expect(eventType).toMatch(/^[A-Z][A-Za-z0-9]+$/u);
        expect(tenantErasureOutcomeSubject(targetService, outcome)).toBe(`events.*.${eventType}`);
        expect(eventTypes.has(eventType)).toBe(false);
        eventTypes.add(eventType);
      }
    }

    expect(eventTypes.size).toBe(TENANT_ERASURE_TARGET_SERVICES.length * 3);
    expect(eventTypes).not.toContain('TenantDataErased');
    expect(eventTypes).not.toContain('TenantDataErasureFailed');
    expect(eventTypes).not.toContain('TenantErasureBlocked');
  });

  it('resolves each event type back to exactly one target and outcome', () => {
    for (const targetService of TENANT_ERASURE_TARGET_SERVICES) {
      for (const outcome of TENANT_ERASURE_OUTCOME_KINDS) {
        const eventType = tenantErasureOutcomeEventType(targetService, outcome);
        expect(resolveTenantErasureOutcomeEventType(eventType)).toEqual({
          targetService,
          outcome,
          eventType,
        });
      }
    }
    expect(resolveTenantErasureOutcomeEventType('TenantDataErased')).toBeNull();
    expect(resolveTenantErasureOutcomeEventType('FarmServiceTenantDataErasedSpoof')).toBeNull();
  });
});
