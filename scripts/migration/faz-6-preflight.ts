#!/usr/bin/env ts-node
/**
 * faz-6-preflight — Day-One Baseline Reset cutover gate (operator-driven).
 * ============================================================================
 *
 * Runs every static + accessible check from `docs/runbooks/faz-6-cutover-window.md`
 * before the operator initiates the cutover window. Exits non-zero on any
 * failure — the cutover is BLOCKED until every check is green.
 *
 * SAFETY: this script is READ-ONLY. It does not modify any state. It
 * verifies the world is in the right shape to run the cutover; it does
 * not run the cutover itself (Step 1–13 in the runbook are manual psql
 * + docker compose operations the operator executes with situational
 * awareness).
 *
 * # USAGE
 *
 *   ts-node scripts/migration/faz-6-preflight.ts
 *
 * Output: a checklist with PASS / FAIL / WARN per item. Exit 0 only
 * when every gating item passes; failures + warnings are listed for
 * operator triage.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM-safe __dirname equivalent. The gates/tsconfig.json compiles
// modules as ESM; require/__dirname is unavailable. fileURLToPath +
// dirname recovers the script's directory.
const SCRIPT_DIR =
  typeof __dirname === 'string'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

type CheckResult = { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string };
const results: CheckResult[] = [];

function pass(name: string, detail: string): void {
  results.push({ name, status: 'PASS', detail });
}
function fail(name: string, detail: string): void {
  results.push({ name, status: 'FAIL', detail });
}
function warn(name: string, detail: string): void {
  results.push({ name, status: 'WARN', detail });
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ── Static checks (no network, no DB) ────────────────────────────────

function checkBranchOnMigration(): void {
  try {
    const branch = git('rev-parse --abbrev-ref HEAD');
    if (branch === 'migration') {
      pass('git/current-branch', 'on migration branch');
    } else {
      warn(
        'git/current-branch',
        `current branch is "${branch}" (expected "migration") — preflight assumes migration HEAD; rerun from /var/aqua-saas-migration worktree`,
      );
    }
  } catch (err) {
    fail('git/current-branch', `failed to resolve branch: ${(err as Error).message}`);
  }
}

function checkMigrationAheadOfMain(): void {
  try {
    git('fetch origin main');
    const ahead = git('rev-list --count origin/main..HEAD');
    const behind = git('rev-list --count HEAD..origin/main');
    if (parseInt(behind, 10) > 0) {
      fail(
        'git/main-fast-forward',
        `migration branch is BEHIND origin/main by ${behind} commit(s); merge origin/main before cutover`,
      );
    } else if (parseInt(ahead, 10) === 0) {
      warn(
        'git/main-fast-forward',
        `migration branch has 0 commits ahead of origin/main — nothing to cut over`,
      );
    } else {
      pass(
        'git/main-fast-forward',
        `migration is ${ahead} commit(s) ahead of origin/main, 0 behind`,
      );
    }
  } catch (err) {
    fail('git/main-fast-forward', `git fetch/rev-list failed: ${(err as Error).message}`);
  }
}

function checkBaselineFilesExist(): void {
  const services = [
    'admin-api-service',
    'auth-service',
    'billing-service',
    'config-service',
    'event-store-service',
    'notification-service',
    'observability-service',
    'ai-service',
    'alert-engine',
    'farm-service',
    'hr-service',
    'hydroponics-service',
    'messaging-service',
    'sensor-service',
  ];
  // Services use either src/migrations/ (auth, admin-api, event-store,
  // messaging) or src/database/migrations/. Check both paths.
  const missing: string[] = [];
  for (const svc of services) {
    const candidates = [
      resolve(REPO_ROOT, 'apps', svc, 'src', 'database', 'migrations', '1800000000000-Baseline.ts'),
      resolve(REPO_ROOT, 'apps', svc, 'src', 'migrations', '1800000000000-Baseline.ts'),
    ];
    if (!candidates.some((p) => existsSync(p))) missing.push(svc);
  }
  if (missing.length === 0) {
    pass('faz-3/baseline-files-present', `all 14 services have 1800000000000-Baseline.ts`);
  } else {
    fail(
      'faz-3/baseline-files-present',
      `${missing.length} service(s) missing baseline migration: ${missing.join(', ')}. Run scripts/migration/baseline-generator.ts --service <svc> --generate --apply`,
    );
  }
}

function checkProtectedTablesSsotPresent(): void {
  const p = resolve(REPO_ROOT, 'libs/backend-common/src/constants/protected-tables.ts');
  if (!existsSync(p)) {
    fail('faz-1.4/protected-tables-ssot', `${p} missing — Faz 1.4 not landed`);
    return;
  }
  const src = readFileSync(p, 'utf8');
  if (!/PROTECTED_TABLES\s*=/.test(src)) {
    fail('faz-1.4/protected-tables-ssot', 'protected-tables.ts present but PROTECTED_TABLES export missing');
    return;
  }
  pass('faz-1.4/protected-tables-ssot', 'PROTECTED_TABLES SSoT present');
}

function checkSchemaVersionGatePresent(): void {
  const p = resolve(REPO_ROOT, 'libs/backend-common/src/database/schema-version-gate.service.ts');
  if (!existsSync(p)) {
    fail('faz-1.5/schema-version-gate', `${p} missing — Faz 1.5 not landed`);
    return;
  }
  pass('faz-1.5/schema-version-gate', 'SchemaVersionGate provider present');
}

function checkEdgeV2EntitiesPresent(): void {
  const v2dir = resolve(REPO_ROOT, 'apps/sensor-service/src/edge-device/entities/v2');
  if (!existsSync(v2dir)) {
    fail('faz-2/edge-v2-entities', `${v2dir} missing — Faz 2 not landed`);
    return;
  }
  const expected = [
    'device-v2.entity.ts',
    'policy-v2.entity.ts',
    'license-v2.entity.ts',
    'firmware-release-v2.entity.ts',
    'provisioning-record-v2.entity.ts',
    'witness-v2.entity.ts',
    'audit-archive-v2.entity.ts',
  ];
  const missing = expected.filter((f) => !existsSync(resolve(v2dir, f)));
  if (missing.length === 0) {
    pass('faz-2/edge-v2-entities', `all 7 edge v2 entities present`);
  } else {
    fail('faz-2/edge-v2-entities', `missing: ${missing.join(', ')}`);
  }
}

function checkPlatformFunctionsInitScript(): void {
  const p = resolve(REPO_ROOT, 'infrastructure/docker/init-scripts/05-platform-functions.sql');
  if (!existsSync(p)) {
    fail('faz-1.9/platform-functions-init', `${p} missing — Faz 1.9 not landed`);
    return;
  }
  const src = readFileSync(p, 'utf8');
  const required = ['current_tenant_id', 'set_tenant_id', 'update_updated_at_column'];
  const missing = required.filter((fn) => !src.includes(fn));
  if (missing.length === 0) {
    pass('faz-1.9/platform-functions-init', '05-platform-functions.sql declares all 3 helper functions');
  } else {
    fail(
      'faz-1.9/platform-functions-init',
      `05-platform-functions.sql missing function(s): ${missing.join(', ')}`,
    );
  }
}

function checkExtensionsPromoted(): void {
  const p = resolve(REPO_ROOT, 'infrastructure/docker/init-scripts/00-init-schemas.sh');
  if (!existsSync(p)) {
    fail('faz-1.10/extensions-init', '00-init-schemas.sh missing');
    return;
  }
  const src = readFileSync(p, 'utf8');
  const required = ['timescaledb', '"uuid-ossp"', 'pg_trgm', 'btree_gist', 'pgcrypto', 'vector'];
  const missing = required.filter((ext) => !src.includes(`CREATE EXTENSION IF NOT EXISTS ${ext}`));
  if (missing.length === 0) {
    pass('faz-1.10/extensions-init', 'all 6 platform extensions promoted to init script');
  } else {
    fail(
      'faz-1.10/extensions-init',
      `00-init-schemas.sh missing extension CREATEs: ${missing.join(', ')}`,
    );
  }
}

function checkSharedSchemaCanonicalCount(): void {
  const p = resolve(REPO_ROOT, 'scripts/schema-registry/generate-init-schemas.ts');
  if (!existsSync(p)) {
    fail('faz-4/shared-schema-canonical', `${p} missing`);
    return;
  }
  const src = readFileSync(p, 'utf8');
  const m = /const\s+SHARED_SCHEMA_TABLES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/m.exec(src);
  if (!m) {
    fail('faz-4/shared-schema-canonical', 'SHARED_SCHEMA_TABLES not parseable');
    return;
  }
  const sharedSchemaTableList = m[1];
  if (sharedSchemaTableList === undefined) {
    fail('faz-4/shared-schema-canonical', 'SHARED_SCHEMA_TABLES capture missing');
    return;
  }
  const count = sharedSchemaTableList
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter((s) => /^[a-z_]/.test(s)).length;
  if (count === 5) {
    pass('faz-4/shared-schema-canonical', `SHARED_SCHEMA_TABLES = 5 (canonical)`);
  } else {
    warn(
      'faz-4/shared-schema-canonical',
      `SHARED_SCHEMA_TABLES = ${count} (expected 5 post-Faz-4)`,
    );
  }
}

function checkInvariantSpecsPresent(): void {
  const specs = [
    'protected-tables-guard.spec.ts',
    'no-savepoint-in-migrations.spec.ts',
    'rls-predicate-canonical.spec.ts',
    'entity-schema-declaration.spec.ts',
    'entity-diff-implies-migration.spec.ts',
    'tenant-fanout-entity-parity.spec.ts',
    'shared-schema-canonical.spec.ts',
    'drift-repair-naming.spec.ts',
  ];
  const missing = specs.filter(
    (s) => !existsSync(resolve(REPO_ROOT, 'tests/invariants', s)),
  );
  if (missing.length === 0) {
    pass('faz-1+4+7/invariants-present', 'all 8 source-level invariant specs present');
  } else {
    fail(
      'faz-1+4+7/invariants-present',
      `missing invariant spec(s): ${missing.join(', ')}`,
    );
  }
}

function checkAdr025And030Present(): void {
  const adrs = [
    'docs/adr/025-edge-schema-sensor-per-tenant-ownership.md',
    'docs/adr/030-day-one-baseline-reset.md',
  ];
  const missing = adrs.filter((a) => !existsSync(resolve(REPO_ROOT, a)));
  if (missing.length === 0) {
    pass('faz-2+7/adr-records', 'ADR-025 + ADR-030 present');
  } else {
    fail('faz-2+7/adr-records', `missing ADR(s): ${missing.join(', ')}`);
  }
}

function checkRunbooksPresent(): void {
  const runbooks = [
    'docs/runbooks/baseline-migration-generation.md',
    'docs/runbooks/migration-authoring.md',
    'docs/runbooks/faz-6-cutover-window.md',
  ];
  const missing = runbooks.filter((r) => !existsSync(resolve(REPO_ROOT, r)));
  if (missing.length === 0) {
    pass('faz-7/runbooks-present', 'all 3 cutover runbooks present');
  } else {
    fail('faz-7/runbooks-present', `missing runbook(s): ${missing.join(', ')}`);
  }
}

function checkPlanDossierPresent(): void {
  const planPath = '/root/.claude/plans/peppy-crafting-waterfall.md';
  if (!existsSync(planPath)) {
    warn(
      'plan/dossier',
      `Plan dossier at ${planPath} not on this host (expected for off-vault operator runs)`,
    );
    return;
  }
  const age = (Date.now() - statSync(planPath).mtimeMs) / 86_400_000;
  if (age > 30) {
    warn(
      'plan/dossier',
      `Plan dossier last modified ${age.toFixed(1)} days ago; reconcile with current cutover scope`,
    );
  } else {
    pass('plan/dossier', `Plan dossier present, last modified ${age.toFixed(1)} days ago`);
  }
}

function checkGitTagSafetyNet(): void {
  try {
    const tags = git("tag --list 'pre-baseline-*'");
    if (tags) {
      pass('rollback/tag', `pre-baseline tag present: ${tags.split('\n')[0]}`);
    } else {
      warn(
        'rollback/tag',
        'No pre-baseline-* git tag found. Operator MUST tag origin/main HEAD with `git tag pre-baseline-YYYY-MM-DD` before Faz 0',
      );
    }
  } catch {
    warn('rollback/tag', 'git tag query failed — verify manually');
  }
}

// ── Execute ─────────────────────────────────────────────────────────

function main(): void {
  console.log('═══ Faz 6 Cutover Pre-flight ═══\n');

  checkBranchOnMigration();
  checkMigrationAheadOfMain();
  checkBaselineFilesExist();
  checkProtectedTablesSsotPresent();
  checkSchemaVersionGatePresent();
  checkEdgeV2EntitiesPresent();
  checkPlatformFunctionsInitScript();
  checkExtensionsPromoted();
  checkSharedSchemaCanonicalCount();
  checkInvariantSpecsPresent();
  checkAdr025And030Present();
  checkRunbooksPresent();
  checkPlanDossierPresent();
  checkGitTagSafetyNet();

  let fails = 0;
  let warns = 0;
  for (const r of results) {
    const tag =
      r.status === 'PASS'
        ? '\x1b[32mPASS\x1b[0m'
        : r.status === 'WARN'
          ? '\x1b[33mWARN\x1b[0m'
          : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${tag}  ${r.name}`);
    console.log(`         ${r.detail}`);
    if (r.status === 'FAIL') fails++;
    if (r.status === 'WARN') warns++;
  }

  console.log('');
  console.log(`Summary: ${results.length - fails - warns} pass · ${warns} warn · ${fails} fail`);

  if (fails > 0) {
    console.error('\n❌ Faz 6 cutover BLOCKED — resolve every FAIL before proceeding.');
    process.exit(1);
  }
  if (warns > 0) {
    console.warn(
      '\n⚠️  Faz 6 cutover GATED — operator review every WARN before proceeding. Pass --allow-warnings to override after review.',
    );
    if (!process.argv.includes('--allow-warnings')) process.exit(1);
  }
  console.log('\n✓ Faz 6 cutover pre-flight GREEN. Operator may proceed with the runbook sequence.');
  process.exit(0);
}

main();
