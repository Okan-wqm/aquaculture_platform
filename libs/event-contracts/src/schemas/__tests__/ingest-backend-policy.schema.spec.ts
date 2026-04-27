import {
  INGEST_BACKEND_POLICY_EVENT_SCHEMAS,
  validateIngestBackendPolicyEvent,
} from '../';

/**
 * Byte-level tests for the ADR-031 IngestBackendPolicyChanged
 * schema validator. Every scenario the Rust sidecar's subscriber
 * MUST reject is pinned here so a future shape drift (TS publisher
 * vs Rust decoder) fails at the AJV boundary before the payload
 * ever reaches a subscriber.
 */

const base = (): Record<string, unknown> => ({
  eventId: '00000000-0000-0000-0000-000000000001',
  eventType: 'IngestBackendPolicyChanged',
  timestamp: '2026-04-22T12:34:56.000Z',
  tenantId: 'admin',
  version: 1,
});

describe('IngestBackendPolicyChanged — positive cases', () => {
  it('accepts a valid set_global payload', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: { action: 'set_global', backend: 'rust' },
      },
    );
    expect(result).toEqual({ valid: true });
  });

  it('accepts a valid set_tenant payload', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: {
          action: 'set_tenant',
          tenantId: '11111111-1111-1111-1111-111111111111',
          backend: 'rust',
        },
      },
    );
    expect(result).toEqual({ valid: true });
  });

  it('accepts a valid remove_tenant payload', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: {
          action: 'remove_tenant',
          tenantId: '22222222-2222-2222-2222-222222222222',
        },
      },
    );
    expect(result).toEqual({ valid: true });
  });

  it('accepts optional reason + actorId when present', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: { action: 'set_global', backend: 'node' },
        reason: 'Phase-1 cut-over',
        actorId: '33333333-3333-3333-3333-333333333333',
      },
    );
    expect(result).toEqual({ valid: true });
  });
});

describe('IngestBackendPolicyChanged — negative cases (wire hardening)', () => {
  it('rejects wrong eventType', () => {
    const result = validateIngestBackendPolicyEvent(
      'SomethingElse',
      { ...base(), change: { action: 'set_global', backend: 'rust' } },
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toMatch(/Unknown/i);
  });

  it('rejects non-object payload', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      null,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toMatch(/Payload must be a JSON object/);
    }
  });

  it('rejects tenantId other than "admin"', () => {
    // Platform-wide sentinel invariant — a tenant-scoped tenantId
    // on a policy event would leak rollout state into per-tenant
    // read paths.
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        tenantId: '44444444-4444-4444-4444-444444444444',
        change: { action: 'set_global', backend: 'rust' },
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects extra top-level field (additionalProperties: false)', () => {
    // H-3 hardening — closes the "attacker injects a free-text
    // field that flows into a sink" footgun.
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: { action: 'set_global', backend: 'rust' },
        evilSink: '<script>alert(1)</script>',
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects unknown backend value in set_global', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: { action: 'set_global', backend: 'evil' },
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects set_tenant with non-UUID tenantId in change', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: {
          action: 'set_tenant',
          tenantId: 'not-a-uuid',
          backend: 'rust',
        },
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects unknown action', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: {
          action: 'reboot_everything',
          backend: 'rust',
        },
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects set_tenant missing backend field', () => {
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: {
          action: 'set_tenant',
          tenantId: '55555555-5555-5555-5555-555555555555',
        },
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects reason field longer than 500 chars (MAX_FREE_TEXT_LENGTH)', () => {
    // Amplification / memory-DoS guard on the free-text field.
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      {
        ...base(),
        change: { action: 'set_global', backend: 'rust' },
        reason: 'x'.repeat(501),
      },
    );
    expect(result.valid).toBe(false);
  });

  it('rejects missing change field', () => {
    const payload = { ...base() };
    const result = validateIngestBackendPolicyEvent(
      'IngestBackendPolicyChanged',
      payload,
    );
    expect(result.valid).toBe(false);
  });
});

describe('INGEST_BACKEND_POLICY_EVENT_SCHEMAS — export shape', () => {
  it('exports exactly the expected schema set — regression guard', () => {
    // A refactor that accidentally dropped a schema entry would
    // ship a validator with missing types — pin the count.
    expect(Object.keys(INGEST_BACKEND_POLICY_EVENT_SCHEMAS)).toEqual([
      'IngestBackendPolicyChanged',
    ]);
  });
});
