import { createHash } from 'crypto';

import { Logger } from '@nestjs/common';
import {
  createBaseEvent,
  TenantDataErasedEvent,
  TenantDataErasureFailedEvent,
  TenantErasureBlockedEvent,
  TenantErasureRequestedEvent,
  type TenantErasureTargetService,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, EntityManager } from 'typeorm';

import { queryRowCountNormalized, queryRowsNormalized } from '../../database/query-result-normalizer';
import { MODULE_SCHEMAS } from '../../database/schema-manager.service';
import { validateSqlIdentifier } from '../../database/sql-identifier.util';
import { getTenantSchemaName } from '../../database/tenant-schema.utils';
import { LegalHoldActiveError, LegalHoldService } from '../legal-hold';

export type TenantErasureTargetMode =
  | 'tenant-schema-module'
  | 'source-schema-tenant-column';

/**
 * Optional per-service post-erasure extension point.
 *
 * WHY: some erasure targets hold tenant data that table deletion cannot reach
 * (e.g. event-store's immutable `stored_events` log, whose GDPR treatment is a
 * per-tenant crypto-shred). Hooks run INSIDE the erasure transaction, after
 * every table deletion succeeded and before the success proof is recorded and
 * enqueued — so a hook failure aborts the erasure exactly like a table-deletion
 * failure (fail-closed: TenantDataErasureFailed, no proof).
 */
export interface TenantErasurePostErasureHook {
  /**
   * Stable identifier folded into the erasure proof hash so the proof attests
   * which hooks completed as part of the operation.
   */
  readonly hookName: string;
  /**
   * MUST be idempotent (erasure retries re-invoke it) and MUST reject on
   * failure. Receives the transaction EntityManager so hooks that write can
   * commit atomically with the erasure; hooks with their own persistence (e.g.
   * an idempotent crypto-shred) may ignore it.
   */
  onTenantErased(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<void>;
}

export interface TenantErasureTargetExecutorOptions {
  readonly targetService: TenantErasureTargetService;
  readonly moduleName: string;
  readonly sourceSchema: string;
  readonly mode: TenantErasureTargetMode;
  readonly excludedTables?: readonly string[];
  readonly outbox: {
    readonly schema: string;
    readonly table: string;
  };
  readonly proofLedger: {
    readonly schema: string;
    readonly table: string;
  };
}

export interface TenantErasureTargetExecutorDependencies {
  readonly dataSource: DataSource;
  readonly outboxPublisher: OutboxPublisher;
  readonly legalHoldService: LegalHoldService;
  readonly logger?: Logger;
  /**
   * Post-erasure hooks for tenant data that table deletion cannot reach
   * (see TenantErasurePostErasureHook). Empty for most services.
   */
  readonly postErasureHooks?: readonly TenantErasurePostErasureHook[];
}

export interface TenantErasureTargetResult {
  readonly state: 'PURGED' | 'ALREADY_PURGED' | 'BLOCKED' | 'FAILED';
  readonly tenantId: string;
  readonly operationId: string;
  readonly targetService: TenantErasureTargetService;
  readonly matchedRecordCount: number;
  readonly erasedRecordCount: number;
}

interface CountRow {
  readonly count: string;
}

interface ForeignKeyRow {
  readonly table_name: string;
  readonly referenced_table_name: string;
}

interface TenantColumnRow {
  readonly table_name: string;
  readonly column_name: string;
}

interface TableDeleteResult {
  readonly tableName: string;
  readonly matchedCount: number;
  readonly erasedCount: number;
}

interface TenantErasureStoredProofRow {
  readonly operationId: string;
  readonly tenantId: string;
  readonly targetService: string;
  readonly eventId: string;
  readonly proofHash: string;
  readonly erasedAt: Date | string;
  readonly dryRun: boolean;
  readonly matchedRecordCount: number | string;
  readonly erasedRecordCount: number | string;
}

interface Queryable {
  query(query: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export class TenantErasureTargetExecutor {
  private readonly logger: Logger;

  constructor(
    private readonly deps: TenantErasureTargetExecutorDependencies,
    private readonly options: TenantErasureTargetExecutorOptions,
  ) {
    this.logger =
      deps.logger ??
      new Logger(`TenantErasureTargetExecutor:${options.targetService}`);
  }

  async eraseFromRequest(
    event: TenantErasureRequestedEvent,
  ): Promise<TenantErasureTargetResult> {
    const idempotencyKey = this.idempotencyKey(event.operationId);
    const existingProof = await this.readExistingProof(event, this.deps.dataSource);
    if (existingProof) {
      this.logger.warn(
        `Tenant erasure proof already exists for operation=${event.operationId} target=${this.options.targetService}`,
      );
      return this.replayStoredProof(event, existingProof, idempotencyKey);
    }

    try {
      await this.deps.legalHoldService.assertNoHold(event.tenantId, 'tenant');
    } catch (error) {
      if (error instanceof LegalHoldActiveError) {
        await this.emitBlocked(event, error);
        return {
          state: 'BLOCKED',
          tenantId: event.tenantId,
          operationId: event.operationId,
          targetService: this.options.targetService,
          matchedRecordCount: 0,
          erasedRecordCount: 0,
        };
      }
      await this.emitFailure(event, error, true);
      return {
        state: 'FAILED',
        tenantId: event.tenantId,
        operationId: event.operationId,
        targetService: this.options.targetService,
        matchedRecordCount: 0,
        erasedRecordCount: 0,
      };
    }

    try {
      return await this.deps.dataSource.transaction(async (manager) => {
        await this.lockOperation(manager, event);
        const proofAfterLock = await this.readExistingProof(event, manager);
        if (proofAfterLock) {
          return this.replayStoredProofInTransaction(
            manager,
            event,
            proofAfterLock,
            idempotencyKey,
          );
        }

        const tableResults =
          this.options.mode === 'tenant-schema-module'
            ? await this.eraseTenantSchemaModule(event, manager)
            : await this.eraseSourceSchemaRows(event, manager);
        const matchedRecordCount = tableResults.reduce(
          (sum, item) => sum + item.matchedCount,
          0,
        );
        const erasedRecordCount = tableResults.reduce(
          (sum, item) => sum + item.erasedCount,
          0,
        );
        // Post-erasure hooks run after every table deletion succeeded and
        // before the proof exists: a hook throw rolls the transaction back and
        // falls through to the emitFailure path below, so the erasure can never
        // report success while non-deletable tenant data (e.g. stored_events
        // ciphertext) is still recoverable.
        const executedHooks = await this.runPostErasureHooks(event, manager);
        const erasedAt = new Date().toISOString();
        const proofHash = this.createProofHash({
          event,
          erasedAt,
          matchedRecordCount,
          erasedRecordCount,
          tableResults,
          executedHooks,
        });

        const proofEvent: TenantDataErasedEvent = {
          ...createBaseEvent<TenantDataErasedEvent>('TenantDataErased', event.tenantId, {
            aggregateId: event.tenantId,
            aggregateType: 'Tenant',
          }),
          timestamp: erasedAt,
          userId: event.requestedBy,
          operationId: event.operationId,
          targetService: this.options.targetService,
          erasedAt,
          dryRun: event.dryRun,
          matchedRecordCount,
          erasedRecordCount,
          proofHash,
        };

        await this.recordProofLedger(manager, proofEvent);
        await this.deps.outboxPublisher.enqueue(proofEvent, manager, {
          aggregateId: event.tenantId,
          idempotencyKey,
        });

        return {
          state: 'PURGED' as const,
          tenantId: event.tenantId,
          operationId: event.operationId,
          targetService: this.options.targetService,
          matchedRecordCount,
          erasedRecordCount,
        };
      });
    } catch (error) {
      await this.emitFailure(event, error, true);
      return {
        state: 'FAILED',
        tenantId: event.tenantId,
        operationId: event.operationId,
        targetService: this.options.targetService,
        matchedRecordCount: 0,
        erasedRecordCount: 0,
      };
    }
  }

  /**
   * Runs the registered post-erasure hooks sequentially, returning the names of
   * the hooks that completed (folded into the proof hash).
   *
   * WHY dry runs skip hooks entirely: hooks are destructive by contract (the
   * canonical hook crypto-shreds a tenant key). A dry run must count what an
   * erasure WOULD remove without destroying anything, so the executor — not
   * each hook author — guarantees no hook ever fires under dryRun.
   */
  private async runPostErasureHooks(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<readonly string[]> {
    const hooks = this.deps.postErasureHooks ?? [];
    if (hooks.length === 0) {
      return [];
    }
    if (event.dryRun) {
      this.logger.log(
        `Dry run: skipping ${hooks.length} post-erasure hook(s) for operation=${event.operationId}`,
      );
      return [];
    }
    const executed: string[] = [];
    for (const hook of hooks) {
      await hook.onTenantErased(event, manager);
      executed.push(hook.hookName);
    }
    return executed;
  }

  private async eraseTenantSchemaModule(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<readonly TableDeleteResult[]> {
    const moduleSchema = MODULE_SCHEMAS.find(
      (entry) => entry.moduleName === this.options.moduleName,
    );
    if (!moduleSchema) {
      throw new Error(
        `Tenant erasure target ${this.options.targetService} has no MODULE_SCHEMAS entry for ${this.options.moduleName}`,
      );
    }

    const tenantSchema = validateSqlIdentifier(
      getTenantSchemaName(event.tenantId),
      'schema',
    );
    const tables = moduleSchema.tables.map((table) =>
      validateSqlIdentifier(table, 'table'),
    );
    const existingTables = await this.existingTables(manager, tenantSchema, tables);
    const sortedTables = await this.sortedTablesForDelete(
      manager,
      tenantSchema,
      existingTables,
    );

    const results: TableDeleteResult[] = [];
    for (const tableName of sortedTables) {
      results.push(
        await this.deleteWholeTable(manager, tenantSchema, tableName, event.dryRun),
      );
    }
    return results;
  }

  private async eraseSourceSchemaRows(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<readonly TableDeleteResult[]> {
    const moduleSchema = MODULE_SCHEMAS.find(
      (entry) => entry.moduleName === this.options.moduleName,
    );
    if (!moduleSchema) {
      throw new Error(
        `Tenant erasure target ${this.options.targetService} has no MODULE_SCHEMAS entry for ${this.options.moduleName}`,
      );
    }

    const sourceSchema = validateSqlIdentifier(this.options.sourceSchema, 'schema');
    const excludedTables = new Set(this.options.excludedTables ?? []);
    const candidateTables = [
      ...moduleSchema.tables,
      ...(moduleSchema.infrastructureTables ?? []),
    ]
      .filter((table) => !excludedTables.has(table))
      .map((table) => validateSqlIdentifier(table, 'table'));
    const tenantColumns = await this.tenantColumns(manager, sourceSchema, candidateTables);
    const targetTables = Array.from(tenantColumns.keys()).sort();
    const sortedTables = await this.sortedTablesForDelete(
      manager,
      sourceSchema,
      targetTables,
    );

    const results: TableDeleteResult[] = [];
    for (const tableName of sortedTables) {
      const tenantColumn = tenantColumns.get(tableName);
      if (!tenantColumn) {
        continue;
      }
      results.push(
        await this.deleteTenantColumnRows(
          manager,
          sourceSchema,
          tableName,
          tenantColumn,
          event.tenantId,
          event.dryRun,
        ),
      );
    }
    return results;
  }

  private async existingTables(
    manager: EntityManager,
    schemaName: string,
    tableNames: readonly string[],
  ): Promise<readonly string[]> {
    if (tableNames.length === 0) {
      return [];
    }
    const rows = queryRowsNormalized<{ table_name: string }>(
      await manager.query(
        `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])
            AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `,
        [schemaName, tableNames],
      ),
    );
    return rows.map((row) => row.table_name);
  }

  private async tenantColumns(
    manager: EntityManager,
    schemaName: string,
    tableNames: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    if (tableNames.length === 0) {
      return new Map();
    }
    const rows = queryRowsNormalized<TenantColumnRow>(
      await manager.query(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])
            AND column_name IN ('tenantId', 'tenant_id')
          ORDER BY table_name, column_name
        `,
        [schemaName, tableNames],
      ),
    );
    const byTable = new Map<string, string>();
    for (const row of rows) {
      const prior = byTable.get(row.table_name);
      if (!prior || row.column_name === 'tenantId') {
        byTable.set(row.table_name, row.column_name);
      }
    }
    return byTable;
  }

  private async sortedTablesForDelete(
    manager: EntityManager,
    schemaName: string,
    tableNames: readonly string[],
  ): Promise<readonly string[]> {
    if (tableNames.length <= 1) {
      return tableNames;
    }
    const fkRows = queryRowsNormalized<ForeignKeyRow>(
      await manager.query(
        `
          SELECT
            tc.table_name,
            ccu.table_name AS referenced_table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = ANY($2::text[])
            AND ccu.table_schema = $1
            AND ccu.table_name = ANY($2::text[])
          ORDER BY tc.table_name, ccu.table_name
        `,
        [schemaName, tableNames],
      ),
    );

    const nodes = [...tableNames].sort();
    const outgoing = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    for (const node of nodes) {
      outgoing.set(node, new Set());
      indegree.set(node, 0);
    }
    for (const row of fkRows) {
      const child = row.table_name;
      const parent = row.referenced_table_name;
      const edges = outgoing.get(child);
      if (!edges || !indegree.has(parent) || edges.has(parent)) {
        continue;
      }
      edges.add(parent);
      indegree.set(parent, (indegree.get(parent) ?? 0) + 1);
    }

    const queue = nodes.filter((node) => (indegree.get(node) ?? 0) === 0);
    const sorted: string[] = [];
    while (queue.length > 0) {
      queue.sort();
      const node = queue.shift();
      if (!node) {
        break;
      }
      sorted.push(node);
      const parents = outgoing.get(node) ?? new Set<string>();
      for (const parent of parents) {
        const next = (indegree.get(parent) ?? 0) - 1;
        indegree.set(parent, next);
        if (next === 0) {
          queue.push(parent);
        }
      }
    }

    if (sorted.length !== nodes.length) {
      const cycleTables = nodes.filter((node) => !sorted.includes(node));
      throw new Error(
        `Tenant erasure cannot derive FK-safe delete order for ${schemaName}: ${cycleTables.join(', ')}`,
      );
    }

    return sorted;
  }

  private async deleteWholeTable(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    dryRun: boolean,
  ): Promise<TableDeleteResult> {
    const matchedCount = await this.countRows(
      manager,
      schemaName,
      tableName,
      undefined,
      undefined,
    );
    const erasedCount = dryRun
      ? 0
      : await this.deleteRows(manager, schemaName, tableName, undefined, undefined);
    return { tableName, matchedCount, erasedCount };
  }

  private async deleteTenantColumnRows(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    tenantColumn: string,
    tenantId: string,
    dryRun: boolean,
  ): Promise<TableDeleteResult> {
    const matchedCount = await this.countRows(
      manager,
      schemaName,
      tableName,
      tenantColumn,
      tenantId,
    );
    const erasedCount = dryRun
      ? 0
      : await this.deleteRows(manager, schemaName, tableName, tenantColumn, tenantId);
    return { tableName, matchedCount, erasedCount };
  }

  private async countRows(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    tenantColumn: string | undefined,
    tenantId: string | undefined,
  ): Promise<number> {
    const where = tenantColumn ? ` WHERE "${tenantColumn}" = $1` : '';
    const params = tenantColumn ? [tenantId] : [];
    const rows = queryRowsNormalized<CountRow>(
      await manager.query(
        `SELECT COUNT(*)::text AS count FROM "${schemaName}"."${tableName}"${where}`,
        params,
      ),
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  private async deleteRows(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    tenantColumn: string | undefined,
    tenantId: string | undefined,
  ): Promise<number> {
    const where = tenantColumn ? ` WHERE "${tenantColumn}" = $1` : '';
    const params = tenantColumn ? [tenantId] : [];
    return queryRowCountNormalized(
      await manager.query(
        `DELETE FROM "${schemaName}"."${tableName}"${where}`,
        params,
      ),
    );
  }

  private async readExistingProof(
    event: TenantErasureRequestedEvent,
    queryable: Queryable,
  ): Promise<TenantErasureStoredProofRow | null> {
    const schemaName = validateSqlIdentifier(
      this.options.proofLedger.schema,
      'schema',
    );
    const tableName = validateSqlIdentifier(
      this.options.proofLedger.table,
      'table',
    );
    const rows = queryRowsNormalized<TenantErasureStoredProofRow>(
      await queryable.query(
        `
          SELECT
            "operationId",
            "tenantId",
            "targetService",
            "eventId",
            "proofHash",
            "erasedAt",
            "dryRun",
            "matchedRecordCount",
            "erasedRecordCount"
          FROM "${schemaName}"."${tableName}"
          WHERE "tenantId" = $1
            AND "operationId" = $2
            AND "targetService" = $3
          LIMIT 1
        `,
        [event.tenantId, event.operationId, this.options.targetService],
      ),
    );
    return rows[0] ?? null;
  }

  private async replayStoredProof(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
    idempotencyKey: string,
  ): Promise<TenantErasureTargetResult> {
    return this.deps.dataSource.transaction((manager) =>
      this.replayStoredProofInTransaction(
        manager,
        event,
        storedProof,
        idempotencyKey,
      ),
    );
  }

  private async replayStoredProofInTransaction(
    manager: EntityManager,
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
    idempotencyKey: string,
  ): Promise<TenantErasureTargetResult> {
    const matchedRecordCount = this.numberFromRow(
      storedProof.matchedRecordCount,
      'matchedRecordCount',
    );
    const erasedRecordCount = this.numberFromRow(
      storedProof.erasedRecordCount,
      'erasedRecordCount',
    );
    const alreadyQueued = await this.hasOutboxRow(
      manager,
      event.tenantId,
      idempotencyKey,
    );
    if (!alreadyQueued) {
      await this.deps.outboxPublisher.enqueue(
        this.storedProofToEvent(event, storedProof),
        manager,
        {
          aggregateId: event.tenantId,
          idempotencyKey,
        },
      );
    }
    return {
      state: 'ALREADY_PURGED',
      tenantId: event.tenantId,
      operationId: event.operationId,
      targetService: this.options.targetService,
      matchedRecordCount,
      erasedRecordCount,
    };
  }

  private storedProofToEvent(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
  ): TenantDataErasedEvent {
    const erasedAt = this.isoFromRow(storedProof.erasedAt);
    return {
      eventId: storedProof.eventId as TenantDataErasedEvent['eventId'],
      eventType: 'TenantDataErased',
      timestamp: erasedAt,
      tenantId: event.tenantId,
      version: 1,
      aggregateId: event.tenantId,
      aggregateType: 'Tenant',
      userId: event.requestedBy,
      operationId: event.operationId,
      targetService: this.options.targetService,
      erasedAt,
      dryRun: storedProof.dryRun,
      matchedRecordCount: this.numberFromRow(
        storedProof.matchedRecordCount,
        'matchedRecordCount',
      ),
      erasedRecordCount: this.numberFromRow(
        storedProof.erasedRecordCount,
        'erasedRecordCount',
      ),
      proofHash: storedProof.proofHash,
    };
  }

  private async recordProofLedger(
    manager: EntityManager,
    event: TenantDataErasedEvent,
  ): Promise<void> {
    const schemaName = validateSqlIdentifier(
      this.options.proofLedger.schema,
      'schema',
    );
    const tableName = validateSqlIdentifier(
      this.options.proofLedger.table,
      'table',
    );
    await manager.query(
      `
        INSERT INTO "${schemaName}"."${tableName}" (
          "operationId",
          "tenantId",
          "targetService",
          "eventId",
          "proofHash",
          "erasedAt",
          "dryRun",
          "matchedRecordCount",
          "erasedRecordCount"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT ("operationId", "targetService") DO NOTHING
      `,
      [
        event.operationId,
        event.tenantId,
        event.targetService,
        event.eventId,
        event.proofHash,
        event.erasedAt,
        event.dryRun,
        event.matchedRecordCount,
        event.erasedRecordCount,
      ],
    );
  }

  private async hasOutboxRow(
    manager: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const schemaName = validateSqlIdentifier(this.options.outbox.schema, 'schema');
    const tableName = validateSqlIdentifier(this.options.outbox.table, 'table');
    const rows = queryRowsNormalized<CountRow>(
      await manager.query(
        `
          SELECT COUNT(*)::text AS count
          FROM "${schemaName}"."${tableName}"
          WHERE "tenantId" = $1
            AND "idempotencyKey" = $2
        `,
        [tenantId, idempotencyKey],
      ),
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10) > 0;
  }

  private async lockOperation(
    manager: EntityManager,
    event: TenantErasureRequestedEvent,
  ): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      this.idempotencyKey(event.operationId),
    ]);
  }

  private numberFromRow(value: number | string, field: string): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `Tenant erasure proof ledger ${field} is not numeric for ${this.options.targetService}`,
      );
    }
    return parsed;
  }

  private isoFromRow(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private async emitBlocked(
    event: TenantErasureRequestedEvent,
    error: LegalHoldActiveError,
  ): Promise<void> {
    await this.deps.dataSource.transaction(async (manager) => {
      const blockedAt = new Date().toISOString();
      const blockedEvent: TenantErasureBlockedEvent = {
        ...createBaseEvent<TenantErasureBlockedEvent>('TenantErasureBlocked', event.tenantId, {
          aggregateId: event.tenantId,
          aggregateType: 'Tenant',
        }),
        timestamp: blockedAt,
        userId: event.requestedBy,
        operationId: event.operationId,
        blockedAt,
        blockedByService: this.options.targetService,
        reason: error.message,
        legalMatterId: error.legalMatterId,
      };
      await this.deps.outboxPublisher.enqueue(blockedEvent, manager, {
        aggregateId: event.tenantId,
        idempotencyKey: `${this.idempotencyKey(event.operationId)}:blocked`,
      });
    });
  }

  private async emitFailure(
    event: TenantErasureRequestedEvent,
    error: unknown,
    retryable: boolean,
  ): Promise<void> {
    await this.deps.dataSource.transaction(async (manager) => {
      const failedAt = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureEvent: TenantDataErasureFailedEvent = {
        ...createBaseEvent<TenantDataErasureFailedEvent>('TenantDataErasureFailed', event.tenantId, {
          aggregateId: event.tenantId,
          aggregateType: 'Tenant',
        }),
        timestamp: failedAt,
        userId: event.requestedBy,
        operationId: event.operationId,
        targetService: this.options.targetService,
        failedAt,
        errorCode: error instanceof Error ? error.name : 'TenantErasureError',
        errorMessage,
        retryable,
      };
      await this.deps.outboxPublisher.enqueue(failureEvent, manager, {
        aggregateId: event.tenantId,
        idempotencyKey: `${this.idempotencyKey(event.operationId)}:failed`,
      });
    });
  }

  private idempotencyKey(operationId: string): string {
    return `tenant-erasure:${operationId}:${this.options.targetService}`;
  }

  private createProofHash(args: {
    readonly event: TenantErasureRequestedEvent;
    readonly erasedAt: string;
    readonly matchedRecordCount: number;
    readonly erasedRecordCount: number;
    readonly tableResults: readonly TableDeleteResult[];
    readonly executedHooks: readonly string[];
  }): string {
    const perTable = [...args.tableResults]
      .sort((a, b) => a.tableName.localeCompare(b.tableName))
      .map((item) => `${item.tableName}:${item.matchedCount}:${item.erasedCount}`)
      .join(',');
    const material = [
      this.options.targetService,
      this.options.moduleName,
      this.options.mode,
      args.event.tenantId,
      args.event.operationId,
      args.erasedAt,
      String(args.event.dryRun),
      String(args.matchedRecordCount),
      String(args.erasedRecordCount),
      perTable,
      // Hook coverage is part of the attested proof material: the hash of a
      // successful erasure binds WHICH non-deletion treatments (e.g. the
      // stored_events crypto-shred) completed inside the same transaction.
      args.executedHooks.join(','),
    ].join('|');
    return `sha256:${createHash('sha256').update(material).digest('hex')}`;
  }
}
