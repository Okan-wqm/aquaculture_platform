/**
 * source-schema-write-guard-reconciler unit tests — the SSoT for the
 * `guard_source_write` triggers (ORPHAN-HIGH-087; completes FARM-CRITICAL-061).
 *
 * Proves: the guarded set is `tables − referenceDataTables − infrastructureTables`
 * and never includes a reference/infrastructure table; platform-level and
 * unregistered schemas are refused; assert (re)creates the canonical function,
 * installs the guard ONLY on guarded tables that exist, and drops a stray guard
 * from a non-guarded table; verify reports `missing` and `misplaced` drift.
 */
import { MODULE_SCHEMAS } from './schema-manager.service';
import {
  assertSourceSchemaWriteGuards,
  sourceSchemaGuardedTables,
  verifySourceSchemaWriteGuards,
  type SourceSchemaGuardExecutor,
} from './source-schema-write-guard-reconciler';
import { TENANT_AWARE_SCHEMAS } from './tenant-aware-schemas';

interface RecordedQuery {
  sql: string;
  params?: readonly unknown[];
}

function executorWith(responder: (sql: string, params?: readonly unknown[]) => unknown): {
  executor: SourceSchemaGuardExecutor;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  return {
    queries,
    executor: {
      query: (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, ...(params !== undefined ? { params } : {}) });
        return Promise.resolve(responder(sql, params));
      },
    },
  };
}

describe('sourceSchemaGuardedTables', () => {
  it('derives per-tenant DATA tables and EXCLUDES reference + infrastructure tables', () => {
    const guarded = sourceSchemaGuardedTables('farm');
    expect(guarded).toContain('tank_batches'); // per-tenant data table → guarded
    expect(guarded.length).toBeGreaterThan(5);
    // infrastructure ledgers (the FARM-CRITICAL-061 class) are never guarded
    expect(guarded).not.toContain('farm_audit_logs');
    expect(guarded).not.toContain('outbox_events');
    // reference/seed tables (written directly by FarmSeedService) are never guarded
    expect(guarded).not.toContain('species');
    expect(guarded).not.toContain('equipment_types');
  });

  it('refuses a platform-level (non-tenant-aware) schema', () => {
    expect(() => sourceSchemaGuardedTables('admin')).toThrow(/non-tenant-aware/);
    expect(() => sourceSchemaGuardedTables('auth')).toThrow(/non-tenant-aware/);
  });

  it('refuses an unregistered schema', () => {
    expect(() => sourceSchemaGuardedTables('not_a_schema')).toThrow(/non-tenant-aware/);
  });

  it('rejects unsafe identifiers', () => {
    expect(() => sourceSchemaGuardedTables('farm"; DROP TABLE x;--')).toThrow(/Unsafe/);
  });

  // The FARM-CRITICAL-061 class (guard on a cross-tenant ledger / reference
  // table) is impossible-by-construction ONLY if the derivation never lets one
  // in — assert it across EVERY tenant-aware schema, not just farm.
  describe.each([...TENANT_AWARE_SCHEMAS])(
    'derivation for tenant-aware schema %s',
    (sourceSchema) => {
      it('guarded ∩ (referenceDataTables ∪ infrastructureTables) === ∅ and guarded ⊆ tables', () => {
        const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === sourceSchema);
        expect(entry).toBeDefined();
        if (entry === undefined) {
          return;
        }
        const nonGuardable = new Set<string>([
          ...(entry.referenceDataTables ?? []),
          ...(entry.infrastructureTables ?? []),
        ]);
        const guarded = sourceSchemaGuardedTables(sourceSchema);
        expect(guarded.filter((t) => nonGuardable.has(t))).toEqual([]);
        expect(guarded.every((t) => entry.tables.includes(t))).toBe(true);
      });
    },
  );
});

describe('assertSourceSchemaWriteGuards', () => {
  it('creates the function, guards existing data tables, and drops a stray guard', async () => {
    const { executor, queries } = executorWith((sql) => {
      if (sql.includes('FROM pg_tables')) {
        // tank_batches (guarded) exists; farm_audit_logs + species exist but are excluded
        return [
          { tablename: 'tank_batches' },
          { tablename: 'farm_audit_logs' },
          { tablename: 'species' },
        ];
      }
      if (sql.includes('FROM pg_trigger')) {
        // A stray guard sits on the cross-tenant audit ledger (the exact
        // FARM-CRITICAL-061 drift) alongside the freshly-installed data guard.
        return [{ tablename: 'tank_batches' }, { tablename: 'farm_audit_logs' }];
      }
      return [];
    });

    const report = await assertSourceSchemaWriteGuards(executor, 'farm');

    expect(report.installed).toEqual(['tank_batches']);
    expect(report.droppedMisplaced).toEqual(['farm_audit_logs']);
    // most guarded farm tables are absent in this mock
    expect(report.absentTables.length).toBeGreaterThan(3);

    const sql = queries.map((q) => q.sql);
    expect(sql).toContainEqual(
      expect.stringContaining('CREATE OR REPLACE FUNCTION "farm".block_source_writes()'),
    );
    expect(sql).toContainEqual(
      expect.stringContaining(
        'CREATE TRIGGER guard_source_write BEFORE INSERT OR UPDATE OR DELETE ON "farm"."tank_batches"',
      ),
    );
    // the stray guard on the infrastructure ledger is dropped
    expect(sql).toContainEqual(
      'DROP TRIGGER IF EXISTS guard_source_write ON "farm"."farm_audit_logs"',
    );
    // a guard is NEVER created on a reference or infrastructure table
    const joined = sql.join('\n');
    expect(joined).not.toContain(
      'CREATE TRIGGER guard_source_write BEFORE INSERT OR UPDATE OR DELETE ON "farm"."farm_audit_logs"',
    );
    expect(joined).not.toContain(
      'CREATE TRIGGER guard_source_write BEFORE INSERT OR UPDATE OR DELETE ON "farm"."species"',
    );
  });

  it('refuses to guard a platform-level schema', async () => {
    const { executor } = executorWith(() => []);
    await expect(assertSourceSchemaWriteGuards(executor, 'admin')).rejects.toThrow(
      /non-tenant-aware/,
    );
  });

  // Regression: a guarded table that is DECLARATIVE-PARTITIONED (messaging.messages,
  // message_receipts) auto-propagates `guard_source_write` to every partition as an
  // INHERITED child trigger (pg_trigger.tgparentid != 0). Those children cannot be
  // dropped independently ("... requires it") — so the reconcile listing must
  // exclude them or it aborts every production deploy. Fix pins the DB-level filter.
  it('excludes inherited partition triggers from the guard listing (partitioned-table deploy safety)', async () => {
    const { executor, queries } = executorWith(() => []);
    await assertSourceSchemaWriteGuards(executor, 'messaging');
    const guardListing = queries.find((q) => q.sql.includes('FROM pg_trigger'));
    expect(guardListing).toBeDefined();
    expect(guardListing?.sql ?? '').toContain('tg.tgparentid = 0');
  });

  it('drops a stray STAND-ALONE guard but never a partition child (which is managed via its parent)', async () => {
    // The mocked DB honours `tgparentid = 0`, so the guard listing returns only
    // parents/stand-alone tables — a partition child (messages_2026_06) is never
    // surfaced, hence never in droppedMisplaced (Postgres would have refused it).
    const { executor } = executorWith((sql) => {
      if (sql.includes('FROM pg_tables')) {
        return [{ tablename: 'messages' }, { tablename: 'messages_2026_06' }];
      }
      if (sql.includes('FROM pg_trigger')) {
        return [{ tablename: 'messages' }]; // parent only (partition child filtered out)
      }
      return [];
    });
    const report = await assertSourceSchemaWriteGuards(executor, 'messaging');
    expect(report.droppedMisplaced).not.toContain('messages_2026_06');
  });
});

describe('verifySourceSchemaWriteGuards', () => {
  it('reports a guarded data table lacking the guard as missing', async () => {
    const { executor } = executorWith((sql) => {
      if (sql.includes('FROM pg_tables')) {
        return [{ tablename: 'tank_batches' }];
      }
      return []; // no triggers installed
    });
    const v = await verifySourceSchemaWriteGuards(executor, 'farm');
    expect(v.missing).toContain('tank_batches');
    expect(v.misplaced).toEqual([]);
  });

  it('reports a guard on a reference/infrastructure table as misplaced (FARM-CRITICAL-061)', async () => {
    const { executor } = executorWith((sql) => {
      if (sql.includes('FROM pg_tables')) {
        return [{ tablename: 'tank_batches' }, { tablename: 'farm_audit_logs' }];
      }
      if (sql.includes('FROM pg_trigger')) {
        return [{ tablename: 'tank_batches' }, { tablename: 'farm_audit_logs' }];
      }
      return [];
    });
    const v = await verifySourceSchemaWriteGuards(executor, 'farm');
    expect(v.missing).toEqual([]); // tank_batches is guarded
    expect(v.misplaced).toEqual(['farm_audit_logs']);
  });
});
