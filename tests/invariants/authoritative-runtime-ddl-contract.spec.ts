/**
 * Platform-wide invariant — DATA-HIGH-004 (PR#363 reimplement-port):
 *
 * **Authoritative deployments must not register unconditional runtime DDL
 * bootstraps, and the db-migrate authority decision must have exactly ONE
 * resolver.**
 *
 * # WHY
 *
 * `aqua-db-migrate` is the single schema-DDL writer in production
 * (ADR-033). Runtime services express schema intent through migrations
 * and `SCHEMA_REGISTRY.postMigrationHardening` — never through
 * boot-time DDL. Three regression classes this invariant pins:
 *
 *   1. An app.module registering `autoApply: true` /
 *      `syncTenantSchemas: true` UNCONDITIONALLY re-introduces a second
 *      DDL writer the moment the helper-level guard is relaxed, and in
 *      the meantime produces a swallowed `rls.bootstrap.failed` log on
 *      every production cold start (alert noise that trains operators
 *      to ignore the real signal).
 *   2. A second "is db-migrate authoritative?" resolver (inline env
 *      parse in a factory or app.module) drifts from the canonical
 *      strict-parse resolver — a drifted answer on this question is a
 *      schema-ownership incident.
 *   3. A service whose runtime RLS/audit DDL is gated off WITHOUT a
 *      matching `postMigrationHardening` registry entry silently loses
 *      its hardening in production (nobody installs the policies).
 *
 * # Scope notes (today's architecture, diverging from the PR#363 base)
 *
 *   - The source-schema write guard is reconciled by aqua-db-migrate via
 *     `assertSourceSchemaWriteGuards` (source-schema-write-guard-reconciler.ts);
 *     runtime services register NO write-guard provider — asserted directly.
 *   - `TenantSchemaSyncService` is read-only (see
 *     no-boot-time-tenant-schema-ddl.spec.ts) — tenant-provisioning DDL
 *     legitimately lives in db-migrate's tenant-schema-provisioner.
 *   - `event_store` installs RLS via its own migration
 *     (EventLedgerHardening1800100000000) and `admin` via the admin-api
 *     migration chain — both are exempt from the hardening-registry list.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const APP_MODULES = [
  'auth-service',
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'notification-service',
  'config-service',
  'hydroponics-service',
  'alert-engine',
  'ai-service',
  'billing-service',
  'event-store-service',
  'observability-service',
] as const;

/**
 * Schemas whose runtime DDL is authority-gated and whose production
 * hardening therefore MUST come from the db-migrate registry.
 */
const HARDENED_SCHEMAS = [
  'auth',
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'billing',
  'notification',
  'ai',
  'config',
] as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function repoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function appModuleSource(service: string): string {
  return stripComments(repoFile(`apps/${service}/src/app.module.ts`));
}

describe('INVARIANT (DATA-HIGH-004): authoritative deployments do not register runtime DDL bootstraps unconditionally', () => {
  it.each(APP_MODULES)('%s has no unconditional RLS DDL bootstrap flags', (service) => {
    const src = appModuleSource(service);
    expect(src).not.toMatch(/autoApply\s*:\s*true/);
    expect(src).not.toMatch(/syncTenantSchemas\s*:\s*true/);
  });

  it.each(APP_MODULES)('%s gates AuditColumnsModule behind db-migrate authority', (service) => {
    const src = appModuleSource(service);
    if (!src.includes('AuditColumnsModule.forRoot')) {
      return;
    }

    expect(src).toContain('isSchemaDdlOwnedByDbMigrate(process.env)');
    expect(src).toMatch(/\?\s*\[\]\s*:\s*\[\s*AuditColumnsModule\.forRoot/);
  });
});

describe('INVARIANT (DATA-HIGH-004): the authority decision has exactly one resolver', () => {
  it('keeps isSchemaDdlOwnedByDbMigrate as an alias of resolveDbMigrateAuthoritative', () => {
    const src = stripComments(
      repoFile('libs/backend-common/src/database/db-migrate-authority.util.ts'),
    );
    // Alias-not-fork: the historical name must be a `const` binding to the
    // canonical resolver, not a second function body that can drift.
    expect(src).toContain(
      'export const isSchemaDdlOwnedByDbMigrate = resolveDbMigrateAuthoritative;',
    );
    expect(src).toContain('export function assertRuntimeDdlAllowed(');
  });

  it.each([
    'libs/backend-common/src/database/typeorm-config.factory.ts',
    'libs/backend-common/src/database/schema-version-gate.service.ts',
  ] as const)('%s consumes the shared ConfigService resolver', (file) => {
    const src = stripComments(repoFile(file));
    expect(src).toContain('resolveDbMigrateAuthoritativeFromConfig(');
    // No inline re-derivation of the explicit flag: the only acceptable
    // reads of DB_MIGRATE_AUTHORITATIVE outside the util are the
    // gate-specific explicit-false rejection in schema-version-gate.
    expect(src).not.toMatch(/DB_MIGRATE_AUTHORITATIVE[^\n]*===\s*'true'/);
  });
});

describe('INVARIANT (DATA-HIGH-004): runtime DDL choke-points consult assertRuntimeDdlAllowed', () => {
  it.each([
    'libs/backend-common/src/database/rls/rls-schema-bootstrap.service.ts',
    'libs/backend-common/src/database/rls/tenant-rls-sync.service.ts',
    'libs/backend-common/src/database/convert-audit-columns-to-timestamptz.helper.ts',
  ] as const)('%s calls the choke-point assertion', (file) => {
    const src = stripComments(repoFile(file));
    expect(src).toContain('assertRuntimeDdlAllowed({');
  });

  it('no runtime service registers a source-schema write-guard provider (guard DDL is db-migrate-owned)', () => {
    // The source-schema write guard is now reconciled at deploy time by
    // aqua-db-migrate (assertSourceSchemaWriteGuards); the runtime no-op
    // SourceSchemaWriteGuardService was removed. Assert no runtime app module
    // re-introduces a boot-time write-guard installer.
    for (const svc of APP_MODULES) {
      expect(appModuleSource(svc)).not.toContain('SourceSchemaWriteGuardService');
    }
  });
});

describe('INVARIANT (DATA-HIGH-004): observability participates in the schema authority contract', () => {
  it('observability-service is schema gated and remains non-tenant-aware', () => {
    const src = appModuleSource('observability-service');
    expect(src).toContain("createSchemaVersionGate('observability'");
    expect(src).toMatch(/tenantAware\s*:\s*false/);
    expect(src).toMatch(/migrationsRunFromEnv\s*:/);
    expect(src).not.toMatch(/TenantSchemaSyncService|syncTenantSchemas\s*:/);
  });
});

describe('INVARIANT (DATA-HIGH-004): db-migrate registry owns post-migration hardening for authority-gated schemas', () => {
  // Parse the prettier-formatted SCHEMA_REGISTRY into per-entry chunks so
  // a hardening block from a NEIGHBOURING entry can never satisfy the
  // assertion for a schema that lacks one (a non-greedy cross-entry match
  // was a latent false-pass in the PR#363 original).
  const registrySrc = repoFile('apps/db-migrate/src/schema-registry.ts');
  const entryChunks = new Map<string, string>();
  const entryRe = /\n {2}\{\n {4}service: '([a-z-]+)',\n {4}schema: '([a-z_]+)',([\s\S]*?)\n {2}\},/g;
  for (const match of registrySrc.matchAll(entryRe)) {
    const schema = match[2];
    const body = match[3];
    if (schema !== undefined && body !== undefined) {
      entryChunks.set(schema, body);
    }
  }

  it('parses every registry entry (guard against format drift)', () => {
    // 15 schemas registered today — if the prettier shape changes, this
    // fails loudly instead of silently skipping the per-schema checks.
    expect(entryChunks.size).toBeGreaterThanOrEqual(14);
  });

  it('the shared tenant hardening constant installs tenant RLS', () => {
    // Tenant-aware entries reference TENANT_SCHEMA_POST_MIGRATION_HARDENING
    // instead of inlining the block — assert the constant itself carries
    // the RLS install so the per-entry check below can accept either form.
    expect(registrySrc).toMatch(
      /TENANT_SCHEMA_POST_MIGRATION_HARDENING: SchemaPostMigrationHardening = \{\n {2}tenantRls: true,/,
    );
  });

  it.each(HARDENED_SCHEMAS)('schema %s declares postMigrationHardening', (schema) => {
    const chunk = entryChunks.get(schema);
    expect(chunk).toBeDefined();
    expect(chunk).toContain('postMigrationHardening');
    // Either an inline hardening object naming tenantRls, or the shared
    // tenant-schema constant (verified above to install tenant RLS).
    expect(chunk).toMatch(/tenantRls|TENANT_SCHEMA_POST_MIGRATION_HARDENING/);
  });
});
