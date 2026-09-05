import { createHash } from 'crypto';

import { Logger } from '@nestjs/common';
import {
  createBaseEvent,
  TenantDataErasedEvent,
  TenantDataErasureFailedEvent,
  TenantErasureBlockedEvent,
  TenantErasureRequestedEvent,
  tenantErasureOutcomeEventType,
  type BaseEvent,
  type TenantErasureTargetService,
} from '@platform/event-contracts';
import { EntityManager } from 'typeorm';

import {
  queryRowCountNormalized,
  queryRowsNormalized,
} from '../../database/query-result-normalizer';
import { MODULE_SCHEMAS } from '../../database/schema-manager.service';
import { validateSqlIdentifier } from '../../database/sql-identifier.util';
import { getTenantSchemaName } from '../../database/tenant-schema.utils';
import { LegalHoldActiveError } from '../legal-hold';

import { tenantErasureFenceLockKey } from './tenant-erasure-fence';
import {
  tenantErasureCompletionState,
  type TenantErasureExecutionState,
} from './tenant-erasure-result';
import {
  erasedTables,
  requiredColumns,
  tenantErasurePolicyProblems,
  tenantRowPredicate,
  type CascadeViaPolicy,
  type TenantErasureTablePolicies,
} from './tenant-erasure-table-policy';

export type TenantErasureTargetMode = 'tenant-schema-module' | 'source-schema-tenant-column';

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
  onTenantErased(event: TenantErasureRequestedEvent, manager: EntityManager): Promise<void>;
}

interface TenantErasureTargetExecutorBaseOptions {
  readonly targetService: TenantErasureTargetService;
  readonly moduleName: string;
  readonly sourceSchema: string;
  readonly outbox: {
    readonly schema: string;
    readonly table: string;
  };
  readonly proofLedger: {
    readonly schema: string;
    readonly table: string;
  };
}

/** A tenant-schema target empties the tenant's own schema; no per-table policy exists or is needed. */
export interface TenantSchemaModuleTargetOptions extends TenantErasureTargetExecutorBaseOptions {
  readonly mode: 'tenant-schema-module';
}

/**
 * A source-schema target deletes by the per-table policy (ADMIN-CRITICAL-009).
 * `tables` must name every table MODULE_SCHEMAS registers for the module;
 * the executor refuses to construct otherwise.
 */
export interface SourceSchemaTenantColumnTargetOptions
  extends TenantErasureTargetExecutorBaseOptions {
  readonly mode: 'source-schema-tenant-column';
  readonly tables: TenantErasureTablePolicies;
}

export type TenantErasureTargetExecutorOptions =
  | TenantSchemaModuleTargetOptions
  | SourceSchemaTenantColumnTargetOptions;

export interface TenantErasureTargetExecutorDependencies {
  readonly dataSource: TenantErasureTargetDataSource;
  readonly outboxPublisher: TenantErasureTargetOutbox;
  readonly legalHoldService: TenantErasureTargetLegalHold;
  readonly logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /**
   * Post-erasure hooks for tenant data that table deletion cannot reach
   * (see TenantErasurePostErasureHook). Empty for most services.
   */
  readonly postErasureHooks?: readonly TenantErasurePostErasureHook[];
}

export interface TenantErasureTargetDataSource {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T>;
}

export interface TenantErasureTargetOutbox {
  enqueue(
    event: BaseEvent,
    manager: EntityManager,
    options?: { idempotencyKey?: string; aggregateId?: string },
  ): Promise<void>;
}

export interface TenantErasureTargetLegalHold {
  assertNoHold(tenantId: string, scope: 'tenant'): Promise<void>;
}

export interface TenantErasureTargetResult {
  readonly state: TenantErasureExecutionState | 'BLOCKED' | 'FAILED';
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
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;

  constructor(
    private readonly deps: TenantErasureTargetExecutorDependencies,
    private readonly options: TenantErasureTargetExecutorOptions,
  ) {
    this.logger = deps.logger ?? new Logger(`TenantErasureTargetExecutor:${options.targetService}`);
    if (options.mode === 'source-schema-tenant-column') {
      // A policy set that misses a registered table, cascades into nothing, or
      // cycles is refused before the service can subscribe: an incomplete
      // erasure must be impossible to boot, not discovered at the first request.
      const problems = tenantErasurePolicyProblems(options.moduleName, options.tables, [
        options.outbox.table,
        options.proofLedger.table,
      ]);
      if (problems.length > 0) {
        throw new Error(
          `Tenant erasure target ${options.targetService} has an incomplete table policy:\n  - ${problems.join('\n  - ')}`,
        );
      }
    }
  }

  async eraseFromRequest(event: TenantErasureRequestedEvent): Promise<TenantErasureTargetResult> {
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
        await this.lockTenantFence(manager, event.tenantId);
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
        const matchedRecordCount = tableResults.reduce((sum, item) => sum + item.matchedCount, 0);
        const erasedRecordCount = tableResults.reduce((sum, item) => sum + item.erasedCount, 0);
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

        const proofEventType = tenantErasureOutcomeEventType(this.options.targetService, 'erased');
        const proofEvent: TenantDataErasedEvent = {
          ...createBaseEvent<TenantDataErasedEvent>(proofEventType, event.tenantId, {
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
          state: tenantErasureCompletionState(event.dryRun, false),
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

    const tenantSchema = validateSqlIdentifier(getTenantSchemaName(event.tenantId), 'schema');
    const tables = moduleSchema.tables.map((table) => validateSqlIdentifier(table, 'table'));
    const existingTables = await this.existingTables(manager, tenantSchema, tables);
    const sortedTables = await this.sortedTablesForDelete(manager, tenantSchema, existingTables);

    const results: TableDeleteResult[] = [];
    for (const tableName of sortedTables) {
      results.push(await this.deleteWholeTable(manager, tenantSchema, tableName, event.dryRun));
    }
    return results;
  }

  private async eraseSourceSchemaRows(
    event: TenantErasureRequestedEvent,
    manager: EntityManager,
  ): Promise<readonly TableDeleteResult[]> {
    if (this.options.mode !== 'source-schema-tenant-column') {
      throw new Error(
        `Tenant erasure target ${this.options.targetService} is not a source-schema target`,
      );
    }
    const sourceSchema = validateSqlIdentifier(this.options.sourceSchema, 'schema');
    const policies = this.options.tables;
    // The policy is the plan; the database is only asked to CONFIRM that every
    // column the plan names exists. A registry that lies about a column fails
    // the erasure loud rather than deleting the wrong rows or none.
    await this.assertPolicyColumnsExist(manager, sourceSchema, policies);
    const targetTables = erasedTables(policies)
      .map((table) => validateSqlIdentifier(table, 'table'))
      .sort();
    // A cascade child must go before its parent whether or not the database
    // declares the foreign key: once the parent's tenant rows are gone the
    // child's sub-select matches nothing and its rows would survive silently.
    const cascadeEdges: Array<readonly [string, string]> = Object.entries(policies)
      .filter((entry): entry is [string, CascadeViaPolicy] => entry[1].kind === 'cascade-via')
      .map(([child, policy]) => [child, policy.parent] as const);
    const sortedTables = await this.sortedTablesForDelete(
      manager,
      sourceSchema,
      targetTables,
      cascadeEdges,
    );

    const results: TableDeleteResult[] = [];
    for (const tableName of sortedTables) {
      results.push(
        await this.deleteByPredicate(
          manager,
          sourceSchema,
          tableName,
          tenantRowPredicate(sourceSchema, tableName, policies),
          event.tenantId,
          event.dryRun,
        ),
      );
    }
    return results;
  }

  private async assertPolicyColumnsExist(
    manager: EntityManager,
    schemaName: string,
    policies: TenantErasureTablePolicies,
  ): Promise<void> {
    const required = requiredColumns(policies);
    if (required.length === 0) {
      return;
    }
    const tableNames = [...new Set(required.map((entry) => entry.table))].sort();
    const rows = queryRowsNormalized<TenantColumnRow>(
      await manager.query(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = $1
            AND table_name = ANY($2::text[])
          ORDER BY table_name, column_name
        `,
        [schemaName, tableNames],
      ),
    );
    const present = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
    const missing = required
      .filter((entry) => !present.has(`${entry.table}.${entry.column}`))
      .map((entry) => `${schemaName}.${entry.table}.${entry.column}`);
    if (missing.length > 0) {
      throw new Error(
        `Tenant erasure policy for ${this.options.targetService} names columns the database does not have: ${[...new Set(missing)].join(', ')}`,
      );
    }
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

  private async sortedTablesForDelete(
    manager: EntityManager,
    schemaName: string,
    tableNames: readonly string[],
    policyEdges: ReadonlyArray<readonly [child: string, parent: string]> = [],
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
    const edgeList: Array<readonly [string, string]> = [
      ...fkRows.map((row) => [row.table_name, row.referenced_table_name] as const),
      ...policyEdges,
    ];
    for (const [child, parent] of edgeList) {
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
    const matchedCount = await this.countRows(manager, schemaName, tableName, undefined, []);
    const erasedCount = dryRun
      ? 0
      : await this.deleteRows(manager, schemaName, tableName, undefined, []);
    return { tableName, matchedCount, erasedCount };
  }

  private async deleteByPredicate(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    predicateSql: string,
    tenantId: string,
    dryRun: boolean,
  ): Promise<TableDeleteResult> {
    const matchedCount = await this.countRows(manager, schemaName, tableName, predicateSql, [
      tenantId,
    ]);
    const erasedCount = dryRun
      ? 0
      : await this.deleteRows(manager, schemaName, tableName, predicateSql, [tenantId]);
    return { tableName, matchedCount, erasedCount };
  }

  private async countRows(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    predicateSql: string | undefined,
    params: readonly string[],
  ): Promise<number> {
    const where = predicateSql ? ` WHERE ${predicateSql}` : '';
    const rows = queryRowsNormalized<CountRow>(
      await manager.query(
        `SELECT COUNT(*)::text AS count FROM "${schemaName}"."${tableName}"${where}`,
        [...params],
      ),
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
  }

  private async deleteRows(
    manager: EntityManager,
    schemaName: string,
    tableName: string,
    predicateSql: string | undefined,
    params: readonly string[],
  ): Promise<number> {
    const where = predicateSql ? ` WHERE ${predicateSql}` : '';
    return queryRowCountNormalized(
      await manager.query(`DELETE FROM "${schemaName}"."${tableName}"${where}`, [...params]),
    );
  }

  private async readExistingProof(
    event: TenantErasureRequestedEvent,
    queryable: Queryable,
  ): Promise<TenantErasureStoredProofRow | null> {
    const schemaName = validateSqlIdentifier(this.options.proofLedger.schema, 'schema');
    const tableName = validateSqlIdentifier(this.options.proofLedger.table, 'table');
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
      this.replayStoredProofInTransaction(manager, event, storedProof, idempotencyKey),
    );
  }

  private async replayStoredProofInTransaction(
    manager: EntityManager,
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
    idempotencyKey: string,
  ): Promise<TenantErasureTargetResult> {
    this.assertStoredProofMode(event, storedProof);
    const matchedRecordCount = this.numberFromRow(
      storedProof.matchedRecordCount,
      'matchedRecordCount',
    );
    const erasedRecordCount = this.numberFromRow(
      storedProof.erasedRecordCount,
      'erasedRecordCount',
    );
    const alreadyQueued = await this.hasOutboxRow(manager, event.tenantId, idempotencyKey);
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
      state: tenantErasureCompletionState(storedProof.dryRun, true),
      tenantId: event.tenantId,
      operationId: event.operationId,
      targetService: this.options.targetService,
      matchedRecordCount,
      erasedRecordCount,
    };
  }

  private assertStoredProofMode(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
  ): void {
    if (storedProof.dryRun !== event.dryRun) {
      throw new Error(
        `Tenant erasure stored proof mode mismatch for operation ${event.operationId}: ` +
          `requested dryRun=${event.dryRun}, stored dryRun=${storedProof.dryRun}`,
      );
    }
    const erasedRecordCount = this.numberFromRow(
      storedProof.erasedRecordCount,
      'erasedRecordCount',
    );
    if (storedProof.dryRun && erasedRecordCount !== 0) {
      throw new Error(
        `Tenant erasure dry-run proof ${event.operationId} reports ` +
          `${erasedRecordCount} erased records`,
      );
    }
  }

  private storedProofToEvent(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
  ): TenantDataErasedEvent {
    const erasedAt = this.isoFromRow(storedProof.erasedAt);
    return {
      eventId: storedProof.eventId as TenantDataErasedEvent['eventId'],
      eventType: tenantErasureOutcomeEventType(this.options.targetService, 'erased'),
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
      matchedRecordCount: this.numberFromRow(storedProof.matchedRecordCount, 'matchedRecordCount'),
      erasedRecordCount: this.numberFromRow(storedProof.erasedRecordCount, 'erasedRecordCount'),
      proofHash: storedProof.proofHash,
    };
  }

  private async recordProofLedger(
    manager: EntityManager,
    event: TenantDataErasedEvent,
  ): Promise<void> {
    const schemaName = validateSqlIdentifier(this.options.proofLedger.schema, 'schema');
    const tableName = validateSqlIdentifier(this.options.proofLedger.table, 'table');
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

  private async lockTenantFence(manager: EntityManager, tenantId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      tenantErasureFenceLockKey(tenantId, this.options.targetService),
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
      const blockedEventType = tenantErasureOutcomeEventType(this.options.targetService, 'blocked');
      const blockedEvent: TenantErasureBlockedEvent = {
        ...createBaseEvent<TenantErasureBlockedEvent>(blockedEventType, event.tenantId, {
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
      const failureEventType = tenantErasureOutcomeEventType(this.options.targetService, 'failed');
      const failureEvent: TenantDataErasureFailedEvent = {
        ...createBaseEvent<TenantDataErasureFailedEvent>(failureEventType, event.tenantId, {
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
