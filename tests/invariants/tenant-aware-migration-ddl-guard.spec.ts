import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join, relative } from 'path';

import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';
import {
  RETIRED_SOURCE_TABLES,
  REVIEWED_SOURCE_SCHEMA_DDL,
  isReviewedSourceSchemaDdl,
  moduleSchemaRegistry,
  qualifiedDdlOffences,
  sourcePinOffences,
  tenantAwareMigrationDirSchemas,
  type TenantAwareDdlRegistry,
} from '../../tools/gates/tenant-aware-migration-ddl';

/**
 * Tenant provisioning is migration REPLAY: the orchestrator pins
 * `search_path` to `tenant_<uuid>` and runs each tenant-aware service's
 * migration set. That mechanism only redirects UNQUALIFIED DDL. Anything that
 * names its schema explicitly — or re-pins the session to the source schema —
 * escapes it, lands in the source schema, and is STILL recorded in the tenant's
 * ledger as applied. This spec is the gate for that class.
 *
 * ## One owner, two readers (ARIA-MEDIUM-588)
 *
 * The rule — the classifier, the reviewer allowlist, the retired-table map and
 * the catalog-derived directory→schema map — lives in ONE owner,
 * `tools/gates/tenant-aware-migration-ddl.ts`. This spec fails the build on it
 * with the registry imported from the RUNTIME `MODULE_SCHEMAS`; ARIA's
 * `sql-migration-safety-adapter` observes the same verdicts with the registry
 * read from the workspace's own SSoT source text (the adapter-side reader that
 * resolves the spread entries this finding was about). The two registries are
 * held equal by `module-schemas-source-parity.spec.ts`, so the gate and the
 * observation cannot drift.
 *
 * `scripts/migration/dequalify-tenant-baselines.mjs` reads the same runtime
 * registry to decide what to rewrite. Two consumers of one SSoT, not two
 * SSoTs.
 *
 * ## Fail-closed
 *
 * A qualified identifier the registry cannot explain is a VIOLATION, not a
 * pass. An unregistered per-tenant table is exactly the shape that would
 * otherwise slip through, so "I don't recognise this" resolves against the
 * migration and lands in the reviewer allowlist with a written reason.
 */
const REPO_ROOT = join(__dirname, '..', '..');

function registryFor(schema: string): TenantAwareDdlRegistry {
  const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === schema);
  if (entry === undefined) {
    throw new Error(`MODULE_SCHEMAS has no entry for source schema "${schema}"`);
  }
  return moduleSchemaRegistry(entry, RETIRED_SOURCE_TABLES.get(schema) ?? new Set<string>());
}

function migrationFiles(): Array<readonly [string, string]> {
  const files: Array<readonly [string, string]> = [];
  for (const [dir, schema] of tenantAwareMigrationDirSchemas()) {
    if (!existsSync(join(REPO_ROOT, dir))) continue;
    for (const entry of readdirSync(join(REPO_ROOT, dir))) {
      if (!/^\d.*\.ts$/.test(entry)) continue;
      files.push([`${dir}/${entry}`, schema] as const);
    }
  }
  return files;
}

describe('tenant-aware migration DDL guard', () => {
  it('no tenant-aware migration issues source-schema DDL against a per-tenant table', () => {
    const offences: { file: string; reason: string }[] = [];
    for (const [file, schema] of migrationFiles()) {
      if (isReviewedSourceSchemaDdl(file)) continue;
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      offences.push(
        ...qualifiedDdlOffences(relative(REPO_ROOT, file), source, schema, registryFor(schema)),
      );
    }

    expect(offences.map((o) => `${o.file}: ${o.reason}`)).toEqual([]);
  });

  it('no tenant-aware migration re-pins its own source schema unless it is source-only', () => {
    const offences: { file: string; reason: string }[] = [];
    for (const [file, schema] of migrationFiles()) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      offences.push(...sourcePinOffences(relative(REPO_ROOT, file), source, schema));
    }

    expect(offences.map((o) => `${o.file}: ${o.reason}`)).toEqual([]);
  });

  it('every allowlisted migration still exists (no stale exemptions)', () => {
    const present = new Set(migrationFiles().map(([f]) => basename(f)));
    const stale = [...REVIEWED_SOURCE_SCHEMA_DDL].filter((name) => !present.has(name));
    expect(stale).toEqual([]);
  });

  it('every retired-table entry names a table the registry really does not carry', () => {
    const stale: string[] = [];
    for (const [schema, tables] of RETIRED_SOURCE_TABLES) {
      const registry = registryFor(schema);
      for (const table of tables) {
        if (registry.perTenant.has(table) || registry.infrastructure.has(table)) {
          stale.push(`${schema}.${table} is registered again — drop it from RETIRED_SOURCE_TABLES`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
