import { ConflictException, NotFoundException } from '@nestjs/common';
import { OptimisticLockVersionMismatchError, Repository } from 'typeorm';
import { NatsEventBus } from '@platform/event-bus';
import {
  INGEST_BACKEND_POLICY_SUBJECTS,
  IngestBackendPolicyChange,
} from '@platform/event-contracts';

import {
  IngestBackendPolicyStateEntity,
  POLICY_STATE_SINGLETON_KEY,
} from '../entities/ingest-backend-policy-state.entity';
import {
  IngestBackendPolicyService,
  applyChangeToRow,
} from '../services/ingest-backend-policy.service';

/**
 * Unit tests for {@link IngestBackendPolicyService} + the
 * {@link applyChangeToRow} pure helper. The pure helper gets
 * exhaustive coverage since it is the state-transition table
 * every subscriber (Rust sidecar, future TS consumers) mirrors;
 * the service tests wrap it with the persistence + publish
 * side-effects using jest mocks so no DB or broker is needed.
 */

function seedRow(
  overrides: Partial<IngestBackendPolicyStateEntity> = {},
): IngestBackendPolicyStateEntity {
  const row = new IngestBackendPolicyStateEntity();
  row.key = POLICY_STATE_SINGLETON_KEY;
  row.defaultBackend = 'node';
  row.overrides = {};
  row.updatedBy = null;
  row.version = 1;
  row.updatedAt = new Date('2026-04-22T00:00:00Z');
  return Object.assign(row, overrides);
}

describe('applyChangeToRow — pure state-transition table', () => {
  it('set_global flips the default without touching overrides', () => {
    const current = seedRow({
      defaultBackend: 'node',
      overrides: { aaaa: 'rust' },
    });
    const next = applyChangeToRow(current, {
      action: 'set_global',
      backend: 'rust',
    });
    expect(next.defaultBackend).toBe('rust');
    expect(next.overrides).toEqual({ aaaa: 'rust' });
    // The original row MUST NOT mutate — tests rely on the
    // before/after invariant for audit trail construction.
    expect(current.defaultBackend).toBe('node');
  });

  it('set_tenant inserts a new override', () => {
    const current = seedRow();
    const next = applyChangeToRow(current, {
      action: 'set_tenant',
      tenantId: 'tenant-a',
      backend: 'rust',
    });
    expect(next.overrides).toEqual({ 'tenant-a': 'rust' });
    expect(current.overrides).toEqual({});
  });

  it('set_tenant overwrites an existing override', () => {
    const current = seedRow({
      overrides: { 'tenant-a': 'rust' },
    });
    const next = applyChangeToRow(current, {
      action: 'set_tenant',
      tenantId: 'tenant-a',
      backend: 'node',
    });
    expect(next.overrides).toEqual({ 'tenant-a': 'node' });
  });

  it('remove_tenant removes the override; global stays', () => {
    const current = seedRow({
      defaultBackend: 'rust',
      overrides: { 'tenant-a': 'node', 'tenant-b': 'rust' },
    });
    const next = applyChangeToRow(current, {
      action: 'remove_tenant',
      tenantId: 'tenant-a',
    });
    expect(next.overrides).toEqual({ 'tenant-b': 'rust' });
    expect(next.defaultBackend).toBe('rust');
  });

  it('remove_tenant on missing tenant is a no-op on overrides', () => {
    // Idempotency matters — the sidecar applies every event
    // independently, so a replayed remove_tenant for an
    // already-removed tenant must produce the same steady
    // state without throwing.
    const current = seedRow({
      overrides: { 'tenant-a': 'rust' },
    });
    const next = applyChangeToRow(current, {
      action: 'remove_tenant',
      tenantId: 'tenant-missing',
    });
    expect(next.overrides).toEqual({ 'tenant-a': 'rust' });
  });

  it('preserves @VersionColumn value — the caller saves with it', () => {
    // TypeORM uses the passed-in version to decide the next
    // value + guard optimistic-lock races. applyChange must NOT
    // touch it.
    const current = seedRow({ version: 7 });
    const next = applyChangeToRow(current, {
      action: 'set_global',
      backend: 'rust',
    });
    expect(next.version).toBe(7);
  });
});

describe('IngestBackendPolicyService — getSnapshot', () => {
  it('projects the entity row onto the wire-shape snapshot', async () => {
    const row = seedRow({
      defaultBackend: 'rust',
      overrides: { 'tenant-a': 'rust' },
    });
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn(),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn(),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    const snap = await svc.getSnapshot();
    expect(snap).toEqual({
      defaultBackend: 'rust',
      overrides: { 'tenant-a': 'rust' },
    });
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { key: POLICY_STATE_SINGLETON_KEY },
    });
  });

  it('throws NotFoundException when the singleton row is missing', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn(),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn(),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    await expect(svc.getSnapshot()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IngestBackendPolicyService — applyChange', () => {
  it('persists the next row + publishes the changed event', async () => {
    const current = seedRow();
    const repo = {
      findOne: jest.fn().mockResolvedValue(current),
      save: jest.fn().mockImplementation(async (entity) => entity),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn().mockResolvedValue(undefined),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    // Tenant UUID — the publisher's JSON-Schema validator enforces
    // UUID_PATTERN on change.tenantId. Using a proper UUID here
    // mirrors what the production HTTP surface forwards from the
    // caller's JWT / request body.
    const tenantUuid = '66666666-6666-6666-6666-666666666666';
    const actorUuid = '77777777-7777-7777-7777-777777777777';
    const change: IngestBackendPolicyChange = {
      action: 'set_tenant',
      tenantId: tenantUuid,
      backend: 'rust',
    };
    const result = await svc.applyChange(change, actorUuid, 'pilot enrol');
    expect(result).toEqual({
      defaultBackend: 'node',
      overrides: { [tenantUuid]: 'rust' },
    });

    // Persisted row carries the new override + preserved
    // version so TypeORM's optimistic-lock still engages.
    const persisted = (repo.save as jest.Mock).mock.calls[0][0];
    expect(persisted.overrides).toEqual({ [tenantUuid]: 'rust' });
    expect(persisted.version).toBe(1);

    // Published event lands on the canonical subject with the
    // original change payload + actor + reason.
    expect(eventBus.publishCore).toHaveBeenCalledTimes(1);
    const [publishedSubject, publishedPayload] = (eventBus.publishCore as jest.Mock).mock.calls[0];
    expect(publishedSubject).toBe(INGEST_BACKEND_POLICY_SUBJECTS.changed);
    const decoded = JSON.parse(new TextDecoder().decode(publishedPayload as Uint8Array));
    expect(decoded.eventType).toBe('IngestBackendPolicyChanged');
    expect(decoded.change).toEqual(change);
    expect(decoded.actorId).toBe(actorUuid);
    expect(decoded.reason).toBe('pilot enrol');
  });

  it('translates OptimisticLockVersionMismatchError into 409 Conflict', async () => {
    const current = seedRow();
    const repo = {
      findOne: jest.fn().mockResolvedValue(current),
      save: jest
        .fn()
        .mockRejectedValue(
          new OptimisticLockVersionMismatchError('IngestBackendPolicyStateEntity', 1, 1),
        ),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn(),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    await expect(svc.applyChange({ action: 'set_global', backend: 'rust' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    // AND no event was published — the lost-race path must NOT
    // fire a spurious changed event.
    expect(eventBus.publishCore).not.toHaveBeenCalled();
  });

  it('rejects a malformed change at the JSON-Schema validator boundary before publishing', async () => {
    // Defense-in-depth: the publisher validates the constructed
    // event against the ADR-031 schema before calling
    // eventBus.publishCore. A caller that bypasses the typed
    // contract (e.g. by passing a mis-typed `change` through an
    // `as any`) still hits the runtime guard. The malformed
    // payload NEVER reaches NATS.
    const current = seedRow();
    const repo = {
      findOne: jest.fn().mockResolvedValue(current),
      save: jest.fn().mockImplementation(async (entity) => entity),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn(),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    // set_tenant with a non-UUID tenantId — schema REJECTS.
    const bad: IngestBackendPolicyChange = {
      action: 'set_tenant',
      tenantId: 'not-a-uuid',
      backend: 'rust',
    };

    await expect(svc.applyChange(bad)).rejects.toThrow(
      /IngestBackendPolicyChanged payload failed schema validation/,
    );
    // Validator ran BEFORE persistence (ADR-031 invariant — if we
    // cannot publish a valid event, we MUST NOT persist the row).
    // So NEITHER the DB save NOR the NATS publish happened.
    expect(repo.save).not.toHaveBeenCalled();
    expect(eventBus.publishCore).not.toHaveBeenCalled();
  });

  it('publish failure does NOT roll back the DB write (sidecar recovers via cold-start snapshot)', async () => {
    // ADR-031: the DB row is the SoT. A publish failure is a
    // degraded state the sidecar heals on its next cold start
    // via `policy.ingest_backend.snapshot`. The service logs
    // WARN + returns the new state.
    const current = seedRow();
    const repo = {
      findOne: jest.fn().mockResolvedValue(current),
      save: jest.fn().mockImplementation(async (entity) => entity),
    } as unknown as Repository<IngestBackendPolicyStateEntity>;
    const eventBus = {
      publishCore: jest.fn().mockRejectedValue(new Error('broker down')),
    } as unknown as NatsEventBus;
    const svc = new IngestBackendPolicyService(repo, eventBus);

    const result = await svc.applyChange({
      action: 'set_global',
      backend: 'rust',
    });
    expect(result.defaultBackend).toBe('rust');
    // The save DID happen — the row change is durable.
    expect(repo.save).toHaveBeenCalledTimes(1);
  });
});
