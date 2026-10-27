import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { AddAlertHistoryHrModuleValue1801400000000 } from '../1801400000000-AddAlertHistoryHrModuleValue';

/**
 * AddAlertHistoryHrModuleValue (1801400000000) — statement-level contract.
 *
 * `alert_history_module_enum` is created UNQUALIFIED, once per schema (1801200000000): the `alert`
 * run and every `tenant_<uuid>` replay hold their own copy, and a tenant cloned from the source
 * schema may point at the source schema's copy instead. So the label is added wherever the type
 * exists in the active schema, and a schema without it skips — a bare `ALTER TYPE` there throws
 * 42704 and fails the deploy (the farm precedent 1805900000000). `ADD VALUE` cannot be used inside
 * the transaction that adds it, so the migration runs outside one.
 */
describe('AddAlertHistoryHrModuleValue1801400000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs outside a transaction, as ALTER TYPE … ADD VALUE requires', () => {
    expect(new AddAlertHistoryHrModuleValue1801400000000().transaction).toBe(false);
  });

  it('adds hr once, guarded on the type existing in the active schema', async () => {
    await new AddAlertHistoryHrModuleValue1801400000000().up(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    const sql = String(queryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain('n.nspname = current_schema()');
    expect(sql).toContain(`t.typname = 'alert_history_module_enum'`);
    expect(sql).toMatch(/IF EXISTS/i);
    expect(sql).toContain(`ALTER TYPE "alert_history_module_enum" ADD VALUE IF NOT EXISTS 'hr'`);
  });

  it('postCondition counts a label missing only where the type exists in the active schema', async () => {
    queryRunner.query.mockResolvedValueOnce([{ missing: '0' }]);

    const ok = await new AddAlertHistoryHrModuleValue1801400000000().postCondition(queryRunner);

    expect(ok).toBe(true);
    const sql = String(queryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain(`('alert_history_module_enum', 'hr')`);
    expect(sql).toContain('current_schema()');
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM pg_type/i);
  });

  it('postCondition fails closed when the type is present without hr', async () => {
    queryRunner.query.mockResolvedValueOnce([{ missing: '1' }]);

    await expect(
      new AddAlertHistoryHrModuleValue1801400000000().postCondition(queryRunner),
    ).resolves.toBe(false);
  });

  it('down is forward-only: Postgres cannot drop an enum label', async () => {
    await new AddAlertHistoryHrModuleValue1801400000000().down();

    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
