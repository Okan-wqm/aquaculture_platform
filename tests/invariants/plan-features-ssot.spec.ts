/**
 * Platform-wide invariant — ORPHAN-176/-166 sibling (per-plan feature catalog):
 *
 * `PLAN_FEATURES` — the per-plan map of gateway `TenantFeatures` flags
 * (advancedAnalytics / alertEngine / iotIntegration / apiAccess / customReports
 * / multiSite / whiteLabeling / ssoEnabled) — MUST be DECLARED exactly once and
 * imported everywhere else.
 *
 * # Why
 *
 * Pre-fix the identical map was hand-copied into BOTH
 * `apps/gateway-api/src/middleware/tenant-context.middleware.ts` AND
 * `apps/gateway-api/src/services/tenant-lookup.service.ts`. Two copies of the
 * same per-tier feature truth drift the moment one tier's flag is toggled in
 * one file but not the other — exactly the catalog-duplication class
 * PLAN_CATALOG (SSOT-C-13) exists to prevent. This invariant fails any second
 * declaration so a re-introduced copy cannot merge.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT (ORPHAN-166): PLAN_FEATURES is declared exactly once', () => {
  it('exactly one `(export )?const PLAN_FEATURES` declaration exists under apps/gateway-api', () => {
    const files = execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', 'apps/gateway-api/**/*.ts'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
      .split('\n')
      .filter((f) => f.length > 0 && !f.endsWith('.spec.ts'));

    const declRe = /^\s*export\s+const\s+PLAN_FEATURES\s*:|^\s*const\s+PLAN_FEATURES\s*:/;
    const decls: string[] = [];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      for (const line of src.split('\n')) {
        if (declRe.test(line)) {
          decls.push(rel);
        }
      }
    }

    if (decls.length !== 1) {
      throw new Error(
        `Expected exactly ONE PLAN_FEATURES declaration (the gateway SSoT), found ${decls.length}:\n` +
          decls.map((d) => `  ${d}`).join('\n') +
          '\nImport the canonical PLAN_FEATURES instead of hand-copying the per-plan feature map.',
      );
    }
  });
});
