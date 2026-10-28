import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';

import { AddUserModuleAssignmentRole1819300000000 } from '../1819300000000-AddUserModuleAssignmentRole';
import { BackfillUserModuleAssignmentRole1819400000000 } from '../1819400000000-BackfillUserModuleAssignmentRole';

jest.setTimeout(120_000);

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const OTHER_TENANT = '2c1e5d4f-8a3b-4c6d-9e7f-0a1b2c3d4e5f';

const MODULE = {
  farm: '10000000-0000-4000-8000-000000000001',
  hr: '10000000-0000-4000-8000-000000000002',
  sensor: '10000000-0000-4000-8000-000000000003',
  alert: '10000000-0000-4000-8000-000000000004',
} as const;

const USER = {
  globalManager: '20000000-0000-4000-8000-000000000001',
  hrPrimary: '20000000-0000-4000-8000-000000000002',
  member: '20000000-0000-4000-8000-000000000003',
  designatedSensor: '20000000-0000-4000-8000-000000000004',
  designatedHr: '20000000-0000-4000-8000-000000000005',
  designatedFarmMember: '20000000-0000-4000-8000-000000000006',
  otherTenant: '20000000-0000-4000-8000-000000000007',
} as const;

interface RoleRow {
  userId: string;
  moduleId: string;
  role: string | null;
}

/**
 * RBAC-HIGH-027 on a real Postgres: the R1 role column and its counted backfill. The migration
 * runs as the runner does, without a tenant binding; the fixture installs no row-level security,
 * so the transaction-local `app.bypass_rls` the migration sets against the forced policy of the
 * live auth tables is pinned by the unit spec beside this one, not here. Pinned here: the ADR-051 rule row by row, the
 * managerId insert (hr and other tenants excluded), the CHECK, a row an old container inserts
 * after the migration (role NULL) and filled by a re-run, a replay that changes nothing, and the
 * post-condition failure path.
 */
describe('BackfillUserModuleAssignmentRole1819400000000 on real Postgres', () => {
  let harness: HarnessContext | undefined;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await requireAdmin().query('CREATE SCHEMA auth');
    await requireAdmin().query(`
      CREATE TABLE auth.users (
        id uuid PRIMARY KEY,
        role varchar(50) NOT NULL,
        "tenantId" uuid
      )
    `);
    await requireAdmin().query(`
      CREATE TABLE auth.modules (id uuid PRIMARY KEY, code varchar(50) NOT NULL UNIQUE)
    `);
    await requireAdmin().query(`
      CREATE TABLE auth.tenant_modules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "moduleId" uuid NOT NULL,
        "isEnabled" boolean NOT NULL DEFAULT true,
        "managerId" uuid
      )
    `);
    // The Baseline shape (1800000000000), foreign keys included.
    await requireAdmin().query(`
      CREATE TABLE auth.user_module_assignments (
        id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        "userId" uuid NOT NULL,
        "moduleId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "isPrimaryManager" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        permissions jsonb,
        "assignedBy" uuid NOT NULL,
        "expiresAt" timestamptz,
        notes text,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "updatedAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_user_module" UNIQUE ("userId", "moduleId"),
        CONSTRAINT "FK_fixture_uma_user" FOREIGN KEY ("userId") REFERENCES auth.users(id),
        CONSTRAINT "FK_fixture_uma_module" FOREIGN KEY ("moduleId") REFERENCES auth.modules(id)
      )
    `);
    for (const [code, id] of Object.entries(MODULE)) {
      await requireAdmin().query(`INSERT INTO auth.modules (id, code) VALUES ($1, $2)`, [id, code]);
    }
    await insertUser(USER.globalManager, 'MODULE_MANAGER', TENANT);
    await insertUser(USER.hrPrimary, 'MODULE_USER', TENANT);
    await insertUser(USER.member, 'MODULE_USER', TENANT);
    await insertUser(USER.designatedSensor, 'MODULE_MANAGER', TENANT);
    await insertUser(USER.designatedHr, 'MODULE_MANAGER', TENANT);
    await insertUser(USER.designatedFarmMember, 'MODULE_USER', TENANT);
    await insertUser(USER.otherTenant, 'MODULE_MANAGER', OTHER_TENANT);

    await insertAssignment(USER.globalManager, MODULE.farm, false);
    await insertAssignment(USER.globalManager, MODULE.hr, false);
    await insertAssignment(USER.globalManager, MODULE.alert, false);
    await insertAssignment(USER.hrPrimary, MODULE.hr, true);
    await insertAssignment(USER.member, MODULE.farm, false);
    await insertAssignment(USER.designatedFarmMember, MODULE.farm, false);

    await insertTenantModule(MODULE.farm, USER.designatedFarmMember);
    await insertTenantModule(MODULE.sensor, USER.designatedSensor);
    await insertTenantModule(MODULE.hr, USER.designatedHr);
    // A managerId naming a user of another tenant must not become a grant.
    await insertTenantModule(MODULE.alert, USER.otherTenant);

    await withTransaction((runner) => new AddUserModuleAssignmentRole1819300000000().up(runner));
    await withTransaction((runner) =>
      new BackfillUserModuleAssignmentRole1819400000000().up(runner),
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await shutdownHarness(harness);
  });

  it('applies the ADR-051 rule to every existing row', async () => {
    expect(await roleOf(USER.globalManager, MODULE.farm)).toBe('MODULE_MANAGER');
    // Never from the global role (D6).
    expect(await roleOf(USER.globalManager, MODULE.hr)).toBe('MODULE_USER');
    expect(await roleOf(USER.globalManager, MODULE.alert)).toBe('MODULE_MANAGER');
    expect(await roleOf(USER.hrPrimary, MODULE.hr)).toBe('MODULE_MANAGER');
    expect(await roleOf(USER.member, MODULE.farm)).toBe('MODULE_USER');
    // A managerId on a row that exists makes it a manager row.
    expect(await roleOf(USER.designatedFarmMember, MODULE.farm)).toBe('MODULE_MANAGER');
  });

  it('inserts the missing row of a designated manager, except for hr and across tenants', async () => {
    expect(await roleOf(USER.designatedSensor, MODULE.sensor)).toBe('MODULE_MANAGER');
    expect(await rowsOf(USER.designatedHr)).toEqual([]);
    expect(await rowsOf(USER.otherTenant)).toEqual([]);
  });

  it('refuses a role that is not a module role', async () => {
    await expect(
      requireAdmin().query(
        `UPDATE auth.user_module_assignments SET role = 'TENANT_ADMIN' WHERE "userId" = $1`,
        [USER.member],
      ),
    ).rejects.toThrow(/CHK_user_module_assignments_role/u);
  });

  it('fills, on a re-run, a row an old container inserted without a role, and changes nothing else', async () => {
    // An explicit role written by a new writer is not recomputed.
    await requireAdmin().query(
      `UPDATE auth.user_module_assignments SET role = 'MODULE_USER' WHERE "userId" = $1 AND "moduleId" = $2`,
      [USER.globalManager, MODULE.farm],
    );
    // The INSERT an R0 container issues: it names no role.
    await insertAssignment(USER.member, MODULE.sensor, false);
    expect(await roleOf(USER.member, MODULE.sensor)).toBeNull();
    const before = await allRows();

    await withTransaction((runner) =>
      new BackfillUserModuleAssignmentRole1819400000000().up(runner),
    );

    const after = await allRows();
    expect(await roleOf(USER.member, MODULE.sensor)).toBe('MODULE_USER');
    expect(
      after.filter((row) => !(row.userId === USER.member && row.moduleId === MODULE.sensor)),
    ).toEqual(
      before.filter((row) => !(row.userId === USER.member && row.moduleId === MODULE.sensor)),
    );
    expect(await roleOf(USER.globalManager, MODULE.farm)).toBe('MODULE_USER');
  });

  it('fails when a row is left without a role', async () => {
    // A row whose user no longer joins (the foreign key dropped for the fixture only).
    await requireAdmin().query(
      `ALTER TABLE auth.user_module_assignments DROP CONSTRAINT "FK_fixture_uma_user"`,
    );
    await requireAdmin().query(
      `INSERT INTO auth.user_module_assignments ("userId", "moduleId", "tenantId", "assignedBy")
       VALUES ($1, $2, $3, $1)`,
      ['30000000-0000-4000-8000-000000000001', MODULE.farm, TENANT],
    );

    await expect(
      withTransaction((runner) => new BackfillUserModuleAssignmentRole1819400000000().up(runner)),
    ).rejects.toThrow('1 user_module_assignments row(s) have no role after the backfill');
  });

  async function insertUser(id: string, role: string, tenantId: string): Promise<void> {
    await requireAdmin().query(
      `INSERT INTO auth.users (id, role, "tenantId") VALUES ($1, $2, $3)`,
      [id, role, tenantId],
    );
  }

  async function insertAssignment(
    userId: string,
    moduleId: string,
    isPrimaryManager: boolean,
  ): Promise<void> {
    await requireAdmin().query(
      `INSERT INTO auth.user_module_assignments ("userId", "moduleId", "tenantId", "isPrimaryManager", "assignedBy")
       VALUES ($1, $2, $3, $4, $1)`,
      [userId, moduleId, TENANT, isPrimaryManager],
    );
  }

  async function insertTenantModule(moduleId: string, managerId: string): Promise<void> {
    await requireAdmin().query(
      `INSERT INTO auth.tenant_modules ("tenantId", "moduleId", "managerId") VALUES ($1, $2, $3)`,
      [TENANT, moduleId, managerId],
    );
  }

  async function roleOf(userId: string, moduleId: string): Promise<string | null | undefined> {
    const rows = await requireAdmin().query<Array<{ role: string | null }>>(
      `SELECT role FROM auth.user_module_assignments WHERE "userId" = $1 AND "moduleId" = $2`,
      [userId, moduleId],
    );
    return rows[0]?.role;
  }

  async function rowsOf(userId: string): Promise<RoleRow[]> {
    return requireAdmin().query<RoleRow[]>(
      `SELECT "userId", "moduleId", role FROM auth.user_module_assignments WHERE "userId" = $1`,
      [userId],
    );
  }

  async function allRows(): Promise<RoleRow[]> {
    return requireAdmin().query<RoleRow[]>(
      `SELECT "userId", "moduleId", role FROM auth.user_module_assignments ORDER BY "userId", "moduleId"`,
    );
  }

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  /** The runner applies a migration inside a transaction, which SET LOCAL needs. */
  async function withTransaction(
    operation: (queryRunner: QueryRunner) => Promise<void>,
  ): Promise<void> {
    const queryRunner = requireAdmin().createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      await operation(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
});
