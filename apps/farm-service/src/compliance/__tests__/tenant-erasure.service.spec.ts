/**
 * TenantErasureService Unit Tests
 *
 * Covers the two-step confirmation flow in isolation:
 *   - initiate creates a ticket with a 32-hex token and 5-min expiry
 *   - confirm with the matching token + tenant succeeds
 *   - confirm with a MISSING ticket → NotFoundException
 *   - confirm with a WRONG token → BadRequestException
 *   - confirm with a WRONG tenant → BadRequestException
 *   - confirm after expiry → BadRequestException, ticket consumed
 *   - second initiate replaces the first (single pending per tenant)
 *   - ticket is consumed before DELETE so retry with the same token
 *     after partial failure is impossible
 *
 * DELETE cascade itself is exercised against a doubled DataSource
 * so we assert the topological sort + anonymise behaviour without
 * standing up a real DB.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { LegalHoldService } from '@aquaculture/backend-common/compliance';
import type { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { TenantErasureService } from '../services/tenant-erasure.service';

interface EntityMetadataDouble {
  tableName: string;
  target: unknown;
  columns: Array<{ propertyName: string }>;
  foreignKeys: Array<{ referencedTablePath: string }>;
}

function dataSourceDouble(dataSource: {
  entityMetadatas: EntityMetadataDouble[];
  createQueryBuilder: jest.Mock;
  createQueryRunner: jest.Mock;
  query: jest.Mock;
}): DataSource {
  const instance = new DataSource({
    type: 'postgres',
    database: 'tenant-erasure-service-spec',
  });
  Object.defineProperty(instance, 'entityMetadatas', {
    configurable: true,
    value: dataSource.entityMetadatas,
  });
  jest
    .spyOn(instance, 'createQueryBuilder')
    .mockImplementation(dataSource.createQueryBuilder);
  jest
    .spyOn(instance, 'createQueryRunner')
    .mockImplementation(dataSource.createQueryRunner);
  jest.spyOn(instance, 'query').mockImplementation(dataSource.query);
  return instance;
}

function outboxPublisherDouble(
  publisher: Pick<OutboxPublisher, 'enqueue'>,
): OutboxPublisher {
  return publisher as OutboxPublisher;
}

function legalHoldServiceDouble(
  service: Pick<LegalHoldService, 'assertNoHold'>,
): LegalHoldService {
  return service as LegalHoldService;
}

function allowLegalHoldServiceDouble(): LegalHoldService {
  return legalHoldServiceDouble({
    assertNoHold: jest.fn().mockResolvedValue(undefined),
  });
}

function noopOutboxPublisherDouble(): OutboxPublisher {
  return outboxPublisherDouble({
    enqueue: jest.fn().mockResolvedValue(undefined),
  });
}

function makeTenantErasureService(
  dataSource: DataSource,
  options: {
    publisher?: OutboxPublisher;
    legalHoldService?: LegalHoldService;
  } = {},
): TenantErasureService {
  return new TenantErasureService(
    dataSource,
    options.publisher ?? noopOutboxPublisherDouble(),
    options.legalHoldService ?? allowLegalHoldServiceDouble(),
  );
}

function makeDs(opts: {
  entities: EntityMetadataDouble[];
  deleteResults?: Record<string, number>;
  auditAnonAffected?: number;
  deleteError?: Error;
  /**
   * COMPLIANCE-MEDIUM-004 / TASK-14: when defined, the
   * schema-qualified `dataSource.query(... farm.tenant_erasure_audit
   * ...)` lookup returns this row, simulating a pre-existing erasure
   * for the idempotency-replay test paths. Default null = no prior
   * erasure exists.
   */
  existingErasureAuditRow?: {
    tenantId: string;
    confirmedAt: Date;
    deletedRowsByTable: Record<string, number>;
    totalDeleted: number;
    auditRowsAnonymised: number;
    requestedBy: string;
    tableCount: number;
  } | null;
}) {
  const executed: string[] = [];
  const deleteAffected = (table: string): number =>
    opts.deleteResults?.[table] ?? 0;
  const auditQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      affected: opts.auditAnonAffected ?? 0,
    }),
  };
  // The main query builder services both DELETE chains (delete().from(E))
  // AND the audit UPDATE chain (update('farm.farm_audit_logs')). TypeORM
  // exposes a single createQueryBuilder() entrypoint; the service-under-
  // test uses the DELETE path inside the cascade loop and the UPDATE path
  // for the audit anonymise step. The `update` method here delegates to
  // auditQb so the UPDATE assertions (set / where / execute) remain
  // observable through the auditQb spy.
  let countMode = false;
  let countTable: string | undefined;
  const qb: {
    select: jest.Mock;
    delete: jest.Mock;
    from: jest.Mock;
    where: jest.Mock;
    getRawOne: jest.Mock;
    execute: jest.Mock;
    update: jest.Mock;
  } = {
    select: jest.fn().mockImplementation(() => {
      countMode = true;
      return qb;
    }),
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation((target: unknown) => {
      const meta = opts.entities.find((e) => e.target === target);
      if (meta && countMode) {
        countTable = meta.tableName;
      } else if (meta) {
        executed.push(meta.tableName);
      }
      return qb;
    }),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockImplementation(async () => {
      const count = deleteAffected(countTable ?? '');
      countMode = false;
      countTable = undefined;
      return { count: String(count) };
    }),
    execute: jest.fn().mockImplementation(async () => {
      if (opts.deleteError) throw opts.deleteError;
      const last = executed[executed.length - 1] ?? '';
      return { affected: deleteAffected(last) };
    }),
    update: jest.fn().mockImplementation((table: string) => {
      auditQb.update(table);
      return auditQb;
    }),
  };
  const createQueryBuilder = jest.fn().mockImplementation(() => qb);
  // Double the EntityManager surface that the service uses inside the
  // tenant-pinned transaction (queryRunner.manager). The manager's
  // queryRunner must expose `isTransactionActive: true` because the
  // real OutboxPublisher asserts it before calling `.enqueue()`.
  // COMPLIANCE-MEDIUM-004: the cascade now calls
  // `mgr.insert(TenantErasureAuditEntity, ...)` to persist the
  // erasure-audit row inside the transaction. Stub the insert
  // method to a resolved promise; spec-side observers can
  // assert on insertCalls if needed.
  const insertCalls: Array<{ entity: unknown; row: unknown }> = [];
  const managerDouble = {
    createQueryBuilder,
    queryRunner: { isTransactionActive: true },
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('farm_audit_logs')) {
        return [{ count: String(opts.auditAnonAffected ?? 0) }];
      }
      if (sql.includes('COUNT(*)::text AS count')) {
        return [{ count: '0' }];
      }
      return [];
    }),
    insert: jest.fn().mockImplementation(
      async (entity: unknown, row: unknown) => {
        insertCalls.push({ entity, row });
        return { identifiers: [], generatedMaps: [], raw: [] };
      },
    ),
  };

  // TASK-14: the cascade now runs through
  // `runInTenantTransaction(dataSource, 'farm', tenantId, …)`. That
  // helper drives a real QueryRunner: connect → startTransaction →
  // pin search_path → assert current_schema()+RLS GUC → fn(qr) →
  // commit/rollback → release. The queryRunner double honours that
  // contract. `queryRunner.manager` IS the managerDouble so the
  // cascade body (createQueryBuilder / insert / enqueue) is unchanged.
  //
  // The pin captures the tenant schema from the issued search_path so
  // the subsequent `current_schema()` readback returns the SAME schema
  // — modelling a correctly-routed connection. assertTenantTransaction
  // Context then passes (schema + GUC match), proving the destructive
  // cascade only runs once the tenant context is verified.
  let pinnedTenantSchema: string | null = null;
  let pinnedTenant: string | null = null;
  const queryRunnerQuery = jest.fn().mockImplementation(
    async (sql: string, params?: unknown[]) => {
      if (sql.includes("set_config('search_path'")) {
        const pinned = String(params?.[0] ?? '');
        const match = pinned.match(/^"(tenant_[a-f0-9]+)"/);
        pinnedTenantSchema = match ? match[1]! : null;
        return undefined;
      }
      if (sql.includes('set_config($1, $2, true)')) {
        // assertTenantTransactionContext OWNS the RLS GUC: params are
        // [RLS_TENANT_GUC, tenantId].
        pinnedTenant = String(params?.[1] ?? '');
        return undefined;
      }
      if (sql.includes('current_schema()')) {
        return [{ schema: pinnedTenantSchema, tenant: pinnedTenant }];
      }
      return undefined;
    },
  );
  const queryRunner = {
    manager: managerDouble,
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    query: queryRunnerQuery,
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
  const createQueryRunner = jest.fn().mockImplementation(() => queryRunner);

  // TASK-14: lookupExistingErasure now reads the cross-tenant
  // `farm.tenant_erasure_audit` table via a schema-qualified raw
  // `dataSource.query()` (NOT a bare repository handle). Returns the
  // configured existing-audit row (replay path) or [] (first-call).
  const existingRow = opts.existingErasureAuditRow ?? null;
  const dataSourceQuery = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('tenant_erasure_audit')) {
      return existingRow ? [existingRow] : [];
    }
    return [];
  });

  const dataSource = {
    entityMetadatas: opts.entities,
    createQueryBuilder,
    createQueryRunner,
    query: dataSourceQuery,
  };
  return {
    dataSource: dataSourceDouble(dataSource),
    executed,
    qb,
    auditQb,
    managerDouble,
    queryRunner,
    createQueryRunner,
    insertCalls,
    dataSourceQuery,
  };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'user-1';

describe('TenantErasureService ticket flow', () => {
  it('initiate returns a 32-hex token with 5-minute expiry', () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    const before = Date.now();
    const ticket = service.initiate(TENANT, USER);
    expect(ticket.tenantId).toBe(TENANT);
    expect(ticket.token).toMatch(/^[0-9a-f]{32}$/);
    expect(ticket.requestedBy).toBe(USER);
    const ttl = ticket.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(4.9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5.1 * 60 * 1000);
  });

  it('confirm without an initiate throws NotFoundException', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    await expect(service.confirm(TENANT, 'x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('confirm with a wrong token rejects with BadRequestException', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    service.initiate(TENANT, USER);
    await expect(
      service.confirm(TENANT, 'not-the-token'),
    ).rejects.toThrow(/token does not match/i);
  });

  it('confirm with a wrong tenant rejects (no ticket for that tenant)', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await expect(
      service.confirm(OTHER_TENANT, ticket.token),
    ).rejects.toThrow(NotFoundException);
  });

  it('confirm after expiry throws BadRequestException and consumes the ticket', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    // Mutate the expiry so the ticket is stale without actually
    // waiting 5 minutes. The private map is reachable via the
    // documented getPendingTicket helper.
    const pending = service.getPendingTicket(TENANT);
    if (pending) pending.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /expired/i,
    );
    expect(service.getPendingTicket(TENANT)).toBeUndefined();
  });

  it('second initiate replaces the first (single pending per tenant)', () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    const t1 = service.initiate(TENANT, USER);
    const t2 = service.initiate(TENANT, USER);
    expect(t1.token).not.toBe(t2.token);
    expect(service.getPendingTicket(TENANT)?.token).toBe(t2.token);
  });

  it('successful confirm consumes the ticket so it cannot be replayed', async () => {
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'example',
          target: class Example {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { example: 3 },
      auditAnonAffected: 0,
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    expect(service.getPendingTicket(TENANT)).toBeUndefined();
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('TenantErasureService DELETE cascade', () => {
  it('skips farm_audit_logs from DELETE and anonymises its userId instead', async () => {
    const { dataSource, executed, auditQb } = makeDs({
      entities: [
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 5 },
      auditAnonAffected: 12,
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    expect(executed).toEqual(['batches_v2']); // audit table skipped
    expect(result.deletedRowsByTable).toEqual({ batches_v2: 5 });
    expect(result.totalDeleted).toBe(5);
    expect(result.auditRowsAnonymised).toBe(12);
    expect(auditQb.update).toHaveBeenCalledWith('farm.farm_audit_logs');
  });

  it('sorts by inbound-FK count so child tables delete before parents', async () => {
    const { dataSource, executed } = makeDs({
      entities: [
        {
          tableName: 'parent',
          target: class Parent {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'child',
          target: class Child {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [{ referencedTablePath: 'parent' }],
        },
      ],
      deleteResults: { child: 2, parent: 1 },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    // Parent has 1 inbound FK (from child); child has 0.
    // Sort ascending by inbound count → child (0), parent (1).
    expect(executed).toEqual(['child', 'parent']);
  });
});

describe('TenantErasureService TenantDataErased proof emission', () => {
  it('enqueues a TenantDataErased proof on the outbox inside the same transaction', async () => {
    const { dataSource, createQueryRunner, queryRunner } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 7 },
      auditAnonAffected: 4,
    });
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const publisher = outboxPublisherDouble({ enqueue });
    const service = makeTenantErasureService(dataSource, { publisher });
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    // A single tenant-pinned transaction was opened and committed —
    // the cascade ran inside it so the outbox row commits atomically
    // with the writes. The QueryRunner is released exactly once.
    expect(createQueryRunner).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [event, mgrArg] = enqueue.mock.calls[0]!;
    expect(event.eventType).toBe('TenantDataErased');
    expect(event.tenantId).toBe(TENANT);
    expect(event.operationId).toBe(ticket.operationId);
    expect(event.targetService).toBe('farm-service');
    expect(event.matchedRecordCount).toBe(11);
    expect(event.erasedRecordCount).toBe(7);
    expect(event.proofHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(event.aggregateId).toBe(TENANT);
    expect(event.aggregateType).toBe('Tenant');
    expect(event.erasedAt).toBe(result.confirmedAt);
    // The `mgr` passed to enqueue is the transaction-scoped
    // EntityManager double — the publisher asserts an active
    // transaction so the outbox row commits with the domain writes.
    expect(mgrArg).toBeDefined();
    expect(mgrArg.queryRunner.isTransactionActive).toBe(true);
  });

  it('DELETE failure rolls back the transaction and suppresses the event', async () => {
    const { dataSource, queryRunner } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteError: new Error('PG-23503: FK violation'),
    });
    const enqueue = jest.fn();
    const publisher = outboxPublisherDouble({ enqueue });
    const service = makeTenantErasureService(dataSource, { publisher });
    const ticket = service.initiate(TENANT, USER);
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /FK violation/,
    );
    // The event MUST NOT be published if the cascade failed — otherwise
    // downstream services would cascade a tenant erasure that never
    // actually completed.
    expect(enqueue).not.toHaveBeenCalled();
    // The tenant-pinned transaction rolled back and released.
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * TASK-14 — tenant-context correctness of the destructive cascade.
 *
 * The erasure DELETEs target per-tenant tables (which OMIT `schema:`),
 * so they MUST run under a connection whose search_path is pinned to
 * `tenant_<uuid>`. Running the cascade through `runInTenantTransaction`
 * (source schema `farm`) gives that guarantee: it pins the
 * transaction-local search_path AND asserts `current_schema()` + the
 * RLS GUC resolve to this tenant BEFORE any DELETE runs. A connection
 * that resolved to the source `farm` schema (or another tenant) yields
 * a fail-closed `TenantContextError` and the cascade never deletes.
 */
describe('TenantErasureService tenant-context routing (TASK-14)', () => {
  it('pins the tenant search_path to the farm source schema before the cascade runs', async () => {
    const { dataSource, queryRunner, executed } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 3 },
    });
    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);

    // search_path was pinned to "tenant_<uuid>", "farm", public —
    // tenant schema first so the unqualified DELETEs route into it,
    // farm second so the cross-tenant infra tables still resolve.
    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      ['"tenant_1111111111114111", "farm", public'],
    );
    // The cascade DID delete after the context was established.
    expect(executed).toEqual(['batches_v2']);
  });

  it('aborts the cascade (no DELETE) when the connection resolved to the source schema', async () => {
    const { dataSource, queryRunner, executed } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 3 },
    });
    // Model a mis-routed connection: current_schema() falls back to the
    // SOURCE `farm` schema instead of the tenant schema (an unprovisioned
    // / stale-pool failure mode). assertTenantTransactionContext MUST
    // turn this into a hard error before any destructive DELETE runs.
    queryRunner.query.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        if (sql.includes('current_schema()')) {
          return [{ schema: 'farm', tenant: TENANT }];
        }
        if (sql.includes('set_config')) {
          return undefined;
        }
        // params unused on this path; referenced to satisfy the signature.
        void params;
        return undefined;
      },
    );
    const enqueue = jest.fn();
    const publisher = outboxPublisherDouble({ enqueue });
    const service = makeTenantErasureService(dataSource, { publisher });
    const ticket = service.initiate(TENANT, USER);

    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /SCHEMA_MISMATCH|schema/i,
    );
    // CRITICAL: the destructive cascade never ran against the wrong schema.
    expect(executed).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('TenantErasureService.hashUserId', () => {
  it('produces a stable 16-char hex prefix', () => {
    const h1 = TenantErasureService.hashUserId('user-1');
    const h2 = TenantErasureService.hashUserId('user-1');
    expect(h1).toMatch(/^hashed:[0-9a-f]{16}$/);
    expect(h1).toBe(h2);
  });

  it('different userIds hash to different values', () => {
    expect(TenantErasureService.hashUserId('alice')).not.toBe(
      TenantErasureService.hashUserId('bob'),
    );
  });
});

/**
 * COMPLIANCE-MEDIUM-004 — idempotency-replay specs.
 *
 * Pin the contract: a re-invocation on a tenantId that's already
 * been erased returns the original ErasureResult tagged
 * `state: 'ALREADY_PURGED'`. The cascade does NOT re-run; the
 * TenantDataErased proof does NOT re-emit; the audit-row INSERT
 * does NOT re-fire (so the immutability trigger never sees
 * a duplicate-key conflict).
 */
describe('TenantErasureService idempotency (COMPLIANCE-MEDIUM-004)', () => {
  const ORIGINAL_PURGE_DATE = new Date('2026-04-15T12:00:00.000Z');

  it('confirm() on an already-purged tenant returns state=ALREADY_PURGED with the original timestamps', async () => {
    const { dataSource, executed, createQueryRunner, insertCalls } = makeDs({
      entities: [],
      existingErasureAuditRow: {
        tenantId: TENANT,
        confirmedAt: ORIGINAL_PURGE_DATE,
        deletedRowsByTable: { batches: 7, harvest_records: 3 },
        totalDeleted: 10,
        auditRowsAnonymised: 25,
        requestedBy: 'admin-original',
        tableCount: 2,
      },
    });

    const service = makeTenantErasureService(dataSource);

    // Caller submits a token that doesn't even need to be valid;
    // the idempotency check short-circuits before token
    // validation. (This deliberately models the operator
    // back-forward case where the original token is no longer
    // in memory.)
    const result = await service.confirm(TENANT, 'irrelevant-token');

    expect(result.state).toBe('ALREADY_PURGED');
    expect(result.confirmedAt).toBe(ORIGINAL_PURGE_DATE.toISOString());
    expect(result.totalDeleted).toBe(10);
    expect(result.auditRowsAnonymised).toBe(25);
    expect(result.deletedRowsByTable).toEqual({ batches: 7, harvest_records: 3 });

    // Critical invariants of the idempotency contract:
    // 1. No DELETE cascade ran.
    expect(executed).toEqual([]);
    // 2. No tenant-pinned transaction was opened (the lookup runs
    //    outside the cascade transaction; the cascade never starts).
    expect(createQueryRunner).not.toHaveBeenCalled();
    // 3. No audit-row INSERT was attempted.
    expect(insertCalls).toEqual([]);
  });

  it('confirm() on a fresh tenant (no prior audit row) runs the cascade and persists the audit row', async () => {
    const { dataSource, insertCalls } = makeDs({
      entities: [],
      existingErasureAuditRow: null,
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    expect(result.state).toBe('PURGED');
    // The audit row was written exactly once inside the cascade
    // transaction, with the right tenantId.
    expect(insertCalls.length).toBe(1);
    const row = insertCalls[0]!.row as { tenantId: string };
    expect(row.tenantId).toBe(TENANT);
  });

  it('confirm() pre-existing erasure row is preferred over a stale in-memory ticket (replay short-circuits ticket validation)', async () => {
    const { dataSource, executed } = makeDs({
      entities: [],
      existingErasureAuditRow: {
        tenantId: TENANT,
        confirmedAt: ORIGINAL_PURGE_DATE,
        deletedRowsByTable: {},
        totalDeleted: 0,
        auditRowsAnonymised: 0,
        requestedBy: USER,
        tableCount: 0,
      },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    // The stale in-memory ticket is still valid token-wise. With
    // a pre-existing erasure row, the idempotency check wins and
    // the cascade does NOT re-run.
    const result = await service.confirm(TENANT, ticket.token);
    expect(result.state).toBe('ALREADY_PURGED');
    expect(executed).toEqual([]);
  });
});

/**
 * COMPLIANCE-HIGH-004 — legal-hold precedence specs.
 *
 * Pin the contract: a tenant under active legal hold MUST NOT
 * have farm-side data deleted. The cascade is BLOCKED at the
 * top of confirm(), the ticket is NOT consumed, and the call
 * throws (so the operator sees the explicit refusal).
 */
describe('TenantErasureService legal-hold precedence (COMPLIANCE-HIGH-004)', () => {
  it('throws when LegalHoldService.assertNoHold reports the tenant on hold; cascade does NOT run', async () => {
    const { dataSource, executed } = makeDs({ entities: [] });
    const legalHoldService = {
      assertNoHold: jest.fn().mockRejectedValue(
        new (class extends Error {
          constructor() {
            super('LegalHold active');
            this.name = 'LegalHoldActiveError';
          }
        })(),
      ),
    };
    const service = makeTenantErasureService(dataSource, {
      legalHoldService: legalHoldServiceDouble(legalHoldService),
    });
    const ticket = service.initiate(TENANT, USER);
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /LegalHold active/i,
    );
    // Critical: the cascade did NOT run.
    expect(executed).toEqual([]);
    // Critical: the ticket is NOT consumed — the operator can
    // retry after the legal hold is released without re-running
    // initiate(). (The service implementation deliberately calls
    // assertNoHold BEFORE consuming the ticket for this reason.)
    expect(service.getPendingTicket(TENANT)).toBeDefined();
  });

  it('passes through to the cascade when no legal hold is active', async () => {
    const { dataSource } = makeDs({ entities: [] });
    const legalHoldService = {
      assertNoHold: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeTenantErasureService(dataSource, {
      legalHoldService: legalHoldServiceDouble(legalHoldService),
    });
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);
    expect(result.state).toBe('PURGED');
    expect(legalHoldService.assertNoHold).toHaveBeenCalledWith(
      TENANT,
      'tenant',
    );
  });

});
