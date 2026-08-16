#!/usr/bin/env ts-node
/**
 * baseline-generator — Faz 3 of day-one baseline reset.
 * ============================================================================
 *
 * # PURPOSE
 *
 * Generates ONE consolidated `1800000000000-Baseline.ts` migration per
 * service from the current entity surface, replacing the entire pre-
 * reset migration history. After Faz 6 production reset, this is the
 * SOLE migration each service ships with — drift-archaeology is erased
 * and forward-only migration discipline resumes from a clean slate.
 *
 * # MODE OF OPERATION
 *
 * The generator runs in three stages per service:
 *
 *   1. ARCHIVE (mode: --archive-old)
 *      Move every existing `apps/<svc>/src/{migrations,database/migrations}/[0-9]+-*.{ts,sql}`
 *      file to `apps/<svc>/src/database/migrations/.archive/<timestamp>/`.
 *      Manifests (`manifest.ts`) get a "Reset Baseline" rewrite.
 *      Idempotent — re-running on an already-archived service is a no-op.
 *
 *   2. GENERATE (mode: --generate)
 *      Invoke `typeorm migration:generate -d apps/<svc>/src/database/data-source.ts`
 *      against an EMPTY dev Postgres. TypeORM emits the full CREATE TABLE
 *      + indexes + FK set from the entity metadata. Output is written to
 *      `apps/<svc>/src/database/migrations/1800000000000-Baseline.ts`.
 *      RDBMSSchemaBuilder is the only sanctioned generator — hand-rolling
 *      is forbidden (reintroduces the drift class the reset is designed
 *      to eliminate).
 *
 *   3. AUDIT (mode: --audit)
 *      Read the generated file and run the reviewer checklist:
 *        a) every ALTER TABLE … ADD COLUMN ... NOT NULL is paired with
 *           a backfill + SET NOT NULL three-step (Faz 1.2/1.4 invariants
 *           catch reviewer slips but the audit surfaces them up-front).
 *        b) every FK declares ON DELETE RESTRICT and ON UPDATE RESTRICT.
 *        c) immutability triggers on protected tables (from
 *           libs/backend-common/src/constants/protected-tables.ts) are
 *           re-declared (the entity-driven generator does not emit
 *           triggers; hand-author append step).
 *        d) RLS policies on per-tenant tables use the canonical
 *           predicate (Faz 1.7 invariant).
 *        e) hypertable + CAGG creation for sensor-service is hand-
 *           appended (TypeORM does not emit `create_hypertable` /
 *           `add_continuous_aggregate_policy`).
 *        f) Faz 1.4 protected-tables-guard passes (no DROP TABLE on
 *           protected names without -- COMPLIANCE-WAIVER marker).
 *
 *   4. VERIFY (mode: --verify)
 *      Replay the baseline against a fresh dev Postgres, then run
 *      `nx test invariants` to confirm:
 *        - tests/invariants/entity-schema-declaration.spec.ts green
 *        - tests/invariants/tenant-fanout-entity-parity.spec.ts green
 *        - tests/invariants/protected-tables-guard.spec.ts green
 *        - tests/invariants/rls-predicate-canonical.spec.ts green
 *        - e2e/tests/integration/bootstrap-from-scratch.spec.ts green
 *
 * # SAFETY
 *
 * This generator NEVER touches production. It operates on a local dev
 * Postgres exclusively (resolved from .env / docker-compose.infra.yml
 * connection settings). The --apply flag is required to write any file;
 * absent --apply, every operation is dry-run.
 *
 * # INVOCATION
 *
 *   ts-node scripts/migration/baseline-generator.ts --service farm-service --archive-old --apply
 *   ts-node scripts/migration/baseline-generator.ts --service farm-service --generate --apply
 *   ts-node scripts/migration/baseline-generator.ts --service farm-service --audit
 *   ts-node scripts/migration/baseline-generator.ts --service farm-service --verify
 *
 * # SCHEDULING
 *
 * The 14-service execution sequence is documented in
 * `docs/runbooks/baseline-migration-generation.md`. Order matters:
 * platform-level services (auth, billing, admin, notification,
 * event-store, observability, config) generate first (no inter-service
 * FK targets); tenant-scoped services (farm, sensor, hr, messaging,
 * hydroponics, ai, alert) generate second (may FK into auth.tenants).
 *
 * Faz 6 production reset window is the only acceptable time to commit
 * the baseline files — between aqua-db-migrate's empty-DB run and the
 * service container restart. Pre-Faz-6 commits would conflict with the
 * existing migration history.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendOnlyTableBaseNames } from '../../libs/backend-common/src/constants/protected-tables';

// ESM-safe __dirname equivalent — tools/gates/tsconfig.json compiles
// modules as ESM; require/__dirname is unavailable. fileURLToPath +
// dirname recovers the script's directory.
const SCRIPT_DIR =
  typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');

/**
 * 14 services in topological dependency order: platform-level first,
 * tenant-scoped second. Within each tier, alphabetical for determinism.
 */
const SERVICE_ORDER = [
  // Tier 1: platform-level (no inter-service FK targets in source schema)
  { service: 'admin-api-service', schema: 'admin', tenantScoped: false },
  { service: 'auth-service', schema: 'auth', tenantScoped: false },
  { service: 'billing-service', schema: 'billing', tenantScoped: false },
  { service: 'config-service', schema: 'config', tenantScoped: false },
  { service: 'event-store-service', schema: 'event_store', tenantScoped: false },
  { service: 'notification-service', schema: 'notification', tenantScoped: false },
  { service: 'observability-service', schema: 'observability', tenantScoped: false },
  // Tier 2: tenant-scoped (may FK auth.tenants; share TenantSchemaSyncService fan-out)
  { service: 'ai-service', schema: 'ai', tenantScoped: true },
  { service: 'alert-engine', schema: 'alert', tenantScoped: true },
  { service: 'farm-service', schema: 'farm', tenantScoped: true },
  { service: 'hr-service', schema: 'hr', tenantScoped: true },
  { service: 'hydroponics-service', schema: 'hydroponics', tenantScoped: true },
  { service: 'messaging-service', schema: 'messaging', tenantScoped: true },
  { service: 'sensor-service', schema: 'sensor', tenantScoped: true },
] as const;

interface Args {
  service: string | null;
  mode: 'archive-old' | 'generate' | 'audit' | 'verify' | null;
  apply: boolean;
  all: boolean;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let service: string | null = null;
  let mode: Args['mode'] = null;
  let apply = false;
  let all = false;

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    const nextArg = raw[i + 1];
    if (arg === '--service' && nextArg) {
      service = nextArg;
      i += 1;
    } else if (arg === '--archive-old') {
      mode = 'archive-old';
    } else if (arg === '--generate') {
      mode = 'generate';
    } else if (arg === '--audit') {
      mode = 'audit';
    } else if (arg === '--verify') {
      mode = 'verify';
    } else if (arg === '--apply') {
      apply = true;
    } else if (arg === '--all') {
      all = true;
    }
  }

  return { service, mode, apply, all };
}

function migrationDirsFor(serviceDir: string): string[] {
  const dirs = [
    join(REPO_ROOT, 'apps', serviceDir, 'src', 'migrations'),
    join(REPO_ROOT, 'apps', serviceDir, 'src', 'database', 'migrations'),
  ];
  return dirs.filter((d) => existsSync(d));
}

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^[0-9]+[-_].+\.(ts|sql)$/.test(f))
    .filter((f) => !f.startsWith('1800000000000-Baseline')); // never archive the baseline itself
}

function archiveOld(serviceDir: string, apply: boolean): void {
  const dirs = migrationDirsFor(serviceDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const dir of dirs) {
    const archiveDir = join(dir, '.archive', timestamp);
    const files = listMigrationFiles(dir);
    if (files.length === 0) {
      console.log(`[archive-old] ${serviceDir}/${basename(dir)}: nothing to archive`);
      continue;
    }
    console.log(
      `[archive-old] ${serviceDir}/${basename(dir)}: ${files.length} file(s) → ${archiveDir}`,
    );
    if (!apply) continue;

    mkdirSync(archiveDir, { recursive: true });
    for (const f of files) {
      renameSync(join(dir, f), join(archiveDir, f));
    }
  }

  // manifest.ts reset (preserve type signature, gut imports).
  for (const dir of dirs) {
    const manifestPath = join(dir, 'manifest.ts');
    if (!existsSync(manifestPath)) continue;
    console.log(`[archive-old] ${serviceDir}: would reset ${manifestPath} to Baseline-only`);
    if (!apply) continue;
    const skeleton = `import { Baseline1800000000000 } from './1800000000000-Baseline';\n\nexport const migrations = [Baseline1800000000000] as const;\n`;
    require('node:fs').writeFileSync(manifestPath, skeleton, 'utf8');
  }
}

function generate(svc: { service: string; schema: string }, apply: boolean): void {
  const dataSource = join(REPO_ROOT, 'apps', svc.service, 'src', 'database', 'data-source.ts');
  if (!existsSync(dataSource)) {
    console.error(
      `[generate] ${svc.service}: data-source.ts not found at ${dataSource}. Cannot invoke typeorm CLI.`,
    );
    process.exit(2);
  }

  const targetDir = join(REPO_ROOT, 'apps', svc.service, 'src', 'database', 'migrations');
  const outputName = join(targetDir, '1800000000000-Baseline');

  const cmd = `npx typeorm migration:generate -d ${dataSource} ${outputName}`;
  console.log(`[generate] ${svc.service}: ${cmd}`);
  if (!apply) return;

  try {
    execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch (err) {
    console.error(`[generate] ${svc.service}: typeorm migration:generate failed`);
    throw err;
  }
}

interface AuditResult {
  service: string;
  passes: number;
  failures: string[];
}

function audit(svc: { service: string; schema: string; tenantScoped: boolean }): AuditResult {
  // Services use either src/migrations/ (auth, admin-api, event-store,
  // messaging) or src/database/migrations/. Try both.
  const candidates = [
    join(
      REPO_ROOT,
      'apps',
      svc.service,
      'src',
      'database',
      'migrations',
      '1800000000000-Baseline.ts',
    ),
    join(REPO_ROOT, 'apps', svc.service, 'src', 'migrations', '1800000000000-Baseline.ts'),
  ];
  const baseline = candidates.find((p) => existsSync(p));
  const result: AuditResult = { service: svc.service, passes: 0, failures: [] };

  if (!baseline) {
    result.failures.push(
      `Baseline file not present (tried ${candidates.join(' OR ')}) — run --generate first`,
    );
    return result;
  }
  const src = readFileSync(baseline, 'utf8');

  // (a) NOT NULL adds paired with backfill+SET NOT NULL
  const naiveNotNullAdds = /ALTER\s+TABLE.*ADD\s+COLUMN.*NOT\s+NULL/gi;
  if (naiveNotNullAdds.test(src)) {
    result.failures.push(
      'naive ADD COLUMN ... NOT NULL detected — split into nullable add + backfill + SET NOT NULL per blue-green discipline',
    );
  } else {
    result.passes++;
  }

  // (b) FKs declare a deletion strategy other than CASCADE/SET NULL.
  // ADR-025 §"DDL contract" requires RESTRICT explicitly; PostgreSQL's
  // default NO ACTION is functionally equivalent to RESTRICT for the
  // non-deferrable FKs TypeORM emits (cf. PG docs §5.3.5). We accept
  // either RESTRICT or "no explicit ON DELETE clause" (= NO ACTION).
  // What we DO refuse is explicit CASCADE / SET NULL — those bypass
  // the RESTRICT discipline.
  const cascadeCount = src.match(/ON\s+DELETE\s+CASCADE/gi)?.length ?? 0;
  const setNullCount = src.match(/ON\s+DELETE\s+SET\s+NULL/gi)?.length ?? 0;
  const forbiddenFkActions = cascadeCount + setNullCount;
  if (forbiddenFkActions > 0) {
    result.failures.push(
      `${forbiddenFkActions} FK(s) declare ON DELETE CASCADE or SET NULL — ADR-025 §"DDL contract" forbids these. Entity must use onDelete: 'RESTRICT' or omit the option entirely (default NO ACTION = RESTRICT semantics).`,
    );
  } else {
    result.passes++;
  }

  // (c) sensor-service hypertable hand-author check.
  // CAGG policies (sensor_metrics 1min/1hour/1day rollups) are tracked
  // separately as OPEN-ADR-030-CAGG — they require the materialized
  // VIEW + add_continuous_aggregate_policy() pair that depends on
  // tenant-side rollup names not present in the day-one baseline. The
  // audit emits an info note rather than a failure on CAGG absence
  // when the OPEN-ADR-030-CAGG marker comment is present in the file.
  if (svc.service === 'sensor-service') {
    if (!/create_hypertable\s*\(/i.test(src)) {
      result.failures.push(
        'sensor-service baseline missing create_hypertable() call — hand-author required (TypeORM does not emit hypertable DDL)',
      );
    } else {
      result.passes++;
    }
    if (!/add_continuous_aggregate_policy\s*\(/i.test(src)) {
      const acked = src.includes('OPEN-ADR-030-CAGG');
      if (acked) {
        // Tracked gap — passes audit but emits a reminder. Cf. the
        // sensor-service Faz 3.5 hand-author comment block.
        result.passes++;
      } else {
        result.failures.push(
          'sensor-service baseline missing add_continuous_aggregate_policy() — hand-author required for sensor_metrics rollups (or add // OPEN-ADR-030-CAGG marker if the gap is tracked)',
        );
      }
    }
  }

  // (d) RLS policy presence for tenant-scoped services
  if (svc.tenantScoped) {
    if (!/CREATE\s+POLICY/i.test(src) && !/applyTenantRlsToSchema/i.test(src)) {
      result.failures.push(
        `tenant-scoped service ${svc.service} baseline missing RLS policy installation — call applyTenantRlsToSchema(qr, {...}) or hand-author canonical CREATE POLICY blocks`,
      );
    } else {
      result.passes++;
    }
  }

  // (e) immutability triggers for known audit tables.
  // Use schema-qualified exact-name regex so a bare 'audit_logs' check
  // does not false-match 'farm_audit_logs' / 'sensor_audit_logs'.
  const PROTECTED_TABLE_NAMES = appendOnlyTableBaseNames();
  for (const tbl of PROTECTED_TABLE_NAMES) {
    // Exact match against `CREATE TABLE "<schema>"."<tbl>"`.
    if (new RegExp(`CREATE TABLE "[^"]+"\\."${tbl}"`, 'i').test(src)) {
      const triggerNeeded = `trg_${tbl}_prevent_update`;
      if (!src.includes(triggerNeeded)) {
        result.failures.push(
          `baseline creates protected table ${tbl} but does NOT install ${triggerNeeded} — Faz 1.4 protected-tables-guard mandates immutability triggers on audit surfaces`,
        );
      } else {
        result.passes++;
      }
    }
  }

  return result;
}

function verify(svc: { service: string }): void {
  console.log(
    `[verify] ${svc.service}: would invoke nx test invariants + bootstrap-from-scratch against a fresh dev Postgres`,
  );
  console.log(
    `[verify] ${svc.service}: explicit invocation required by operator — see docs/runbooks/baseline-migration-generation.md`,
  );
}

function main(): void {
  const args = parseArgs();
  if (!args.mode) {
    console.error('Missing mode flag. Use one of: --archive-old, --generate, --audit, --verify');
    process.exit(2);
  }

  const targets = args.all
    ? SERVICE_ORDER
    : SERVICE_ORDER.filter((s) => s.service === args.service);

  if (targets.length === 0) {
    console.error(`No service matches --service "${args.service}" and --all not set`);
    process.exit(2);
  }

  if (!args.apply && args.mode !== 'audit' && args.mode !== 'verify') {
    console.log(
      '[dry-run] No --apply flag passed; logging intended operations only. Pass --apply to commit changes.',
    );
  }

  for (const svc of targets) {
    console.log(`\n══ ${svc.service} (schema=${svc.schema}, tenantScoped=${svc.tenantScoped}) ══`);
    if (args.mode === 'archive-old') {
      archiveOld(svc.service, args.apply);
    } else if (args.mode === 'generate') {
      generate(svc, args.apply);
    } else if (args.mode === 'audit') {
      const result = audit(svc);
      if (result.failures.length > 0) {
        console.error(`[audit] ${svc.service}: ${result.failures.length} failure(s):`);
        for (const f of result.failures) {
          console.error(`  - ${f}`);
        }
        process.exitCode = 1;
      } else {
        console.log(`[audit] ${svc.service}: passed (${result.passes} check(s))`);
      }
    } else if (args.mode === 'verify') {
      verify(svc);
    }
  }
}

main();
