/**
 * Platform-wide invariant — AUDITTRAIL-HIGH-008:
 *
 * Every service that uses `@Cron` (or any `@nestjs/schedule` decorator)
 * MUST register `ScheduleModule.forRoot()` somewhere in its module
 * tree. Without that registration, the NestJS scheduler never picks up
 * the cron jobs and every @Cron-decorated method becomes silent dead
 * code — no build error, no runtime warning, just a cron that never
 * fires.
 *
 * # Why
 *
 * Pre-fix `apps/auth-service/src/audit/audit-log.service.ts:147` declared
 * `@Cron(CronExpression.EVERY_DAY_AT_2AM) scheduledLogCleanup()` to
 * enforce the 7-year audit retention floor (AUDITTRAIL-HIGH-001 cure).
 * The auth-service AppModule never imported ScheduleModule, so the cron
 * never fired and auth.audit_logs grew indefinitely. The retention
 * floor was set in code but never enforced at runtime.
 *
 * # What this invariant checks
 *
 * For each service that has `@Cron` or `@Interval` or `@Timeout`
 * decorator usage anywhere under apps/<svc>/src/, assert that
 * `ScheduleModule.forRoot()` (or `.forRoot(...)`) appears somewhere in
 * the module tree under apps/<svc>/src/. Source-text grep across
 * `*.module.ts` files; the registration MAY live in any module within
 * the service (AppModule is the typical location, feature modules also
 * acceptable).
 *
 * # Allowed shapes
 *
 *   - `ScheduleModule.forRoot()` — root registration, fires globally
 *   - `ScheduleModule.forRoot({...})` — root with options
 *
 * # Why this lives in tests/invariants/
 *
 * The defect class is "I added a cron and forgot the module registration"
 * — silent at compile time, silent at runtime, only visible via the
 * absence of expected DB-state changes (audit table not pruning,
 * retention metric never moving). A specific source-text invariant is
 * the right Tier-3 (make-detectable) hedge.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function listServiceTrees(): string[] {
  const out = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'apps/*/src/app.module.ts'],
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/\/src\/app\.module\.ts$/, ''));
}

function listFilesUnder(servicePrefix: string, glob: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', `${servicePrefix}/${glob}`],
      { encoding: 'utf8' },
    );
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function fileContains(rel: string, pattern: RegExp): boolean {
  try {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    return pattern.test(src);
  } catch {
    return false;
  }
}

const SCHEDULER_DECORATORS = /@(Cron|Interval|Timeout|ScheduledJob)\s*\(/;
const SCHEDULE_MODULE_FORROOT = /ScheduleModule\.forRoot\b/;

describe('INVARIANT (AUDITTRAIL-HIGH-008): @Cron usage requires ScheduleModule registration', () => {
  const services = listServiceTrees();

  it('discovers at least one service', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  it.each(services)(
    'service %s either has no @Cron decorators OR registers ScheduleModule.forRoot',
    (servicePrefix) => {
      const tsFiles = listFilesUnder(servicePrefix, 'src/**/*.ts');
      const usesScheduler = tsFiles.some(
        (f) => !f.endsWith('.spec.ts') && fileContains(f, SCHEDULER_DECORATORS),
      );
      if (!usesScheduler) return;

      // Service uses @Cron / @Interval / @Timeout — must register
      // ScheduleModule.forRoot somewhere in its module tree.
      // Two glob shapes needed: `src/*.module.ts` (matches AppModule.ts
      // at the top of the src tree) AND `src/**/*.module.ts` (matches
      // feature modules nested under src/<domain>/). Without both,
      // app.module.ts at the src root is missed because `**` requires
      // at least one intermediate directory.
      const moduleFiles = [
        ...listFilesUnder(servicePrefix, 'src/*.module.ts'),
        ...listFilesUnder(servicePrefix, 'src/**/*.module.ts'),
      ];
      const registers = moduleFiles.some((f) => fileContains(f, SCHEDULE_MODULE_FORROOT));

      if (!registers) {
        throw new Error(
          `Service "${servicePrefix}" uses @Cron / @Interval / @Timeout but ` +
            `does NOT register ScheduleModule.forRoot() anywhere under ` +
            `${servicePrefix}/src/**/*.module.ts. The scheduler decorator is ` +
            `silent dead code without that registration. Add ` +
            `'ScheduleModule.forRoot()' to the AppModule's imports list.`,
        );
      }
    },
  );
});
