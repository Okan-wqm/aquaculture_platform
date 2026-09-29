import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import type { DataSource, QueryRunner } from 'typeorm';

/**
 * The red-team's application role and the tenant RLS policies it runs under
 * (K10 red-team, PR-T1 — the "UNVERIFIED: does the suite's role bypass RLS"
 * item of the verifier reports).
 *
 * WHY: the Testcontainers superuser bypasses every RLS policy, and a table
 * owner bypasses them unless FORCE is set. A red-team connected as either
 * would prove only the schema routing, never the RLS layer. The responders
 * therefore run as `redteam_app`: LOGIN, NOSUPERUSER, NOBYPASSRLS, owner of
 * nothing — and every per-tenant table carries the production policy,
 * installed by the same helper production's tenant RLS sync uses
 * (`applyTenantRlsToSchema` with a schema override: `CREATE TABLE … LIKE …
 * INCLUDING ALL` copies no policy, exactly as in production).
 */
export const REDTEAM_APP_ROLE = 'redteam_app';
const REDTEAM_APP_PASSWORD = 'redteam-app';

const QUIET = { log: (): void => undefined, warn: (): void => undefined };

/**
 * Run `fn` on an admin query runner with db-migrate's DDL authority: the RLS
 * helper and the migrations are db-migrate's DDL, and the harness stands in
 * for db-migrate while it provisions.
 */
export async function asDbMigrate<T>(
  admin: DataSource,
  fn: (runner: QueryRunner) => Promise<T>,
): Promise<T> {
  const previous = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  const runner = admin.createQueryRunner();
  try {
    await runner.connect();
    return await fn(runner);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
    else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previous;
    await runner.release();
  }
}

/** Install the tenant isolation policy (ENABLE + FORCE RLS) on every tenant-keyed table of `schemas`. */
export async function installTenantRls(
  admin: DataSource,
  schemas: readonly string[],
): Promise<void> {
  await asDbMigrate(admin, async (runner) => {
    for (const schema of schemas) {
      await applyTenantRlsToSchema(runner, { schemaOverride: schema, logger: QUIET });
    }
  });
}

/** Create the non-bypassing application role with DML on `schemas`; returns its credentials. */
export async function createAppRole(
  admin: DataSource,
  schemas: readonly string[],
): Promise<{ username: string; password: string }> {
  await admin.query(
    `CREATE ROLE "${REDTEAM_APP_ROLE}" LOGIN PASSWORD '${REDTEAM_APP_PASSWORD}'
       NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  for (const schema of [...schemas, 'public']) {
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${REDTEAM_APP_ROLE}"`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${REDTEAM_APP_ROLE}"`,
    );
    await admin.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${REDTEAM_APP_ROLE}"`,
    );
  }
  return { username: REDTEAM_APP_ROLE, password: REDTEAM_APP_PASSWORD };
}

/** What the database says about the role a DataSource connects as, and the tables it reads. */
export interface RlsPosture {
  readonly role: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** Tenant-keyed tables the role would read unprotected: no RLS, no FORCE, or owned by the role. */
  readonly unprotectedTables: string[];
}

/** Read the RLS posture of `app` for the tenant-keyed tables of `schemas`. */
export async function readRlsPosture(
  app: DataSource,
  schemas: readonly string[],
): Promise<RlsPosture> {
  const [role] = (await app.query(
    `SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls"
       FROM pg_roles r WHERE r.rolname = current_user`,
  )) as Array<{ role: string; superuser: boolean; bypassRls: boolean }>;
  const tables = (await app.query(
    `SELECT n.nspname || '.' || c.relname AS name,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            pg_get_userbyid(c.relowner) = current_user AS owned,
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid) AS "hasPolicy"
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1)
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                      AND a.attname IN ('tenantId', 'tenant_id') AND NOT a.attisdropped)`,
    [schemas],
  )) as Array<{ name: string; rls: boolean; forced: boolean; owned: boolean; hasPolicy: boolean }>;
  return {
    role: role?.role ?? 'unknown',
    superuser: role?.superuser ?? true,
    bypassRls: role?.bypassRls ?? true,
    unprotectedTables: tables
      .filter((t) => !t.rls || !t.forced || !t.hasPolicy || t.owned)
      .map((t) => t.name),
  };
}
