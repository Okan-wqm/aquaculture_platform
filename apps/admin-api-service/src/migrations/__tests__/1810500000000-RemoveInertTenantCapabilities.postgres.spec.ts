import { Logger } from '@nestjs/common';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource } from 'typeorm';

import { CreateAdminEntitySurfaceTables1800200000000 } from '../1800200000000-CreateAdminEntitySurfaceTables';
import { RemoveInertTenantCapabilities1810500000000 } from '../1810500000000-RemoveInertTenantCapabilities';

/**
 * RBAC-HIGH-025 cleanup on real Postgres. The mocked spec beside this one pins the in-memory
 * filtering; this one pins what only a database can show: the `FOR UPDATE OF` reads over a join
 * with an ORDER BY, the `$2::text[]` and `COALESCE($1::jsonb, …)` writes, jsonb round trips, role
 * rows whose tenant is NULL, and the row locks a concurrent role edit waits on.
 *
 * The tables are the ones 1800200000000 creates (admin-api owns their DDL), and the migration runs
 * the way the runner runs it, in a transaction of its own (`transaction: 'each'`).
 */

const TENANT_A = '0a000000-0000-4000-8000-00000000000a';
const TENANT_B = '0b000000-0000-4000-8000-00000000000b';
const ADMIN_USER = '0f000000-0000-4000-8000-00000000000f';

const ROLE_A_MIXED = '1a000000-0000-4000-8000-000000000001';
const ROLE_A_CLEAN = '1a000000-0000-4000-8000-000000000002';
const ROLE_A_DISPLAY = '1a000000-0000-4000-8000-000000000003';
const ROLE_B_PARTLY_INERT = '1b000000-0000-4000-8000-000000000001';
const ROLE_B_ALL_INERT = '1b000000-0000-4000-8000-000000000002';
const ROLE_B_MALFORMED_PANEL = '1b000000-0000-4000-8000-000000000003';
const ROLE_TEMPLATE = '1c000000-0000-4000-8000-000000000001';

const ASSIGN_A_INERT = '2a000000-0000-4000-8000-000000000001';
const ASSIGN_A_DEFAULT = '2a000000-0000-4000-8000-000000000002';
const ASSIGN_B_CLEAN = '2b000000-0000-4000-8000-000000000001';
const ASSIGN_B_ALL_INERT = '2b000000-0000-4000-8000-000000000002';
const ASSIGN_TEMPLATE = '2c000000-0000-4000-8000-000000000001';

type Panel = Record<string, Record<string, Record<string, unknown>>>;

interface StoredRole {
  panel: unknown;
  grants: string[];
}

jest.setTimeout(240_000);

describe('RemoveInertTenantCapabilities1810500000000 on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let logged: Array<Record<string, unknown>>;

  function db(): DataSource {
    if (harness === undefined) throw new Error('the Postgres harness did not boot');
    return harness.dataSource;
  }

  async function role(
    id: string,
    tenantId: string | null,
    panel: Panel,
    grants: readonly string[],
  ): Promise<void> {
    await db().query(
      `INSERT INTO "auth"."tenant_roles" (id, "tenantId", name) VALUES ($1, $2, $3)`,
      [id, tenantId, `role ${id.slice(0, 8)}`],
    );
    await db().query(
      `INSERT INTO "auth"."tenant_role_permissions" (role_id, panel_permissions, resource_permissions)
       VALUES ($1, $2::jsonb, $3::text[])`,
      [id, JSON.stringify(panel), [...grants]],
    );
  }

  async function assignment(id: string, roleId: string, overrides?: object): Promise<void> {
    const userId = `3${id.slice(1)}`;
    if (overrides === undefined) {
      // The column default, as the auth write path leaves it for a user with no overrides.
      await db().query(
        `INSERT INTO "auth"."user_role_assignments" (id, user_id, role_id, assigned_by)
         VALUES ($1, $2, $3, $4)`,
        [id, userId, roleId, ADMIN_USER],
      );
      return;
    }
    await db().query(
      `INSERT INTO "auth"."user_role_assignments"
         (id, user_id, role_id, permission_overrides, assigned_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [id, userId, roleId, JSON.stringify(overrides), ADMIN_USER],
    );
  }

  /** The runner's shape for this migration: one transaction, committed or rolled back. */
  async function migrate(): Promise<void> {
    const queryRunner = db().createQueryRunner();
    try {
      await queryRunner.startTransaction();
      await new RemoveInertTenantCapabilities1810500000000().up(queryRunner);
      await queryRunner.commitTransaction();
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async function storedRoles(): Promise<Record<string, StoredRole>> {
    const rows: Array<{
      role_id: string;
      panel_permissions: unknown;
      resource_permissions: string[];
    }> = await db().query(
      `SELECT role_id, panel_permissions, resource_permissions FROM "auth"."tenant_role_permissions"`,
    );
    return Object.fromEntries(
      rows.map((row) => [
        row.role_id,
        { panel: row.panel_permissions, grants: row.resource_permissions },
      ]),
    );
  }

  async function storedOverrides(): Promise<Record<string, unknown>> {
    const rows: Array<{ id: string; permission_overrides: unknown }> = await db().query(
      `SELECT id, permission_overrides FROM "auth"."user_role_assignments"`,
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.permission_overrides]));
  }

  /** Each row's version: unchanged exactly when no statement wrote the row. */
  async function rowVersions(): Promise<Record<string, string>> {
    const rows: Array<{ id: string; version: string }> = await db().query(`
      SELECT 'role:' || role_id AS id, xmin::text AS version FROM "auth"."tenant_role_permissions"
      UNION ALL
      SELECT 'assignment:' || id, xmin::text FROM "auth"."user_role_assignments"
    `);
    return Object.fromEntries(rows.map((row) => [row.id, row.version]));
  }

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    await db().query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db().query('CREATE SCHEMA "auth"');
    await db().query('CREATE SCHEMA "admin"');
    const queryRunner = db().createQueryRunner();
    try {
      await new CreateAdminEntitySurfaceTables1800200000000().up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    await role(
      ROLE_A_MIXED,
      TENANT_A,
      {
        company: { company: { view: true } },
        farm: { sites: { view: true, create: false } },
        admin: { settings: { view: true, edit: true }, users: { view: true } },
      },
      ['company:view', 'sites:view', 'settings:view', 'settings:edit', 'users:view'],
    );
    await role(ROLE_A_CLEAN, TENANT_A, { admin: { roles: { view: true } } }, ['roles:view']);
    // Saved by the role editor under display names (RBAC-MEDIUM-033): no removed key, not touched.
    await role(
      ROLE_A_DISPLAY,
      TENANT_A,
      { farm: { Sites: { view: true } }, hr: { 'HR Finance': { view_salary: true } } },
      [],
    );
    await role(
      ROLE_B_PARTLY_INERT,
      TENANT_B,
      {
        messaging: { channels: { view: true, create_group: true }, messages: { send: true } },
        operations: { feeding: { record: true } },
      },
      ['channels:view', 'channels:create_group', 'messages:send', 'feeding:record'],
    );
    await role(ROLE_B_ALL_INERT, TENANT_B, { farm: { tanks: { view: true, assign: true } } }, [
      'tanks:view',
      'tanks:assign',
    ]);
    // Not a panel (a non-boolean action): left as stored while the grant list is cleaned.
    await role(ROLE_B_MALFORMED_PANEL, TENANT_B, { admin: { users: { view: 'yes' } } }, [
      'users:view',
      'dashboard:view',
    ]);
    await role(ROLE_TEMPLATE, null, { reports: { reports: { view: true } } }, ['reports:view']);

    await assignment(ASSIGN_A_INERT, ROLE_A_CLEAN, {
      grants: ['batches:create', 'company:view'],
      revokes: ['users:view', 'employees:view'],
    });
    await assignment(ASSIGN_A_DEFAULT, ROLE_A_MIXED);
    await assignment(ASSIGN_B_CLEAN, ROLE_B_ALL_INERT, {
      grants: ['edge_devices:manage_io_config'],
      revokes: [],
    });
    await assignment(ASSIGN_B_ALL_INERT, ROLE_B_PARTLY_INERT, {
      grants: ['shifts:view'],
      revokes: ['leave:approve'],
    });
    await assignment(ASSIGN_TEMPLATE, ROLE_TEMPLATE, { grants: ['sensors:view'], revokes: [] });
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(JSON.parse(String(message)) as Record<string, unknown>);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes the removed keys from grants, panels and overrides, and nothing else', async () => {
    const untouched = await rowVersions();

    await migrate();

    expect(await storedRoles()).toEqual({
      [ROLE_A_MIXED]: {
        panel: {
          company: { company: { view: true } },
          admin: { settings: { view: true }, users: { view: true } },
        },
        grants: ['company:view', 'settings:view', 'users:view'],
      },
      [ROLE_A_CLEAN]: { panel: { admin: { roles: { view: true } } }, grants: ['roles:view'] },
      [ROLE_A_DISPLAY]: {
        panel: { farm: { Sites: { view: true } }, hr: { 'HR Finance': { view_salary: true } } },
        grants: [],
      },
      [ROLE_B_PARTLY_INERT]: {
        panel: { messaging: { channels: { create_group: true } } },
        grants: ['channels:create_group'],
      },
      [ROLE_B_ALL_INERT]: { panel: {}, grants: [] },
      [ROLE_B_MALFORMED_PANEL]: {
        panel: { admin: { users: { view: 'yes' } } },
        grants: ['users:view'],
      },
      [ROLE_TEMPLATE]: { panel: {}, grants: [] },
    });
    expect(await storedOverrides()).toEqual({
      [ASSIGN_A_INERT]: { grants: ['company:view'], revokes: ['users:view'] },
      [ASSIGN_A_DEFAULT]: { grants: [], revokes: [] },
      [ASSIGN_B_CLEAN]: { grants: ['edge_devices:manage_io_config'], revokes: [] },
      [ASSIGN_B_ALL_INERT]: { grants: [], revokes: [] },
      [ASSIGN_TEMPLATE]: { grants: [], revokes: [] },
    });

    // Only the rows that held a removed key were written.
    const after = await rowVersions();
    const written = Object.keys(after).filter((id) => after[id] !== untouched[id]);
    expect(written.sort()).toEqual(
      [
        `role:${ROLE_A_MIXED}`,
        `role:${ROLE_B_PARTLY_INERT}`,
        `role:${ROLE_B_ALL_INERT}`,
        `role:${ROLE_B_MALFORMED_PANEL}`,
        `role:${ROLE_TEMPLATE}`,
        `assignment:${ASSIGN_A_INERT}`,
        `assignment:${ASSIGN_B_ALL_INERT}`,
        `assignment:${ASSIGN_TEMPLATE}`,
      ].sort(),
    );

    // Counts per tenant; a role without a tenant (a template row) is counted under null.
    expect(logged).toEqual([
      {
        event: 'inert_tenant_capabilities_removed',
        tenantId: TENANT_A,
        roles: 1,
        roleGrants: 2,
        assignments: 1,
        overrideEntries: 2,
      },
      {
        event: 'inert_tenant_capabilities_removed',
        tenantId: TENANT_B,
        roles: 3,
        roleGrants: 6,
        assignments: 1,
        overrideEntries: 2,
      },
      {
        event: 'inert_tenant_capabilities_removed',
        tenantId: null,
        roles: 1,
        roleGrants: 1,
        assignments: 1,
        overrideEntries: 1,
      },
      { event: 'inert_tenant_capabilities_cleanup_done', tenants: 3, roles: 5, assignments: 3 },
    ]);
  });

  it('writes nothing on a second run and logs zero counts', async () => {
    const before = await rowVersions();

    await migrate();

    expect(await rowVersions()).toEqual(before);
    expect(logged).toEqual([
      { event: 'inert_tenant_capabilities_cleanup_done', tenants: 0, roles: 0, assignments: 0 },
    ]);
  });

  it('holds a lock on every row it read until its transaction ends, so a role edit waits', async () => {
    const migration = db().createQueryRunner();
    const editor = db().createQueryRunner();
    await editor.query(`SET lock_timeout = '300ms'`);
    try {
      await migration.startTransaction();
      await new RemoveInertTenantCapabilities1810500000000().up(migration);

      // Rows the run read but did not write are locked too.
      await expect(
        editor.query(
          `UPDATE "auth"."tenant_role_permissions" SET resource_permissions = $1::text[] WHERE role_id = $2`,
          [['batches:create'], ROLE_A_CLEAN],
        ),
      ).rejects.toMatchObject({ driverError: { code: '55P03' } });
      await expect(
        editor.query(
          `UPDATE "auth"."user_role_assignments" SET permission_overrides = $1::jsonb WHERE id = $2`,
          [JSON.stringify({ grants: ['batches:create'], revokes: [] }), ASSIGN_B_CLEAN],
        ),
      ).rejects.toMatchObject({ driverError: { code: '55P03' } });
    } finally {
      if (migration.isTransactionActive) await migration.rollbackTransaction();
      await editor.query('RESET lock_timeout');
      await editor.release();
      await migration.release();
    }
  });
});
