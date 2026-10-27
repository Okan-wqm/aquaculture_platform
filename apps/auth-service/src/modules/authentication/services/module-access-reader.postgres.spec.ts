import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import type { DataSource } from 'typeorm';

import { readModuleAccess, type ModuleAccessQuery } from './module-access-reader';

jest.setTimeout(120_000);

const TENANT = '7f6b08ab-90e2-46d3-a260-cb985f1fd897';
const OTHER_TENANT = '2c1e5d4f-8a3b-4c6d-9e7f-0a1b2c3d4e5f';
const MEMBER = '20000000-0000-4000-8000-000000000001';

const MODULE = {
  farm: '10000000-0000-4000-8000-000000000001',
  hr: '10000000-0000-4000-8000-000000000002',
  sensor: '10000000-0000-4000-8000-000000000003',
  alert: '10000000-0000-4000-8000-000000000004',
  hydroponics: '10000000-0000-4000-8000-000000000005',
} as const;

/**
 * RBAC-MEDIUM-029 on a real Postgres: the member read of the module-access reader joins the
 * tenant's enabled modules, keeps only live assignments of the token's tenant, and takes the
 * grant from the row's role. The unit spec pins the SQL text; this one runs it.
 */
describe('readModuleAccess on real Postgres (RBAC-MEDIUM-029)', () => {
  let harness: HarnessContext | undefined;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    const db = requireAdmin();
    await db.query('CREATE SCHEMA auth');
    await db.query(`
      CREATE TABLE auth.modules (
        id uuid PRIMARY KEY,
        code varchar(50) NOT NULL UNIQUE,
        name varchar(100) NOT NULL,
        "defaultRoute" varchar(100) NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0
      )
    `);
    await db.query(`
      CREATE TABLE auth.tenant_modules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL,
        "moduleId" uuid NOT NULL,
        "isEnabled" boolean NOT NULL DEFAULT true
      )
    `);
    await db.query(`
      CREATE TABLE auth.user_module_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "moduleId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "isPrimaryManager" boolean NOT NULL DEFAULT false,
        "isActive" boolean NOT NULL DEFAULT true,
        "expiresAt" timestamptz,
        role varchar(32),
        "createdAt" timestamp NOT NULL DEFAULT now()
      )
    `);
    for (const [code, id] of Object.entries(MODULE)) {
      await db.query(
        `INSERT INTO auth.modules (id, code, name, "defaultRoute") VALUES ($1, $2, $2, $3)`,
        [id, code, `/${code}`],
      );
    }
    // The tenant has farm, hr, alert and hydroponics enabled; sensor was removed.
    for (const [moduleId, isEnabled] of [
      [MODULE.farm, true],
      [MODULE.hr, true],
      [MODULE.sensor, false],
      [MODULE.alert, true],
      [MODULE.hydroponics, true],
    ] as const) {
      await db.query(
        `INSERT INTO auth.tenant_modules ("tenantId", "moduleId", "isEnabled") VALUES ($1, $2, $3)`,
        [TENANT, moduleId, isEnabled],
      );
    }
    await assign(MODULE.farm, 'MODULE_MANAGER', { isPrimaryManager: true });
    await assign(MODULE.sensor, 'MODULE_MANAGER');
    await assign(MODULE.alert, 'MODULE_USER');
    await assign(MODULE.hr, 'MODULE_USER', { isActive: false });
    await assign(MODULE.hydroponics, 'MODULE_USER', { expired: true });
  });

  afterAll(async () => {
    await shutdownHarness(harness);
  });

  it('grants only live rows of enabled owner modules, from the row role', async () => {
    const read = await readModuleAccess(query(), {
      id: MEMBER,
      role: 'MODULE_MANAGER',
      tenantId: TENANT,
    });

    expect(read.moduleAccess).toEqual({ farm: 'MODULE_MANAGER' });
    expect(read.modules.map((module) => module.code)).toEqual(['farm', 'alert']);
    expect(read.dropped).toEqual({ not_owner_module: 1, unknown_code: 0, role_missing: 0 });
  });

  it('reads nothing from another tenant', async () => {
    const read = await readModuleAccess(query(), {
      id: MEMBER,
      role: 'MODULE_USER',
      tenantId: OTHER_TENANT,
    });

    expect(read.moduleAccess).toEqual({});
    expect(read.modules).toEqual([]);
  });

  it('lists every enabled module of the tenant for TENANT_ADMIN, the removed one excluded', async () => {
    const read = await readModuleAccess(query(), {
      id: MEMBER,
      role: 'TENANT_ADMIN',
      tenantId: TENANT,
    });

    expect(read.moduleAccess).toEqual({
      farm: 'MODULE_MANAGER',
      hr: 'MODULE_MANAGER',
      hydroponics: 'MODULE_MANAGER',
    });
  });

  async function assign(
    moduleId: string,
    role: string,
    options: { isPrimaryManager?: boolean; isActive?: boolean; expired?: boolean } = {},
  ): Promise<void> {
    await requireAdmin().query(
      `INSERT INTO auth.user_module_assignments
         ("userId", "moduleId", "tenantId", "isPrimaryManager", "isActive", "expiresAt", role)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() - interval '1 day' END, $7)`,
      [
        MEMBER,
        moduleId,
        TENANT,
        options.isPrimaryManager === true,
        options.isActive !== false,
        options.expired === true,
        role,
      ],
    );
  }

  function query(): ModuleAccessQuery {
    const db = requireAdmin();
    return (sql, params) => db.query(sql, [...params]);
  }

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }
});
