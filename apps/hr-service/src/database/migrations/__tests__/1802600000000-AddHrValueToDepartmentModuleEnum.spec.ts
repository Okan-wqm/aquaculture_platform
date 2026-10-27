import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { AddHrValueToDepartmentModuleEnum1802600000000 } from '../1802600000000-AddHrValueToDepartmentModuleEnum';

/**
 * AddHrValueToDepartmentModuleEnum (1802600000000) — statement-level contract (HR-MEDIUM-064).
 *
 * `departments_hr_modulecode_enum` is created UNQUALIFIED, once per schema: the `hr` run and every
 * `tenant_<uuid>` replay of 1802400000000 each hold their own copy, and a tenant cloned from the
 * source schema may point at the source schema's copy instead. So the label is added wherever the
 * type exists in the active schema, and a schema without it skips — a bare `ALTER TYPE` there
 * throws 42704 and fails the deploy (the ORPHAN-HIGH-132 outage shape the farm precedent
 * 1805900000000 guards against). `ADD VALUE` cannot be used inside the transaction that adds it,
 * so the migration runs outside one.
 */
describe('AddHrValueToDepartmentModuleEnum1802600000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs outside a transaction, as ALTER TYPE … ADD VALUE requires', () => {
    expect(new AddHrValueToDepartmentModuleEnum1802600000000().transaction).toBe(false);
  });

  it('adds hr once, guarded on the type existing in the active schema', async () => {
    await new AddHrValueToDepartmentModuleEnum1802600000000().up(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    const sql = String(queryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain('n.nspname = current_schema()');
    expect(sql).toContain(`t.typname = 'departments_hr_modulecode_enum'`);
    expect(sql).toMatch(/IF EXISTS/i);
    expect(sql).toContain(
      `ALTER TYPE "departments_hr_modulecode_enum" ADD VALUE IF NOT EXISTS 'hr'`,
    );
  });

  it('postCondition counts a label missing only where the type exists in the active schema', async () => {
    queryRunner.query.mockResolvedValueOnce([{ missing: '0' }]);

    const ok = await new AddHrValueToDepartmentModuleEnum1802600000000().postCondition(queryRunner);

    expect(ok).toBe(true);
    const sql = String(queryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain(`('departments_hr_modulecode_enum', 'hr')`);
    expect(sql).toContain('current_schema()');
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1\s+FROM pg_type/i);
  });

  it('postCondition fails closed when the type is present without hr', async () => {
    queryRunner.query.mockResolvedValueOnce([{ missing: '1' }]);

    await expect(
      new AddHrValueToDepartmentModuleEnum1802600000000().postCondition(queryRunner),
    ).resolves.toBe(false);
  });

  it('down is forward-only: Postgres cannot drop an enum label', async () => {
    await new AddHrValueToDepartmentModuleEnum1802600000000().down();

    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
