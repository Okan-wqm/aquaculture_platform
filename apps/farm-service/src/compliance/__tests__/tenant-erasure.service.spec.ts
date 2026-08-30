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
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import type { LegalHoldService } from '@aquaculture/backend-common/compliance';
import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';
import { createBaseEvent, type TenantErasureRequestedEvent } from '@platform/event-contracts';
import type { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { TenantErasureService } from '../services/tenant-erasure.service';

interface EntityMetadataDouble {
  tableName: string;
  target: unknown;
  columns: Array<{ propertyName: string; databaseName: string }>;
  foreignKeys: Array<{ referencedTablePath: string }>;
}

interface LiveTenantTableDouble {
  readonly tableName: string;
  readonly tenantColumn: string;
}

interface LiveForeignKeyDouble {
  readonly childTable: string;
  readonly parentTable: string;
}

const FARM_TENANT_TABLES = new Set(
  MODULE_SCHEMAS.find((entry) => entry.moduleName === 'farm')?.tables ?? [],
);

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
  jest.spyOn(instance, 'createQueryBuilder').mockImplementation(dataSource.createQueryBuilder);
  jest.spyOn(instance, 'createQueryRunner').mockImplementation(dataSource.createQueryRunner);
  jest.spyOn(instance, 'query').mockImplementation(dataSource.query);
  return instance;
}

function outboxPublisherDouble(publisher: Pick<OutboxPublisher, 'enqueue'>): OutboxPublisher {
  return publisher as OutboxPublisher;
}

function legalHoldServiceDouble(service: Pick<LegalHoldService, 'assertNoHold'>): LegalHoldService {
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
  liveTenantTables?: readonly LiveTenantTableDouble[];
  liveForeignKeys?: readonly LiveForeignKeyDouble[];
  matchedResults?: Record<string, number>;
  deleteResults?: Record<string, number>;
  auditAnonAffected?: number;
  /**
   * COMPLIANCE-HIGH-003: affected-row count returned by the
   * retention-anonymise UPDATE per statutory-retention table
   * (regulatory_reports, biomass_reports). The matched count for those
   * tables comes from `deleteResults` (they route through the same
   * COUNT(*) path); this map drives how many of those matched rows had a
   * PII column hashed.
   */
  retentionAnonAffected?: Record<string, number>;
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
    retainedRowsByTable?: Record<string, number>;
    retainedRowsAnonymised?: number;
  } | null;
  storedProofRow?: {
    operationId: string;
    tenantId: string;
    eventId: string;
    proofHash: string;
    erasedAt: Date | string;
    dryRun: boolean;
    matchedRecordCount: number | string;
    erasedRecordCount: number | string;
  } | null;
}) {
  const executed: string[] = [];
  // COMPLIANCE-HIGH-003: statutory-retention tables that were routed
  // through the retention-anonymise UPDATE (retained, NOT deleted).
  const retentionAnonymised: string[] = [];
  const deleteAffected = (table: string): number => opts.deleteResults?.[table] ?? 0;
  const matchedRows = (table: string): number =>
    opts.matchedResults?.[table] ?? deleteAffected(table);
  const auditQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      affected: opts.auditAnonAffected ?? 0,
    }),
  };
  // The retention-anonymise UPDATE builder (update(EntityClass) — a
  // per-tenant statutory-retention table). Distinct from auditQb so its
  // affected count is driven independently and the routing is asserted.
  let retentionTargetTable: string | undefined;
  const retentionQb = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockImplementation(async () => ({
      affected: opts.retentionAnonAffected?.[retentionTargetTable ?? ''] ?? 0,
    })),
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
      const count = matchedRows(countTable ?? '');
      countMode = false;
      countTable = undefined;
      return { count: String(count) };
    }),
    execute: jest.fn().mockImplementation(async () => {
      if (opts.deleteError) throw opts.deleteError;
      const last = executed[executed.length - 1] ?? '';
      return { affected: deleteAffected(last) };
    }),
    update: jest.fn().mockImplementation((tableOrTarget: unknown) => {
      // The audit anonymise path passes the schema-qualified string
      // 'farm.farm_audit_logs'; the retention anonymise path passes the
      // per-tenant EntityMetadata `target` (a class). Route each to its
      // own builder so their affected counts stay independent.
      if (typeof tableOrTarget === 'string') {
        auditQb.update(tableOrTarget);
        return auditQb;
      }
      const meta = opts.entities.find((e) => e.target === tableOrTarget);
      retentionTargetTable = meta?.tableName;
      if (meta) {
        retentionAnonymised.push(meta.tableName);
      }
      return retentionQb;
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
  const liveTenantTables =
    opts.liveTenantTables ??
    opts.entities
      .filter(
        (entity) =>
          FARM_TENANT_TABLES.has(entity.tableName) &&
          entity.columns.some((column) => column.propertyName === 'tenantId'),
      )
      .map((entity) => ({
        tableName: entity.tableName,
        tenantColumn: entity.columns.find((column) => column.propertyName === 'tenantId')!
          .databaseName,
      }));
  const liveForeignKeys =
    opts.liveForeignKeys ??
    opts.entities.flatMap((entity) =>
      entity.foreignKeys.map((foreignKey) => ({
        childTable: entity.tableName,
        parentTable: foreignKey.referencedTablePath,
      })),
    );
  const managerDouble = {
    createQueryBuilder,
    queryRunner: { isTransactionActive: true },
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM pg_catalog.pg_class AS table_relation')) {
        return liveTenantTables.map((table) => ({
          table_name: table.tableName,
          tenant_column: table.tenantColumn,
        }));
      }
      if (sql.includes('FROM pg_catalog.pg_constraint AS foreign_key')) {
        return liveForeignKeys.map((foreignKey) => ({
          child_table: foreignKey.childTable,
          parent_table: foreignKey.parentTable,
        }));
      }
      if (sql.includes('tenant_erasure_target_proofs') && sql.includes('SELECT')) {
        return opts.storedProofRow ? [opts.storedProofRow] : [];
      }
      if (sql.includes('farm_audit_logs')) {
        return [{ count: String(opts.auditAnonAffected ?? 0) }];
      }
      if (sql.includes('COUNT(*)::text AS count')) {
        return [{ count: '0' }];
      }
      return [];
    }),
    insert: jest.fn().mockImplementation(async (entity: unknown, row: unknown) => {
      insertCalls.push({ entity, row });
      return { identifiers: [], generatedMaps: [], raw: [] };
    }),
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
  const queryRunnerQuery = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
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
      return [{ schema: pinnedTenantSchema, tenant: pinnedTenant, bypass: 'off' }];
    }
    return undefined;
  });
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
    if (sql.includes('tenant_erasure_target_proofs')) {
      return opts.storedProofRow ? [opts.storedProofRow] : [];
    }
    if (sql.includes('tenant_erasure_audit')) {
      if (!existingRow) return [];
      // Production rows always carry the COMPLIANCE-HIGH-003 retention
      // columns (migration DEFAULTs them). Default them here so fixtures
      // that predate the columns still reconstruct without NaN, while a
      // fixture may override them to exercise the retained-replay path.
      return [{ retainedRowsByTable: {}, retainedRowsAnonymised: 0, ...existingRow }];
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
    retentionAnonymised,
    qb,
    auditQb,
    retentionQb,
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

function orchestratedRequest(dryRun: boolean): TenantErasureRequestedEvent {
  return {
    ...createBaseEvent<TenantErasureRequestedEvent>('TenantErasureRequested', TENANT, {
      aggregateId: TENANT,
      aggregateType: 'Tenant',
      userId: USER,
    }),
    operationId: '33333333-3333-4333-8333-333333333333',
    requestedBy: USER,
    requestedAt: '2026-07-31T10:00:00.000Z',
    legalHoldCheckedAt: '2026-07-31T10:00:01.000Z',
    dryRun,
    targetServiceCount: 12,
  };
}

function tenantEntityDouble(
  tableName: string,
  options: {
    tenantColumn?: string;
    parents?: readonly string[];
  } = {},
): EntityMetadataDouble {
  return {
    tableName,
    target: class TenantEntityDouble {},
    columns: [
      {
        propertyName: 'tenantId',
        databaseName: options.tenantColumn ?? 'tenantId',
      },
    ],
    foreignKeys: (options.parents ?? []).map((referencedTablePath) => ({
      referencedTablePath,
    })),
  };
}

describe('TenantErasureService ticket flow', () => {
  it('keeps structured logs and admission errors free of authority identifiers', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { dataSource } = makeDs({
      entities: [tenantEntityDouble('batches_v2')],
      deleteResults: { batches_v2: 1 },
    });
    const service = makeTenantErasureService(dataSource);

    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(TENANT);
    expect(logged).not.toContain(TENANT.replaceAll('-', '').slice(0, 16));
    expect(logged).not.toContain(USER);
    expect(logged).not.toContain(ticket.operationId);
    expect(logged).not.toContain(ticket.token);
    for (const [message] of warn.mock.calls) {
      const record = JSON.parse(String(message)) as Record<string, unknown>;
      expect(record).toHaveProperty('event');
      expect(record).toHaveProperty('action');
      expect(record).toHaveProperty('outcome');
    }

    let missingTicketMessage = '';
    try {
      await service.confirm(OTHER_TENANT, 'not-a-ticket');
    } catch (error) {
      missingTicketMessage = error instanceof Error ? error.message : String(error);
    }
    expect(missingTicketMessage).not.toContain(OTHER_TENANT);

    const expiringTicket = service.initiate(OTHER_TENANT, USER);
    const pending = service.getPendingTicket(OTHER_TENANT);
    if (pending) pending.expiresAt = new Date(Date.now() - 1_000);
    let expiredMessage = '';
    try {
      await service.confirm(OTHER_TENANT, expiringTicket.token);
    } catch (error) {
      expiredMessage = error instanceof Error ? error.message : String(error);
    }
    expect(expiredMessage).not.toContain(OTHER_TENANT);
    expect(expiredMessage).not.toContain(expiringTicket.expiresAt.toISOString());

    warn.mockRestore();
  });

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
    await expect(service.confirm(TENANT, 'x')).rejects.toThrow(NotFoundException);
  });

  it('confirm with a wrong token rejects with BadRequestException', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    service.initiate(TENANT, USER);
    await expect(service.confirm(TENANT, 'not-the-token')).rejects.toThrow(/token does not match/i);
  });

  it('confirm with a wrong tenant rejects (no ticket for that tenant)', async () => {
    const { dataSource } = makeDs({ entities: [] });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await expect(service.confirm(OTHER_TENANT, ticket.token)).rejects.toThrow(NotFoundException);
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
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(/expired/i);
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
          tableName: 'batches_v2',
          target: class Example {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 3 },
      auditAnonAffected: 0,
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    expect(service.getPendingTicket(TENANT)).toBeUndefined();
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(NotFoundException);
  });
});

describe('TenantErasureService DELETE cascade', () => {
  it('skips farm_audit_logs from DELETE and anonymises its userId instead', async () => {
    const { dataSource, executed, auditQb } = makeDs({
      entities: [
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
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

  it('uses the live FK graph so child tables delete before parents', async () => {
    const { dataSource, executed } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Parent {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'batch_documents',
          target: class Child {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [{ referencedTablePath: 'batches_v2' }],
        },
      ],
      deleteResults: { batch_documents: 2, batches_v2: 1 },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    expect(executed).toEqual(['batch_documents', 'batches_v2']);
  });

  it('derives a complete three-level child-first order from pg_catalog', async () => {
    const entities = [
      tenantEntityDouble('sites'),
      tenantEntityDouble('batches_v2'),
      tenantEntityDouble('batch_documents'),
    ];
    const { dataSource, executed } = makeDs({
      entities,
      liveForeignKeys: [
        { childTable: 'batch_documents', parentTable: 'batches_v2' },
        { childTable: 'batches_v2', parentTable: 'sites' },
      ],
      deleteResults: { batch_documents: 1, batches_v2: 1, sites: 1 },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);

    expect(executed).toEqual(['batch_documents', 'batches_v2', 'sites']);
  });

  it('fails before every DELETE when pg_catalog exposes an undeclared tenant table', async () => {
    const { dataSource, executed, queryRunner } = makeDs({
      entities: [tenantEntityDouble('batches_v2')],
      liveTenantTables: [
        { tableName: 'batches_v2', tenantColumn: 'tenantId' },
        { tableName: 'rogue_environment_rows', tenantColumn: 'tenant_id' },
      ],
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);

    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /undeclared tenant-bearing table/,
    );
    expect(executed).toEqual([]);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('rejects a cross-table FK cycle before every DELETE', async () => {
    const { dataSource, executed, queryRunner } = makeDs({
      entities: [tenantEntityDouble('batch_documents'), tenantEntityDouble('batches_v2')],
      liveForeignKeys: [
        { childTable: 'batch_documents', parentTable: 'batches_v2' },
        { childTable: 'batches_v2', parentTable: 'batch_documents' },
      ],
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);

    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /FK topology contains a cycle/,
    );
    expect(executed).toEqual([]);
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rolls back when the affected-row proof does not equal the matched inventory', async () => {
    const { dataSource, queryRunner } = makeDs({
      entities: [tenantEntityDouble('batches_v2')],
      matchedResults: { batches_v2: 2 },
      deleteResults: { batches_v2: 1 },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);

    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /delete proof count mismatch/,
    );
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('includes every canonical environmental table and its physical tenant_id column', async () => {
    const environmentTables = [
      'weather_observations',
      'marine_observations',
      'satellite_scene_observations',
      'satellite_scene_coverage_assessments',
      'site_environment_sync_state',
      'environment_metric_sync_outcomes',
    ] as const;
    const entities = [
      tenantEntityDouble('sites'),
      ...environmentTables.map((tableName) =>
        tenantEntityDouble(tableName, { tenantColumn: 'tenant_id' }),
      ),
    ];
    const deleteResults = Object.fromEntries(
      ['sites', ...environmentTables].map((tableName) => [tableName, 1]),
    );
    const { dataSource, executed, qb } = makeDs({
      entities,
      liveForeignKeys: [
        ...environmentTables.map((childTable) => ({ childTable, parentTable: 'sites' })),
        {
          childTable: 'satellite_scene_coverage_assessments',
          parentTable: 'satellite_scene_observations',
        },
        {
          childTable: 'environment_metric_sync_outcomes',
          parentTable: 'site_environment_sync_state',
        },
      ],
      deleteResults,
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    expect(Object.keys(result.deletedRowsByTable)).toEqual(
      expect.arrayContaining([...environmentTables]),
    );
    expect(executed.indexOf('environment_metric_sync_outcomes')).toBeLessThan(
      executed.indexOf('site_environment_sync_state'),
    );
    expect(executed.indexOf('satellite_scene_coverage_assessments')).toBeLessThan(
      executed.indexOf('satellite_scene_observations'),
    );
    expect(executed.indexOf('satellite_scene_observations')).toBeLessThan(
      executed.indexOf('sites'),
    );
    expect(executed.indexOf('site_environment_sync_state')).toBeLessThan(executed.indexOf('sites'));
    expect(qb.where).toHaveBeenCalledWith('"tenant_id" = :tenantId', {
      tenantId: TENANT,
    });
  });
});

/**
 * COMPLIANCE-HIGH-003 — GDPR Art 17(3)(b) statutory-retention carve-out.
 *
 * Government-filed regulatory records (regulatory_reports,
 * biomass_reports) are legally required records under Norwegian
 * aquaculture law. The erasure cascade MUST NOT hard-delete them — it
 * retains the row and anonymises its operator-identifying columns in
 * place, exactly as farm_audit_logs is treated. These specs pin that
 * contract: the tables are absent from the DELETE set, present in the
 * retention-anonymise set, and the retained accounting flows into the
 * ErasureResult + persisted audit row.
 */
describe('TenantErasureService statutory retention (COMPLIANCE-HIGH-003)', () => {
  const RETENTION_ENTITIES: EntityMetadataDouble[] = [
    {
      tableName: 'regulatory_reports',
      target: class RegulatoryReport {},
      columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
      foreignKeys: [],
    },
    {
      tableName: 'biomass_reports',
      target: class BiomassReport {},
      columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
      foreignKeys: [],
    },
    {
      tableName: 'batches_v2',
      target: class Batch {},
      columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
      foreignKeys: [],
    },
  ];

  it('retains regulatory_reports + biomass_reports (never DELETEs them) and anonymises them instead', async () => {
    const { dataSource, executed, retentionAnonymised, insertCalls } = makeDs({
      entities: RETENTION_ENTITIES,
      deleteResults: {
        batches_v2: 9,
        // matched (encountered) counts for the retained tables
        regulatory_reports: 4,
        biomass_reports: 2,
      },
      retentionAnonAffected: {
        regulatory_reports: 4,
        biomass_reports: 1,
      },
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    // The government-filed tables were NEVER hard-deleted.
    expect(executed).toEqual(['batches_v2']);
    expect(result.deletedRowsByTable).toEqual({ batches_v2: 9 });
    expect(result.totalDeleted).toBe(9);

    // …they were routed through the retention-anonymise UPDATE instead.
    expect(retentionAnonymised.sort()).toEqual(['biomass_reports', 'regulatory_reports']);
    expect(result.retainedRowsByTable).toEqual({
      regulatory_reports: 4,
      biomass_reports: 2,
    });
    expect(result.retainedRowsAnonymised).toBe(5); // 4 + 1

    // matchedRecordCount includes the retained rows (they were matched)
    // but NOT the erasedRecordCount — the gap IS the retained set.
    expect(result.matchedRecordCount).toBe(9 + 4 + 2);

    // The retention outcome is persisted on the durable audit row.
    expect(insertCalls.length).toBe(1);
    const row = insertCalls[0]!.row as {
      retainedRowsByTable: Record<string, number>;
      retainedRowsAnonymised: number;
    };
    expect(row.retainedRowsByTable).toEqual({
      regulatory_reports: 4,
      biomass_reports: 2,
    });
    expect(row.retainedRowsAnonymised).toBe(5);
  });

  it('skips the retention-anonymise UPDATE for a retained table with zero matched rows', async () => {
    const { dataSource, executed, retentionAnonymised, retentionQb } = makeDs({
      entities: RETENTION_ENTITIES,
      deleteResults: { batches_v2: 3 }, // retained tables matched → 0
    });

    const service = makeTenantErasureService(dataSource);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    expect(executed).toEqual(['batches_v2']);
    // No matched rows → no anonymise UPDATE issued, no retained entry.
    expect(retentionAnonymised).toEqual([]);
    expect(retentionQb.execute).not.toHaveBeenCalled();
    expect(result.retainedRowsByTable).toEqual({});
    expect(result.retainedRowsAnonymised).toBe(0);
  });

  it('reconstructs the retained accounting on an ALREADY_PURGED replay', async () => {
    const { dataSource, executed } = makeDs({
      entities: [],
      existingErasureAuditRow: {
        tenantId: TENANT,
        confirmedAt: new Date('2026-05-01T00:00:00.000Z'),
        deletedRowsByTable: { batches_v2: 9 },
        totalDeleted: 9,
        auditRowsAnonymised: 3,
        requestedBy: USER,
        tableCount: 1,
        retainedRowsByTable: { regulatory_reports: 4, biomass_reports: 2 },
        retainedRowsAnonymised: 5,
      },
    });

    const service = makeTenantErasureService(dataSource);
    const result = await service.confirm(TENANT, 'irrelevant-token');

    expect(result.state).toBe('ALREADY_PURGED');
    expect(executed).toEqual([]);
    expect(result.retainedRowsByTable).toEqual({
      regulatory_reports: 4,
      biomass_reports: 2,
    });
    expect(result.retainedRowsAnonymised).toBe(5);
    // matched reconstructs byte-identically: 9 deleted + 3 audit + 6 retained.
    expect(result.matchedRecordCount).toBe(9 + 3 + 6);
  });
});

describe('TenantErasureService TenantDataErased proof emission', () => {
  it('enqueues a TenantDataErased proof on the outbox inside the same transaction', async () => {
    const { dataSource, createQueryRunner, queryRunner } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
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
    expect(event.eventType).toBe('FarmServiceTenantDataErased');
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
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { dataSource, queryRunner } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteError: new Error('PG-23503: FK violation'),
    });
    const enqueue = jest.fn();
    const publisher = outboxPublisherDouble({ enqueue });
    const service = makeTenantErasureService(dataSource, { publisher });
    const ticket = service.initiate(TENANT, USER);
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(/FK violation/);
    // The event MUST NOT be published if the cascade failed — otherwise
    // downstream services would cascade a tenant erasure that never
    // actually completed.
    expect(enqueue).not.toHaveBeenCalled();
    // The tenant-pinned transaction rolled back and released.
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(TENANT);
    expect(logged).not.toContain(USER);
    expect(logged).not.toContain(ticket.operationId);
    expect(logged).not.toContain('PG-23503');
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      event: 'tenant_erasure_delete_failed',
      action: 'delete',
      outcome: 'failed',
      errorType: 'Error',
    });
    errorLog.mockRestore();
  });
});

describe('TenantErasureService orchestrated dry-run semantics', () => {
  it('reports DRY_RUN_COMPLETED while counting rows without deleting or writing an audit row', async () => {
    const { dataSource, executed, insertCalls, qb } = makeDs({
      entities: [
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 7 },
    });
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const service = makeTenantErasureService(dataSource, {
      publisher: outboxPublisherDouble({ enqueue }),
    });

    const result = await service.eraseFromTenantErasureRequest(orchestratedRequest(true));

    expect(result.state).toBe('DRY_RUN_COMPLETED');
    expect(result.matchedRecordCount).toBe(7);
    expect(result.totalDeleted).toBe(0);
    expect(executed).toEqual([]);
    expect(qb.delete).not.toHaveBeenCalled();
    expect(insertCalls).toEqual([]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'FarmServiceTenantDataErased',
        dryRun: true,
        matchedRecordCount: 7,
        erasedRecordCount: 0,
      }),
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: 'tenant-erasure:33333333-3333-4333-8333-333333333333:farm-service',
      }),
    );
  });

  it('reports DRY_RUN_COMPLETED when replaying a valid stored dry-run proof', async () => {
    const request = orchestratedRequest(true);
    const { dataSource, createQueryRunner } = makeDs({
      entities: [],
      storedProofRow: {
        operationId: request.operationId,
        tenantId: TENANT,
        eventId: '44444444-4444-4444-8444-444444444444',
        proofHash: 'sha256:stored-dry-run',
        erasedAt: '2026-07-31T10:00:02.000Z',
        dryRun: true,
        matchedRecordCount: 9,
        erasedRecordCount: 0,
      },
    });
    const service = makeTenantErasureService(dataSource);

    const result = await service.eraseFromTenantErasureRequest(request);

    expect(result.state).toBe('DRY_RUN_COMPLETED');
    expect(result.matchedRecordCount).toBe(9);
    expect(result.totalDeleted).toBe(0);
    expect(createQueryRunner).toHaveBeenCalledTimes(1);
  });

  it('rejects a stored proof whose dry-run mode differs from the recovered request', async () => {
    const request = orchestratedRequest(false);
    const { dataSource, createQueryRunner } = makeDs({
      entities: [],
      storedProofRow: {
        operationId: request.operationId,
        tenantId: TENANT,
        eventId: '44444444-4444-4444-8444-444444444444',
        proofHash: 'sha256:stored-dry-run',
        erasedAt: '2026-07-31T10:00:02.000Z',
        dryRun: true,
        matchedRecordCount: 9,
        erasedRecordCount: 0,
      },
    });
    const service = makeTenantErasureService(dataSource);

    await expect(service.eraseFromTenantErasureRequest(request)).rejects.toThrow(
      'stored proof mode mismatch',
    );
    expect(createQueryRunner).not.toHaveBeenCalled();
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
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
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
          columns: [{ propertyName: 'tenantId', databaseName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 3 },
    });
    // Model a mis-routed connection: current_schema() falls back to the
    // SOURCE `farm` schema instead of the tenant schema (an unprovisioned
    // / stale-pool failure mode). assertTenantTransactionContext MUST
    // turn this into a hard error before any destructive DELETE runs.
    queryRunner.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('current_schema()')) {
        return [{ schema: 'farm', tenant: TENANT, bypass: 'off' }];
      }
      if (sql.includes('set_config')) {
        return undefined;
      }
      // params unused on this path; referenced to satisfy the signature.
      void params;
      return undefined;
    });
    const enqueue = jest.fn();
    const publisher = outboxPublisherDouble({ enqueue });
    const service = makeTenantErasureService(dataSource, { publisher });
    const ticket = service.initiate(TENANT, USER);

    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(/SCHEMA_MISMATCH|schema/i);
    // CRITICAL: the destructive cascade never ran against the wrong schema.
    expect(executed).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('TenantErasureService.hashUserId', () => {
  it('produces a stable UUID pseudonym compatible with UUID audit columns', () => {
    const h1 = TenantErasureService.hashUserId('user-1');
    const h2 = TenantErasureService.hashUserId('user-1');
    expect(h1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(/LegalHold active/i);
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
    expect(legalHoldService.assertNoHold).toHaveBeenCalledWith(TENANT, 'tenant');
  });
});
