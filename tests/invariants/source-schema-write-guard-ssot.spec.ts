/**
 * ORPHAN-HIGH-087 / FARM-CRITICAL-061 — the source-schema `guard_source_write`
 * triggers are reconciled from the MODULE_SCHEMAS registry by aqua-db-migrate
 * and gated deploy-blocking. This invariant fails if the reconciler is unwired
 * from either db-migrate choke point (deploy install/verify, provisioner
 * verify), if the guard DDL leaves the db-migrate-owned reconciler, or if a
 * runtime boot-time write-guard installer is reintroduced.
 *
 * The registry-derived guarded set (`tables − referenceDataTables −
 * infrastructureTables`) and its emptiness against reference/infra tables are
 * proven with real imports in the co-located unit spec
 * (libs/backend-common/src/database/source-schema-write-guard-reconciler.spec.ts);
 * this shard asserts the wiring, which is text-only by design.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readSrc(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
}

const RECONCILER = 'libs/backend-common/src/database/source-schema-write-guard-reconciler.ts';
const MAIN = 'apps/db-migrate/src/main.ts';
const PROVISIONER = 'apps/db-migrate/src/tenant-schema-provisioner.ts';

describe('INVARIANT (ORPHAN-HIGH-087): source-schema write guards are registry-reconciled + deploy-gated', () => {
  it('the reconciler owns the canonical function + trigger DDL and the SSoT derivation', () => {
    const src = readSrc(RECONCILER);
    expect(src).toContain('CREATE OR REPLACE FUNCTION');
    expect(src).toContain('block_source_writes'); // GUARD_FUNCTION_NAME
    expect(src).toContain('CREATE TRIGGER');
    expect(src).toContain('guard_source_write'); // GUARD_TRIGGER_NAME
    expect(src).toContain('export function sourceSchemaGuardedTables(');
    // guarded set = tables − referenceDataTables − infrastructureTables
    expect(src).toContain('referenceDataTables');
    expect(src).toContain('infrastructureTables');
    // platform-level schemas are refused
    expect(src).toContain('TENANT_AWARE_SCHEMAS');
  });

  it('db-migrate deploy installs AND deploy-blocking-verifies the guards', () => {
    const src = readSrc(MAIN);
    expect(src).toContain('assertSourceSchemaWriteGuards(');
    expect(src).toContain('verifySourceSchemaWriteGuards(');
  });

  it('the provisioner verifies the guards before committing a provision/reconcile job', () => {
    expect(readSrc(PROVISIONER)).toContain('verifySourceSchemaWriteGuards(');
  });

  it('the reconciler is the barrel export and the removed runtime service is gone', () => {
    const dbIndex = readSrc('libs/backend-common/src/database/index.ts');
    expect(dbIndex).toContain('source-schema-write-guard-reconciler');
    // the old no-op SourceSchemaWriteGuardService export must not return
    expect(dbIndex).not.toContain("from './source-schema-write-guard'");
  });
});
