/**
 * Platform-wide invariant — ORPHAN-FARM-MIGRATION-REGISTRATION:
 *
 * Every TypeORM migration file under
 * `apps/<svc>/src/migrations/` or
 * `apps/<svc>/src/database/migrations/`
 * MUST be referenced by the corresponding service's AppModule
 * migrations array — otherwise a fresh deploy never runs it and the
 * schema state silently lags the entity declarations.
 *
 * # Why
 *
 * Discovered during W0.D-extension work on this PR
 * (harmonic-sleeping-cascade plan): farm-service's AppModule
 * migrations array stopped at AddFarmOutboxModernColumns1786200000000
 * while four newer migrations existed on disk
 * (1787300000000 / 1787400000000 / 1787500000000 / 1788100000000).
 * Auth-service uses a glob pattern so the gap doesn't apply there;
 * farm-service uses an explicit array. This invariant catches the
 * regression class wholesale across every service.
 *
 * # Allow-list
 *
 * Services that load migrations via a glob (`migrations: [__dirname +
 * '/migrations/[0-9]*{.ts,.js}']`) are exempt — the numeric glob
 * auto-includes every timestamped migration file while excluding support
 * files such as manifest.ts. Detection is via reading the AppModule and
 * looking for the glob pattern.
 *
 * Services that have NO migrations directory are exempt (no findings
 * to register).
 *
 * # Per-service allowlist (transitional)
 *
 * The first run of this invariant surfaced the same regression class
 * across 7 other services (admin-api, alert-engine, billing-service,
 * event-store-service, hr-service, messaging-service,
 * notification-service). Each is tracked as an orphan finding with
 * its own per-service closure path; the allowlist below carries them
 * with explicit ORPHAN-* references. Removing an entry happens when
 * the matching service's migrations array is brought up to date —
 * the invariant immediately re-locks the gap once the entry is gone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Services with KNOWN unregistered migrations as of W0.D-extension-followup.
 * Each entry references the orphan finding tracking the gap. Removing an
 * entry is the closure signal — the per-service follow-up commit must
 * delete the line here in the same change that registers the migrations.
 */
const KNOWN_UNREGISTERED: ReadonlyMap<string, string> = new Map([
  // admin-api-service: drained 2026-04-29 — pre-existing
  // ConvertAuditColumnsToTimestamptz1781900000000 + AuditLogImmutability1782000000000
  // were unregistered behind the allowlist; both now imported and listed in
  // the migrations array, so admin-api falls under the unconditional check.
  // alert-engine: drained 2026-04-29 — uses glob pattern.
  // billing-service: drained 2026-04-29 — uses glob pattern.
  // event-store-service: drained 2026-04-29 — switched to glob pattern.
  // hr-service: drained 2026-04-29 — uses glob pattern.
  // messaging-service: drained 2026-04-29 — Consolidate1782500000000 +
  // AlignMessagingEntityDrift1782600000000 were unregistered behind the
  // allowlist; both now imported and listed in the migrations array.
  // notification-service: drained 2026-04-29 — already uses glob pattern,
  // so the allowlist entry was redundant. Removing it lets the invariant's
  // glob-detection branch handle the service.
  // observability-service: drained 2026-04-29 — switched to glob pattern.
  // sensor-service: drained 2026-04-29 — switched to glob pattern.
]);

function listMigrationFilesFor(service: string): string[] {
  const out: string[] = [];
  for (const sub of ['src/migrations', 'src/database/migrations']) {
    const dir = resolve(REPO_ROOT, 'apps', service, sub);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    try {
      const ls = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', `apps/${service}/${sub}/*.ts`], {
        encoding: 'utf8',
      });
      out.push(
        ...ls.split('\n').filter(
          (f) =>
            f.length > 0 &&
            !f.endsWith('.spec.ts') &&
            !f.endsWith('.test.ts') &&
            !f.includes('/__tests__/') &&
            // Exclude TypeORM CLI data-source helpers if any drift here.
            !f.endsWith('/data-source.ts') &&
            // ADR-030 day-one reset archived the pre-baseline migration chain
            // into <migrations>/.archive/<timestamp>/. Those files exist in
            // git history for forensic reference but are NOT loaded by any
            // service's TypeORM `migrations: [...]` array — verifying their
            // registration is meaningless and would force every spec change
            // to bloat the AppModule import surface with archived classes.
            !f.includes('/.archive/'),
        ),
      );
    } catch {
      // empty directory — ignore
    }
  }
  return out;
}

function listServicesWithMigrations(): string[] {
  const ls = execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      'apps/*/src/migrations/*.ts',
      'apps/*/src/database/migrations/*.ts',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const services = new Set<string>();
  for (const line of ls.split('\n')) {
    const m = line.match(/^apps\/([^/]+)\//);
    const service = m?.[1];
    // ORPHAN-HIGH-507 — guarded, not asserted.
    if (service !== undefined) services.add(service);
  }
  return Array.from(services).sort();
}

function appModulePath(service: string): string | null {
  const candidate = resolve(REPO_ROOT, `apps/${service}/src/app.module.ts`);
  return existsSync(candidate) ? candidate : null;
}

function registrationSourceFor(service: string, appSrc: string): string {
  if (service !== 'farm-service' || !appSrc.includes('FARM_MIGRATIONS')) {
    return appSrc;
  }

  const manifestPath = resolve(REPO_ROOT, 'apps/farm-service/src/database/migrations/manifest.ts');
  if (!existsSync(manifestPath)) {
    return appSrc;
  }

  return `${appSrc}\n${readFileSync(manifestPath, 'utf8')}`;
}

function usesGlobPattern(appModuleSrc: string): boolean {
  // Pattern: `migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}']`
  // or `migrations: [__dirname + '/migrations/[0-9]*.{ts,js}']` etc.
  // The numeric prefix keeps support files in migrations directories out of
  // TypeORM's migration loader; migration-glob-contract.spec.ts enforces it.
  return /migrations:\s*\[[\s\S]*?\/migrations\/\[0-9\]\*\.?\{/i.test(appModuleSrc);
}

function migrationFileToClassNames(rel: string): string[] {
  const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
  const re = /export\s+class\s+([A-Z][A-Za-z0-9_]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const captured = m[1];
    if (captured !== undefined) out.push(captured);
  }
  return out;
}

// 2026-04-30: Destructive data-consolidation migrations may be shipped as
// manual code artefacts without being auto-registered. The invariant allows
// that only when the migration file carries the full gated-execution contract:
// explicit not-auto-registered marker, destructive/irreversible warning,
// backup requirement, and the operator step that registers it before rollout.
function isExplicitlyGatedManualMigration(rel: string): boolean {
  const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
  return (
    /GATED\s+[—-]\s+NOT auto-registered/i.test(src) &&
    /destructive/i.test(src) &&
    /production-irreversible/i.test(src) &&
    /pg_dump snapshot/i.test(src) &&
    /Register in app\.module\.ts migrations\[\] array/i.test(src)
  );
}

describe('INVARIANT (ORPHAN-FARM-MIGRATION-REGISTRATION): every migration is registered in its AppModule', () => {
  const services = listServicesWithMigrations();

  it('discovers at least one service with migrations', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it.each(services)('service %s registers every on-disk migration in AppModule', (service) => {
    const appPath = appModulePath(service);
    if (!appPath) {
      // Service has no AppModule (rare — db-migrate CLI runner) → skip.
      return;
    }
    const appSrc = readFileSync(appPath, 'utf8');

    if (usesGlobPattern(appSrc)) {
      // Numeric glob auto-includes every timestamped migration file while
      // excluding support files → no per-file registration needed.
      return;
    }

    if (KNOWN_UNREGISTERED.has(service)) {
      // Tracked orphan — see KNOWN_UNREGISTERED for closure pointer.
      return;
    }

    const migrations = listMigrationFilesFor(service);
    const registrationSrc = registrationSourceFor(service, appSrc);
    const missing: string[] = [];
    for (const migFile of migrations) {
      const classes = migrationFileToClassNames(migFile);
      // The migration file must export at least one class. If multiple
      // classes are exported (rare), at least ONE must be referenced.
      if (classes.length === 0) continue;
      const referenced = classes.some((cls) => registrationSrc.includes(cls));
      if (!referenced) {
        if (isExplicitlyGatedManualMigration(migFile)) {
          continue;
        }
        missing.push(`${migFile} (class ${classes.join(', ')})`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `Service "${service}" has ${missing.length} migration file(s) not registered ` +
          `in its AppModule's migrations array:\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          `\n\nA fresh deploy of "${service}" will never run these migrations — ` +
          `the schema state will silently lag the entity declarations. ` +
          `Add the imports + array entries OR switch the service's TypeOrmModule config ` +
          `to use the numeric glob pattern \`migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}']\`.`,
      );
    }
  });
});
