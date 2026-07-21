import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/**
 * RC-1 / RC-1b canonical paginated-response SSoT.
 *
 * RC-1 (ADMIN-CRITICAL-009) established the ONE canonical paginated shape
 * (`createStandardPaginatedResult` → `{ items, total, page, limit, totalPages,
 * hasNextPage, hasPreviousPage }`) and taught the admin-api ResponseInterceptor
 * to recognise it via `isStandardPaginatedResult` and lift `items` into the REST
 * envelope `data` slot with the numerics in `meta`.
 *
 * RC-1b (ADMIN-CRITICAL-007) completes the migration: EVERY admin-api list
 * producer now returns `createStandardPaginatedResult(...)`, and the legacy
 * `{ data, total }` duck-typed branch (plus its `as Record<string, unknown>`
 * casts) has been DELETED from the interceptor. With the branch gone there is
 * exactly one paginated-recognition path. A producer that regresses to a
 * hand-rolled `{ data, total, page, limit }` literal no longer gets silently
 * lifted — it falls to the default object wrap (breaking the FE list) — so this
 * gate fails the build the moment such a literal reappears in admin-api source.
 *
 * Tier-3 make-detectable. Runs on every PR via the `invariants:fast` shard.
 */
describe('admin-api canonical pagination envelope (RC-1 / RC-1b)', () => {
  it('the ResponseInterceptor recognises the canonical shape and passes binary through', () => {
    const src = read('apps/admin-api-service/src/shared/response.interceptor.ts');
    expect(src).toContain('isStandardPaginatedResult');
    expect(src).toContain('StreamableFile');
    expect(src).toContain('Buffer.isBuffer');
  });

  it('the canonical guard + factory live in the pagination SSoT', () => {
    const src = read('libs/backend-common/src/pagination/pagination.dto.ts');
    expect(src).toContain('export function isStandardPaginatedResult');
    expect(src).toContain('export function createStandardPaginatedResult');
    const barrel = read('libs/backend-common/src/pagination/index.ts');
    expect(barrel).toContain('isStandardPaginatedResult');
  });

  it('the legacy {data,total} interceptor branch (and its casts) is GONE (RC-1b)', () => {
    const src = read('apps/admin-api-service/src/shared/response.interceptor.ts');
    // The duck-typed lift `'data' in data && 'total' in data` and the
    // `as Record<string, unknown>` / `.total as number` casts that fed it are
    // the exact tokens RC-1b removed. Their reappearance means the branch
    // regrew — recreating the silent half-lift RC-1 set out to kill.
    expect(src).not.toMatch(/'data'\s+in\s+data/);
    expect(src).not.toContain('as Record<string, unknown>');
    // Precisely ONE paginated-recognition branch remains.
    expect(src.match(/isStandardPaginatedResult\(/g)?.length).toBe(1);
  });

  /**
   * The completeness gate. Statically forbids ANY admin-api handler
   * (controller / service / query-handler) from declaring or returning the
   * legacy `data`-keyed paginated shape. The canonical shape keys on `items`,
   * so a `data: T[]` array sibling `total`+`page`/`limit`/`totalPages`, or a
   * `return { data, total, ... }` literal, is by definition the banned legacy
   * shape that must instead flow through `createStandardPaginatedResult`.
   *
   * The ResponseInterceptor is the ONE legitimate `{ success, data, meta }`
   * envelope constructor (asserted separately above) and is excluded from this
   * producer scan.
   */
  it('no admin-api producer returns a legacy {data,total} paginated shape (RC-1b)', () => {
    const LEGACY_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
      {
        name: 'paginated-type (data: T[]; total; page|limit|totalPages)',
        re: /\bdata\s*:\s*[A-Za-z_][\w.<>[\] ]*\[\]\s*;[\s\S]{0,180}?\btotal\s*:\s*number[\s\S]{0,180}?\b(?:page|limit|totalPages)\s*:\s*number/,
      },
      {
        name: 'paginated-type (total; data: T[])',
        re: /\btotal\s*:\s*number\s*;[\s\S]{0,80}?\bdata\s*:\s*[A-Za-z_][\w.<>[\] ]*\[\]/,
      },
      {
        name: 'return-literal shorthand (return { data, total ... })',
        re: /return\s*\{\s*data\s*,\s*total\b[\s\S]{0,140}?\}/,
      },
      {
        name: 'return-literal explicit (return { data: ... total: ... page|limit|totalPages: ... })',
        re: /return\s*\{[\s\S]{0,80}?\bdata\s*:[\s\S]{0,220}?\btotal\s*:[\s\S]{0,220}?\b(?:page|limit|totalPages)\s*:/,
      },
      {
        name: 'return-literal explicit (return { data: ... totalPages: ... })',
        re: /return\s*\{[\s\S]{0,80}?\bdata\s*:[\s\S]{0,220}?\btotalPages\s*:/,
      },
    ];

    const out = execSync(
      "git ls-files -- 'apps/admin-api-service/src/**/*.ts'",
      { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
    );
    const files = out
      .split('\n')
      .filter(Boolean)
      .filter((p) => existsSync(resolve(REPO_ROOT, p)))
      // Specs/tests build fixture shapes; scan production source only.
      .filter((p) => !/\.spec\.ts$|\.test\.ts$|__tests__\/|__mocks__\//.test(p))
      // The interceptor is the ONE sanctioned {success,data,meta} envelope
      // constructor (its absence-of-legacy-branch is asserted above).
      .filter((p) => p !== 'apps/admin-api-service/src/shared/response.interceptor.ts');

    const hits: string[] = [];
    for (const file of files) {
      const src = read(file);
      for (const { name, re } of LEGACY_PATTERNS) {
        if (re.test(src)) {
          hits.push(`  ${file}\n      -> ${name}`);
        }
      }
    }

    if (hits.length > 0) {
      throw new Error(
        `${hits.length} legacy {data,total} paginated shape(s) found in admin-api ` +
          `production source:\n${hits.join('\n')}\n\n` +
          `Every paginated list producer MUST return ` +
          `createStandardPaginatedResult(items, total, page, limit) from ` +
          `@aquaculture/backend-common/pagination (which keys on \`items\`, not ` +
          `\`data\`). The interceptor's legacy {data,total} branch was deleted in ` +
          `RC-1b, so a data-keyed literal is no longer lifted into the REST ` +
          `envelope — it would break the consuming list. Migrate the producer ` +
          `(and its return TYPE) to the canonical helper.`,
      );
    }
    expect(hits).toEqual([]);
  });

  it('a representative set of migrated producers routes through the canonical helper', () => {
    // Spot-check across every hazard partition touched by RC-1a + RC-1b: if any
    // of these silently reverts to a hand-rolled shape, the completeness scan
    // above already fails — this positive check keeps the intent legible.
    const migrated = [
      'apps/admin-api-service/src/system-management/services/global-settings.service.ts',
      'apps/admin-api-service/src/billing/services/custom-plan.service.ts',
      'apps/admin-api-service/src/billing/services/discount-code.service.ts',
      'apps/admin-api-service/src/security/services/security-monitoring.service.ts',
      'apps/admin-api-service/src/security/services/audit-trail.service.ts',
      'apps/admin-api-service/src/support/services/ticket.service.ts',
      'apps/admin-api-service/src/database-management/services/backup-restore.service.ts',
      'apps/admin-api-service/src/impersonation/services/debug-session.service.ts',
      'apps/admin-api-service/src/analytics/services/reports.service.ts',
      'apps/admin-api-service/src/audit/audit.service.ts',
      'apps/admin-api-service/src/modules/modules.service.ts',
      'apps/admin-api-service/src/users/users.service.ts',
      'apps/admin-api-service/src/tenant/query-handlers/tenant-query.handlers.ts',
    ];
    for (const file of migrated) {
      const src = read(file);
      expect(src).toContain('createStandardPaginatedResult');
    }
  });
});
