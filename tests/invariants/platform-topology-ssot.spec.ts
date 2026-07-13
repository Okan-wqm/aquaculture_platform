import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PLATFORM_SCHEMA_TOPOLOGY,
  bootstrapCreatedSchemas,
  bootstrapSignalSchemas,
  migrationRunnerSchemas,
  moduleManifestSchemas,
  tenantAwareSchemas,
  platformFunctions,
} from '../../platform/libs/service-catalog/src';

/**
 * PLATFORM TOPOLOGY SSoT — positive parity.
 *
 * `PLATFORM_SCHEMA_TOPOLOGY` (@platform/service-catalog) is the single source of
 * truth for WHICH database schemas exist and their role flags. The bootstrap
 * writer, boot gate, migration runner, `003-schemas.sql`, and MODULE_SCHEMAS
 * each USED to hand-copy an overlapping subset — five lists that drifted, and a
 * stale count literal crash-looped every backend on 2026-07-13
 * (ORPHAN-HIGH-387/405). Now every consumer derives from the topology; this
 * spec pins the topology against the still-independent hand-maintained
 * artifacts so that adding/removing a schema in ANY of them without updating
 * the topology fails loudly here (positive parity — NOT a bare-literal grep,
 * which is unwinnable per the review).
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function sorted(list: readonly string[]): string[] {
  return [...list].sort();
}

/** Capture group 1 of every match, dropping any that failed to capture. */
function captures(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map((m) => m[1]).filter((s): s is string => s !== undefined);
}

describe('platform schema topology SSoT', () => {
  it('has no duplicate schema entries', () => {
    const names = PLATFORM_SCHEMA_TOPOLOGY.map((s) => s.schema);
    expect(new Set(names).size).toBe(names.length);
  });

  it('bootstrapCreatedSchemas() matches 003-schemas.sql CREATE SCHEMA', () => {
    const sql = read('apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql');
    const created = captures(sql, /CREATE SCHEMA IF NOT EXISTS\s+([a-z_]+)/gi);
    expect(sorted(bootstrapCreatedSchemas())).toEqual(sorted(created));
  });

  it('003-schemas.sql internal verification list + count match its CREATE SCHEMA set', () => {
    // 003-schemas.sql carries the schema list THREE times: the CREATE SCHEMA
    // statements, the `required_schemas TEXT[]` verification array, and the
    // "All N platform schemas verified" NOTICE. These are hand-maintained SQL
    // (a TS codegen would over-reach for a role-bearing DO-block file), so pin
    // them to each other here — a schema added to CREATE SCHEMA but not the
    // verification array would otherwise slip through unverified, and the count
    // notice would go stale (the ORPHAN-HIGH-405 within-file mini-drift).
    const sql = read('apps/db-migrate/src/sql/platform-bootstrap/003-schemas.sql');
    const created = captures(sql, /CREATE SCHEMA IF NOT EXISTS\s+([a-z_]+)/gi);

    const arrayBlock = /required_schemas\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]/i.exec(sql);
    expect(arrayBlock).not.toBeNull();
    const verified = captures(arrayBlock?.[1] ?? '', /'([a-z_]+)'/g);
    expect(sorted(verified)).toEqual(sorted(created));

    const noticeMatch = /All\s+(\d+)\s+platform schemas verified/.exec(sql);
    expect(noticeMatch).not.toBeNull();
    expect(Number(noticeMatch?.[1])).toBe(created.length);
  });

  it('migrationRunnerSchemas() matches SCHEMA_REGISTRY schema entries', () => {
    const registry = read('apps/db-migrate/src/schema-registry.ts');
    const schemas = captures(registry, /^\s{4}schema:\s+'([a-z_]+)'/gm);
    expect(sorted(migrationRunnerSchemas())).toEqual(sorted(schemas));
  });

  it('moduleManifestSchemas() matches MODULE_SCHEMAS sourceSchema set', () => {
    const mgr = read('libs/backend-common/src/database/schema-manager.service.ts');
    const schemas = [...new Set(captures(mgr, /sourceSchema:\s+'([a-z_]+)'/g))];
    expect(sorted(moduleManifestSchemas())).toEqual(sorted(schemas));
  });

  it('every countedInBootstrapSignal schema is also createdInBootstrap', () => {
    // The bootstrap-signal count can only cover schemas the bootstrap actually
    // creates. (compliance is created-but-not-counted; platform is neither.)
    const created = new Set(bootstrapCreatedSchemas());
    for (const schema of bootstrapSignalSchemas()) {
      expect(created.has(schema)).toBe(true);
    }
  });

  it('every tenant-aware schema owns a migration runner and a module manifest', () => {
    const runners = new Set(migrationRunnerSchemas());
    const manifests = new Set(moduleManifestSchemas());
    for (const schema of tenantAwareSchemas()) {
      expect(runners.has(schema)).toBe(true);
      expect(manifests.has(schema)).toBe(true);
    }
  });

  it('boot gate DERIVES its count expectations (no re-introduced literal)', () => {
    // Guards the exact 2026-07-13 crash site: EXPECTED_SCHEMA_COUNT /
    // EXPECTED_FUNCTION_COUNT must be derived from the topology, never a bare
    // numeric literal. Targeted positive assertion (mirrors the
    // EXPECTED_SHARED_TABLE_COUNT guard in shared-schema-canonical.spec.ts).
    const gate = read('libs/backend-common/src/database/schema-version-gate.service.ts');
    expect(gate).toMatch(/EXPECTED_SCHEMA_COUNT\s*=\s*bootstrapSignalSchemas\(\)\.length/);
    expect(gate).toMatch(/EXPECTED_FUNCTION_COUNT\s*=\s*platformFunctions\(\)\.length/);
    expect(gate).not.toMatch(/EXPECTED_SCHEMA_COUNT\s*=\s*\d/);
    expect(gate).not.toMatch(/EXPECTED_FUNCTION_COUNT\s*=\s*\d/);
  });

  it('platform-bootstrap writer DERIVES PLATFORM_SCHEMAS / PLATFORM_FUNCTIONS', () => {
    const boot = read('apps/db-migrate/src/platform-bootstrap.service.ts');
    expect(boot).toMatch(/PLATFORM_SCHEMAS[^=]*=\s*bootstrapSignalSchemas\(\)/);
    expect(boot).toMatch(/PLATFORM_FUNCTIONS[^=]*=\s*platformFunctions\(\)/);
  });

  it('TENANT_AWARE_SCHEMAS runtime Set DERIVES from the topology', () => {
    const tas = read('libs/backend-common/src/database/tenant-aware-schemas.ts');
    expect(tas).toMatch(/new Set\(\s*tenantAwareSchemas\(\)/);
  });

  it('current membership snapshot (change here only WITH the source lists)', () => {
    // A human-legible ratchet: if these counts change, the reviewer sees which
    // orthogonal set moved. Not a hidden literal — an explicit topology census.
    expect(bootstrapCreatedSchemas().length).toBe(17);
    expect(bootstrapSignalSchemas().length).toBe(16);
    expect(migrationRunnerSchemas().length).toBe(14);
    expect(moduleManifestSchemas().length).toBe(16);
    expect(tenantAwareSchemas().length).toBe(7);
    expect(platformFunctions().length).toBe(4);
  });
});
