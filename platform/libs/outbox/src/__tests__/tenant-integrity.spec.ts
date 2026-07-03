/**
 * Outbox tenant-integrity gate (FARM-HIGH-083).
 *
 * The outbox WORKER drains rows across ALL tenants and derives the NATS subject
 * from the event's tenantId; `IEventBus.deriveSubject()` downgrades a tenant-less
 * event onto the cross-tenant `events.system.*` subject. Before this gate the
 * worker published the row's payload verbatim, so a tenant-scoped row that reached
 * dispatch with a missing / non-UUID / drifted tenant was MIS-ROUTED system-wide
 * — a tenant-isolation breach. These tests pin the dispatch-boundary assertion
 * that makes that mis-route impossible (it dead-letters instead of publishing).
 */
import {
  assertOutboxTenantIntegrity,
  OutboxTenantIntegrityError,
} from '../tenant-integrity';

const TENANT_A = '550e8400-e29b-41d4-a716-446655440000';
const TENANT_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function row(
  tenantId: string | null,
  payloadTenantId: string | null | undefined,
): { id: string; tenantId: string | null; payload: { eventType: string; tenantId: string | null | undefined } } {
  return {
    id: 'row-1',
    tenantId,
    payload: { eventType: 'BatchHarvested', tenantId: payloadTenantId },
  };
}

describe('assertOutboxTenantIntegrity (FARM-HIGH-083)', () => {
  describe('passes — tenant of record is a valid UUID', () => {
    it('column UUID matches payload UUID (the normal publisher-written row)', () => {
      expect(() => assertOutboxTenantIntegrity(row(TENANT_A, TENANT_A))).not.toThrow();
    });

    it('legacy row: null column, valid UUID payload (worker trusts the payload)', () => {
      expect(() => assertOutboxTenantIntegrity(row(null, TENANT_A))).not.toThrow();
    });
  });

  describe('throws — would mis-route to events.system.* (never published)', () => {
    it('column UUID but payload tenantId is null (the headline fail-open)', () => {
      expect(() => assertOutboxTenantIntegrity(row(TENANT_A, null))).toThrow(
        OutboxTenantIntegrityError,
      );
    });

    it('column UUID but payload tenantId is undefined', () => {
      expect(() => assertOutboxTenantIntegrity(row(TENANT_A, undefined))).toThrow(
        OutboxTenantIntegrityError,
      );
    });

    it('column UUID disagrees with payload UUID (tenant drift)', () => {
      expect(() => assertOutboxTenantIntegrity(row(TENANT_A, TENANT_B))).toThrow(
        OutboxTenantIntegrityError,
      );
    });

    it('both column and payload tenantId are null (tenant-less row)', () => {
      expect(() => assertOutboxTenantIntegrity(row(null, null))).toThrow(
        OutboxTenantIntegrityError,
      );
    });

    it('null column with a non-UUID payload tenantId (subject-injection shape)', () => {
      expect(() => assertOutboxTenantIntegrity(row(null, 'system'))).toThrow(
        OutboxTenantIntegrityError,
      );
    });

    it('payload tenantId is an empty string', () => {
      expect(() => assertOutboxTenantIntegrity(row(TENANT_A, ''))).toThrow(
        OutboxTenantIntegrityError,
      );
    });
  });

  describe('error carries triage context', () => {
    it('is an Error subclass that reports the row id + both tenants', () => {
      let caught: unknown;
      try {
        assertOutboxTenantIntegrity(row(TENANT_A, null));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(OutboxTenantIntegrityError);
      expect(caught).toBeInstanceOf(Error);
      const err = caught as OutboxTenantIntegrityError;
      expect(err.name).toBe('OutboxTenantIntegrityError');
      expect(err.rowId).toBe('row-1');
      expect(err.columnTenantId).toBe(TENANT_A);
      expect(err.payloadTenantId).toBeNull();
      expect(err.message).toContain('events.system.*');
    });
  });
});
