import {
  INGEST_BACKEND_POLICY_SUBJECTS,
  IngestBackendKind,
  IngestBackendPolicyChange,
  IngestBackendPolicyChangedEvent,
  IngestBackendSnapshot,
  IngressOwnerPolicy,
} from '../ingest-backend-policy';

/**
 * Byte-level wire-shape tests for the ADR-031 ingest-backend
 * policy contracts. The Rust sidecar (apps/sensor-ingestion)
 * serializes the mirror enum with
 * `#[serde(rename_all = "lowercase")]` on `IngestBackend` and
 * `#[serde(tag = "action", rename_all = "snake_case")]` on
 * `IngestBackendChange`. A drift on either side would surface
 * only at runtime via the sidecar's
 * `sensor_ingestion_policy_change_decode_failed_total` counter;
 * these tests pin the exact bytes so a refactor fails the build
 * long before a deploy.
 */

describe('ingest-backend-policy — subject literals', () => {
  it('pins canonical NATS subjects byte-for-byte', () => {
    // Any drift on these strings would break cross-language
    // routing — the Rust sidecar pins the same literals in
    // apps/sensor-ingestion/src/policy.rs (SNAPSHOT_SUBJECT,
    // CHANGE_SUBJECT_FILTER) via its own unit test.
    expect(INGEST_BACKEND_POLICY_SUBJECTS.snapshot).toBe('policy.ingest_backend.snapshot');
    expect(INGEST_BACKEND_POLICY_SUBJECTS.changed).toBe('policy.ingest_backend.changed');
    expect(INGEST_BACKEND_POLICY_SUBJECTS.subjectFilter).toBe('policy.ingest_backend.>');
    expect(INGEST_BACKEND_POLICY_SUBJECTS.ownerSnapshot).toBe('policy.ingress_owner.snapshot');
    expect(INGEST_BACKEND_POLICY_SUBJECTS.ownerSubjectFilter).toBe(
      'policy.ingress_owner.changed.*',
    );
  });

  it('subjectFilter is a NATS greedy wildcard over the changed subject', () => {
    // Defensive: the sidecar subscribes using the filter so a
    // regression that narrowed the filter to exactly the
    // `changed` subject would silently miss future sibling
    // subjects.
    expect(INGEST_BACKEND_POLICY_SUBJECTS.subjectFilter.endsWith('>')).toBe(true);
    expect(
      INGEST_BACKEND_POLICY_SUBJECTS.changed.startsWith(
        INGEST_BACKEND_POLICY_SUBJECTS.subjectFilter.slice(0, -1),
      ),
    ).toBe(true);
  });
});

describe('ingress-owner-policy — versioned handoff wire shape', () => {
  it('matches the Rust fail-closed policy shape byte-for-byte', () => {
    const policy: IngressOwnerPolicy = {
      tenantId: '11111111-1111-1111-1111-111111111111',
      version: 7,
      owner: 'RUST',
      effectiveEpoch: 'epoch-2026-08-25-01',
      state: 'ACTIVE',
    };

    expect(JSON.stringify(policy)).toBe(
      '{"tenantId":"11111111-1111-1111-1111-111111111111","version":7,"owner":"RUST","effectiveEpoch":"epoch-2026-08-25-01","state":"ACTIVE"}',
    );
  });
});

describe('ingest-backend-policy — snapshot wire shape', () => {
  it('serialises to the Rust IngestBackendSnapshot shape', () => {
    // Canonical JSON the admin-api responder must produce — the
    // Rust side deserialises via serde + asserts this exact shape.
    const snap: IngestBackendSnapshot = {
      defaultBackend: 'node',
      overrides: {
        '11111111-1111-1111-1111-111111111111': 'rust',
      },
    };
    const json = JSON.stringify(snap);
    // Field ordering matters only at the bytes level; the Rust
    // decoder ignores order, but pinning the canonical form
    // catches a marshaller regression early.
    expect(json).toContain('"defaultBackend":"node"');
    expect(json).toContain('"11111111-1111-1111-1111-111111111111":"rust"');
  });

  it('accepts round-trip via JSON.parse without coercion', () => {
    const original: IngestBackendSnapshot = {
      defaultBackend: 'rust',
      overrides: {
        aaaaaaaa: 'node', // UUID shape not validated at TS level — that's Rust's job
      },
    };
    const decoded: IngestBackendSnapshot = JSON.parse(JSON.stringify(original));
    expect(decoded).toEqual(original);
  });
});

describe('ingest-backend-policy — change tagged union', () => {
  it('set_global → {"action":"set_global","backend":"rust"}', () => {
    const change: IngestBackendPolicyChange = {
      action: 'set_global',
      backend: 'rust',
    };
    const json = JSON.stringify(change);
    expect(json).toBe('{"action":"set_global","backend":"rust"}');
  });

  it('set_tenant → {"action":"set_tenant","tenantId":"…","backend":"…"}', () => {
    const change: IngestBackendPolicyChange = {
      action: 'set_tenant',
      tenantId: '22222222-2222-2222-2222-222222222222',
      backend: 'rust',
    };
    const json = JSON.stringify(change);
    // Pin the literal so a refactor that renamed tenantId →
    // tenant_id silently breaks the Rust decode.
    expect(json).toBe(
      '{"action":"set_tenant","tenantId":"22222222-2222-2222-2222-222222222222","backend":"rust"}',
    );
  });

  it('remove_tenant → {"action":"remove_tenant","tenantId":"…"}', () => {
    const change: IngestBackendPolicyChange = {
      action: 'remove_tenant',
      tenantId: '33333333-3333-3333-3333-333333333333',
    };
    const json = JSON.stringify(change);
    expect(json).toBe(
      '{"action":"remove_tenant","tenantId":"33333333-3333-3333-3333-333333333333"}',
    );
  });

  it('tagged union narrows on `action` at the type level', () => {
    // Compile-time guard: a refactor that removed the
    // discriminator would break narrowing, and the following
    // function would stop compiling.
    function pickBackend(c: IngestBackendPolicyChange): IngestBackendKind | null {
      switch (c.action) {
        case 'set_global':
          return c.backend;
        case 'set_tenant':
          return c.backend;
        case 'remove_tenant':
          return null;
      }
    }
    expect(pickBackend({ action: 'set_global', backend: 'node' })).toBe('node');
    expect(
      pickBackend({
        action: 'set_tenant',
        tenantId: 't',
        backend: 'rust',
      }),
    ).toBe('rust');
    expect(
      pickBackend({
        action: 'remove_tenant',
        tenantId: 't',
      }),
    ).toBeNull();
  });
});

describe('ingest-backend-policy — event shape', () => {
  it('matches BaseEvent + required discriminator', () => {
    const event: IngestBackendPolicyChangedEvent = {
      // Cast is acceptable only in TEST scope — BaseEvent.eventId
      // is a branded type producible only by createBaseEvent().
      // This test asserts WIRE shape, not runtime construction.
      eventId: '00000000-0000-0000-0000-000000000000' as IngestBackendPolicyChangedEvent['eventId'],
      eventType: 'IngestBackendPolicyChanged',
      timestamp: '2026-04-22T12:34:56.000Z',
      tenantId: 'admin',
      version: 1,
      change: { action: 'set_global', backend: 'rust' },
      reason: 'Phase-1 cut-over',
      actorId: '99999999-9999-9999-9999-999999999999',
    };
    expect(event.eventType).toBe('IngestBackendPolicyChanged');
    expect(event.change).toEqual({ action: 'set_global', backend: 'rust' });
  });

  it('reason + actorId are optional', () => {
    const event: IngestBackendPolicyChangedEvent = {
      eventId: '00000000-0000-0000-0000-000000000000' as IngestBackendPolicyChangedEvent['eventId'],
      eventType: 'IngestBackendPolicyChanged',
      timestamp: '2026-04-22T12:34:56.000Z',
      tenantId: 'admin',
      version: 1,
      change: {
        action: 'remove_tenant',
        tenantId: '44444444-4444-4444-4444-444444444444',
      },
    };
    expect(event.reason).toBeUndefined();
    expect(event.actorId).toBeUndefined();
  });
});
