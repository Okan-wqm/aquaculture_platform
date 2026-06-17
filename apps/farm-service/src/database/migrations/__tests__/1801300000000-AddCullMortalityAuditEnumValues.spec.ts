import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { AddCullMortalityAuditEnumValues1801300000000 } from '../1801300000000-AddCullMortalityAuditEnumValues';

/**
 * Regression cover for the 2026-06-17 production outage (ORPHAN-HIGH-132):
 * the migration issued BARE `ALTER TYPE ... ADD VALUE` against enum types that
 * exist only in the `farm` schema. On the per-tenant db-migrate fan-out
 * (search_path = tenant_<uuid>) the unqualified type is absent, so the bare
 * ALTER threw 42704 "type does not exist" and failed the whole deploy.
 *
 * The fix guards every ALTER on type presence in current_schema() (the
 * AlignEquipmentTypes pattern). These London-school unit tests assert the SQL
 * SHAPE — every ALTER is type-presence-guarded, and postCondition only asserts
 * labels for types present in the active schema. The fully-typed
 * `jest.Mocked<QueryRunner>` from createMockDataSource() keeps the test free of
 * forbidden type-assertion casts.
 */
describe('AddCullMortalityAuditEnumValues1801300000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    ['tank_operations_cullreason_enum', 'quality'],
    ['tank_operations_mortalityreason_enum', 'predation'],
    ['tank_operations_mortalityreason_enum', 'cannibalism'],
    ['farm_audit_logs_action_enum', 'MORTALITY_RECORDED'],
    ['farm_audit_logs_action_enum', 'CULL_RECORDED'],
  ];

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('emits one guarded ALTER per (type, value) — never a bare ALTER TYPE', async () => {
    await new AddCullMortalityAuditEnumValues1801300000000().up(mockQueryRunner);

    expect(mockQueryRunner.query).toHaveBeenCalledTimes(EXPECTED.length);

    for (const call of mockQueryRunner.query.mock.calls) {
      const sql = String(call[0]);
      // Every statement that ALTERs an enum MUST be wrapped in the
      // type-presence guard — this is the exact regression: a bare
      // `ALTER TYPE` on the tenant fan-out is what took prod down.
      if (sql.includes('ALTER TYPE')) {
        expect(sql).toContain('current_schema()');
        expect(sql).toMatch(/IF EXISTS/i);
        expect(sql).toContain('ADD VALUE IF NOT EXISTS');
      }
    }
  });

  it('covers exactly the five SSoT (type, value) pairs with correct casing', async () => {
    await new AddCullMortalityAuditEnumValues1801300000000().up(mockQueryRunner);

    for (const [type, value] of EXPECTED) {
      const matched = mockQueryRunner.query.mock.calls.some((call) => {
        const sql = String(call[0]);
        return (
          sql.includes(`t.typname = '${type}'`) &&
          sql.includes(`ALTER TYPE "${type}" ADD VALUE IF NOT EXISTS '${value}'`)
        );
      });
      expect(matched).toBe(true);
    }
  });

  it('postCondition asserts labels ONLY where the type exists in the active schema', async () => {
    mockQueryRunner.query.mockResolvedValueOnce([{ missing: '0' }]);

    const ok = await new AddCullMortalityAuditEnumValues1801300000000().postCondition(
      mockQueryRunner,
    );

    expect(ok).toBe(true);
    const sql = String(mockQueryRunner.query.mock.calls[0]?.[0]);
    // The type-presence guard (EXISTS … t.typname = x.typ) is what lets a
    // per-tenant run — where the shared `farm` types are absent — pass instead
    // of false-failing the deploy.
    expect(sql).toContain('current_schema()');
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM pg_type/i);
    expect(sql).toContain('t.typname = x.typ');
  });

  it('postCondition fails closed when a present type is genuinely missing a label', async () => {
    mockQueryRunner.query.mockResolvedValueOnce([{ missing: '2' }]);

    const ok = await new AddCullMortalityAuditEnumValues1801300000000().postCondition(
      mockQueryRunner,
    );

    expect(ok).toBe(false);
  });
});
