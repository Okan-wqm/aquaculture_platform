/**
 * Platform-wide invariant — MIGRATION-SPEC-QUARANTINE:
 *
 * `.spec.ts` files MUST NOT live directly inside any service's
 * top-level migration directory. Test specs belong in a sibling
 * `__tests__/` subdirectory — that is where the codebase-wide
 * convention puts every other test, and where
 * `apps/db-migrate/tsconfig.build.json` already excludes them.
 *
 * # Why this invariant exists
 *
 * `apps/db-migrate` is a single CLI that compiles every service's
 * migration source tree into one bundle (see schema-registry.ts).
 * Its `tsconfig.build.json` `include` block pulls each service's
 * `migrations/` directory across `..` boundaries, so a bare
 * `**\/*.spec.ts` exclude pattern (anchored to db-migrate's tsconfig
 * directory) does NOT reach the cross-tree spec files. The build
 * scope discovers a spec, the spec uses Jest globals, and the
 * production tsconfig deliberately omits `@types/jest` from `types`
 * so that production bundles do not advertise Jest globals — the
 * compile then fails with TS2593 / TS2304.
 *
 * The first instances of this regression were
 * `apps/auth-service/src/migrations/*.spec.ts` and
 * `apps/farm-service/src/database/migrations/*.spec.ts` (commit
 * efddd723), which broke `build` and `Frontend Lighthouse CI` jobs
 * on `main`. The fix moved the specs into `__tests__/` and added
 * cross-tree exclude entries to `tsconfig.build.json` as a Tier-3
 * safety net.
 *
 * This invariant locks in the Tier-1 shape of the fix: any future
 * `*.spec.ts` placed directly inside a top-level `migrations/`
 * directory of a service is a regression and is rejected at PR
 * time, before it reaches the build scope.
 *
 * # Detection contract
 *
 * Walk every service under `apps/<svc>/src/`. For any directory whose
 * leaf segment is `migrations` (i.e. `apps/<svc>/src/migrations/` or
 * `apps/<svc>/src/database/migrations/`), assert that no immediate
 * `.spec.ts` child file exists. Spec files inside a nested
 * `__tests__/` are accepted — they are the canonical placement.
 *
 * # What this invariant does NOT check
 *
 *   - It does not enforce that test specs exist for every migration —
 *     test coverage is a separate concern.
 *   - It does not police `.test.ts` files (the same rule applies in
 *     spirit; the regression only ever surfaced for `.spec.ts` and
 *     `tsconfig.build.json` already covers `**\/*.test.ts` per
 *     migration tree as a belt-and-braces measure).
 *   - It does not validate that `tsconfig.build.json`'s exclude
 *     entries are paired with each include entry — that pairing is
 *     enforced by the build itself: any future regression compiles
 *     the spec into the bundle and trips TS2593, which `tsc -p
 *     ...tsconfig.build.json` surfaces as a hard failure.
 *
 * # Closure
 *
 * Closes: orphan finding tracked by the build-failure plan at
 * /tmp/ci-cleanup-plans/build-db-migrate.md §6 ("Long-term invariant").
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

/**
 * Recursively walk a directory and yield absolute paths whose leaf
 * directory name is `migrations`. Stops descending into hidden or
 * `node_modules` directories.
 */
function findMigrationDirs(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = path.join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (entry === 'migrations') {
        out.push(full);
        // Do NOT descend into `migrations/` itself for further
        // discovery — nested `migrations/` directories are not a
        // pattern in this codebase, and descending would re-flag
        // the same directory on its child path.
        continue;
      }
      stack.push(full);
    }
  }
  return out;
}

/**
 * List immediate `.spec.ts` children of a migrations/ directory.
 * Files inside a nested `__tests__/` are NOT immediate children
 * and are not returned.
 */
function listTopLevelSpecs(migrationsDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith('.spec.ts'))
    .filter((e) => {
      const full = path.join(migrationsDir, e);
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    })
    .map((e) => path.join(migrationsDir, e));
}

describe('INVARIANT: migration spec quarantine', () => {
  it('asserts no .spec.ts file lives directly inside any service migrations/ directory', () => {
    let services: string[];
    try {
      services = readdirSync(APPS_DIR);
    } catch (err) {
      throw new Error(
        `apps/ directory not readable at ${APPS_DIR}: ${(err as Error).message}`,
      );
    }

    const violations: string[] = [];
    for (const svc of services) {
      const svcSrc = path.join(APPS_DIR, svc, 'src');
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(svcSrc);
      } catch {
        continue; // service has no src/ — not applicable
      }
      if (!st.isDirectory()) continue;

      const migrationDirs = findMigrationDirs(svcSrc);
      for (const dir of migrationDirs) {
        const specs = listTopLevelSpecs(dir);
        for (const spec of specs) {
          violations.push(path.relative(REPO_ROOT, spec));
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map((v) => `  - ${v}`).join('\n');
      throw new Error(
        [
          'Found .spec.ts file(s) placed directly inside a service migrations/ directory.',
          'These break `db-migrate:build:production` because the db-migrate tsconfig',
          'pulls every service migrations/ tree across `..` boundaries while keeping',
          '`@types/jest` deliberately out of `types` (production bundles must not',
          'advertise Jest globals). Move each spec into a sibling `__tests__/`',
          'subdirectory:',
          '',
          lines,
          '',
          'Example:',
          '  apps/<svc>/src/migrations/2026-foo.spec.ts',
          '   -> apps/<svc>/src/migrations/__tests__/2026-foo.spec.ts',
          '',
          'See /tmp/ci-cleanup-plans/build-db-migrate.md for the full rationale,',
          'and `apps/db-migrate/tsconfig.build.json` for the matching exclude',
          'entries that act as the Tier-3 safety net.',
        ].join('\n'),
      );
    }
  });
});
