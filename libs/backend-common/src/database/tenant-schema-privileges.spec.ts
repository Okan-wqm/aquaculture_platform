/**
 * tenant-schema-privileges unit tests — the ownership/grant SSoT for
 * per-tenant table clones (2026-07-06 grant incident).
 *
 * Proves: assert aligns owner + service DML (and owned sequences) ONLY for
 * registered tables that exist; verify reports owner/privilege drift as
 * violations and unregistered tables as unknowns (partition children of
 * registered parents excluded); non-tenant schemas and unregistered source
 * schemas are refused.
 */
import {
  assertTenantSchemaPrivileges,
  ownerRoleForTenantAwareSchema,
  tenantTablesForSourceSchema,
  verifyTenantSchemaPrivileges,
  TenantSchemaPrivilegeExecutor,
} from './tenant-schema-privileges';

const TENANT = 'tenant_7f6b08ab90e246d3';

interface RecordedQuery {
  sql: string;
  params?: readonly unknown[];
}

function executorWith(
  responder: (sql: string, params?: readonly unknown[]) => unknown,
): { executor: TenantSchemaPrivilegeExecutor; queries: RecordedQuery[] } {
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

describe('tenantTablesForSourceSchema', () => {
  it('derives the per-tenant set from MODULE_SCHEMAS (tables ∪ referenceDataTables)', () => {
    const farm = tenantTablesForSourceSchema('farm');
    expect(farm).toContain('tank_batches');
    expect(farm.length).toBeGreaterThan(10);
    // infrastructure tables stay source-only
    expect(farm).not.toContain('outbox_events');
  });

  it('refuses a source schema that is not registered', () => {
    expect(() => tenantTablesForSourceSchema('not_a_schema')).toThrow(/not in MODULE_SCHEMAS/);
  });
});

describe('assertTenantSchemaPrivileges', () => {
  it('aligns owner + DML for registered tables that exist, skips absent ones', async () => {
    const { executor, queries } = executorWith((sql) => {
      if (sql.includes('FROM pg_tables')) {
        return [{ tablename: 'tank_batches' }, { tablename: 'unrelated_junk' }];
      }
      if (sql.includes('FROM pg_class seq')) {
        return [{ seqname: 'tank_batches_seq' }];
      }
      return [];
    });

    const report = await assertTenantSchemaPrivileges(executor, {
      tenantSchema: TENANT,
      sourceSchema: 'farm',
    });

    expect(report.ownerRole).toBe('farm_schema_owner');
    expect(report.serviceRole).toBe('farm_service');
    expect(report.alignedTables).toEqual(['tank_batches']);
    expect(report.alignedSequences).toEqual(['tank_batches_seq']);
    // every registered farm table except tank_batches is absent in this mock
    expect(report.absentTables.length).toBeGreaterThan(5);

    const sql = queries.map((q) => q.sql);
    expect(sql).toContainEqual(expect.stringContaining(`GRANT USAGE ON SCHEMA "${TENANT}"`));
    expect(sql).toContainEqual(
      `ALTER TABLE "${TENANT}"."tank_batches" OWNER TO "farm_schema_owner"`,
    );
    expect(sql).toContainEqual(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${TENANT}"."tank_batches" TO "farm_service"`,
    );
    expect(sql).toContainEqual(
      `ALTER SEQUENCE "${TENANT}"."tank_batches_seq" OWNER TO "farm_schema_owner"`,
    );
    // never touches tables the registry does not claim
    expect(sql.join('\n')).not.toContain('unrelated_junk');
  });

  it('refuses a non-tenant schema (cannot be pointed at source schemas)', async () => {
    const { executor } = executorWith(() => []);
    await expect(
      assertTenantSchemaPrivileges(executor, { tenantSchema: 'farm', sourceSchema: 'farm' }),
    ).rejects.toThrow(/Refusing non-tenant schema/);
  });
});

describe('verifyTenantSchemaPrivileges', () => {
  function verifyResponder(overrides: {
    owner?: string;
    hasDelete?: boolean;
    extraTables?: string[];
  }) {
    return (sql: string) => {
      if (sql.includes('has_table_privilege')) {
        return [
          {
            tablename: 'tank_batches',
            tableowner: overrides.owner ?? 'farm_schema_owner',
            has_select: true,
            has_insert: true,
            has_update: true,
            has_delete: overrides.hasDelete ?? true,
          },
        ];
      }
      if (sql.includes('FROM pg_tables')) {
        return [
          { tablename: 'tank_batches' },
          ...(overrides.extraTables ?? []).map((t) => ({ tablename: t })),
        ];
      }
      return [];
    };
  }

  it('passes a fully aligned table', async () => {
    const { executor } = executorWith(verifyResponder({}));
    const v = await verifyTenantSchemaPrivileges(executor, TENANT, ['farm']);
    expect(v.violations).toEqual([]);
    expect(v.unknownTables).toEqual([]);
  });

  it('reports wrong owner AND missing DML as violations', async () => {
    const { executor } = executorWith(verifyResponder({ owner: 'aquaculture', hasDelete: false }));
    const v = await verifyTenantSchemaPrivileges(executor, TENANT, ['farm']);
    expect(v.violations).toHaveLength(2);
    expect(v.violations[0]).toMatchObject({ table: 'tank_batches', kind: 'owner' });
    expect(v.violations[1]).toMatchObject({ table: 'tank_batches', kind: 'privilege' });
  });

  it('reports unregistered tables as unknown, but not partition children of registered parents', async () => {
    const { executor } = executorWith(
      verifyResponder({ extraTables: ['deploy_artifacts', 'messages_2026_07'] }),
    );
    // 'messages' is registered by the messaging module; its monthly partition
    // children are accessed through the parent ACL and must not be flagged.
    const v = await verifyTenantSchemaPrivileges(executor, TENANT, ['farm', 'messaging']);
    expect(v.unknownTables).toEqual(['deploy_artifacts']);
  });
});

describe('ownerRoleForTenantAwareSchema', () => {
  it('derives the stage-008 ownership role', () => {
    expect(ownerRoleForTenantAwareSchema('farm')).toBe('farm_schema_owner');
  });

  it('rejects unsafe identifiers', () => {
    expect(() => ownerRoleForTenantAwareSchema('farm"; DROP TABLE x;--')).toThrow(/Unsafe/);
  });
});
