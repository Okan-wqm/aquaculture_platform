/**
 * INVARIANT: farm-module production mock-data imports may only SHRINK.
 *
 * WHY: several routed Reports tabs synchronously produce data from
 * `pages/reports/mock/*` with NO backend call — the literal producer of the
 * "data appears then disappears" symptom (Farm Data SSOT plan §3-C). Replacing
 * them needs real backend report read paths (tracked separately, large). Until
 * then this is a NO-GROW ratchet: the set of non-test farm-module source files
 * that import a mock module is FROZEN below. A NEW mock import fails the build;
 * removing one (wiring real data) requires deleting its baseline entry — a
 * deliberate, review-visible shrink. The set may only get smaller.
 *
 * This is the tier-3 ("make it detectable") half of the fix; the tier-1 removal
 * (real backend report aggregations) is the tracked follow-on.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_MODULE_SRC = resolve(REPO_ROOT, 'web/modules/farm-module/src');

/**
 * Frozen baseline of non-test farm-module files that still import production
 * mock data. POSIX-relative to web/modules/farm-module/src. This list MUST ONLY
 * SHRINK — see the file header. Do not add entries.
 */
// FARM-HIGH-125 closed the burn-down: every Reports surface now reads the
// persisted regulatory_reports / biomass_reports rows and pages/reports/mock/
// was deleted. The baseline is EMPTY and stays empty — this spec remains as
// the permanent no-mock gate for farm-module production code.
const MOCK_IMPORT_BASELINE = new Set<string>([]);

const MOCK_IMPORT_RE = /\bfrom\s+['"][^'"]*mock[^'"]*['"]/;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function findSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the mock data modules themselves and test dirs.
      if (entry.name === 'mock' || entry.name === '__tests__' || entry.name === 'node_modules') {
        continue;
      }
      files.push(...findSourceFiles(full));
      continue;
    }
    if (
      entry.isFile() &&
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.(spec|test)\.tsx?$/.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

function currentMockImporters(): string[] {
  return findSourceFiles(FARM_MODULE_SRC)
    .filter((f) => MOCK_IMPORT_RE.test(readFileSync(f, 'utf-8')))
    .map((f) => toPosix(relative(FARM_MODULE_SRC, f)))
    .sort();
}

describe('INVARIANT: farm-module production mock-data imports only shrink', () => {
  it('has no NEW mock import outside the frozen baseline', () => {
    const violations = currentMockImporters().filter((f) => !MOCK_IMPORT_BASELINE.has(f));
    expect(violations).toEqual([]);
  });

  it('keeps the baseline honest — every baselined file still imports mock data (removed entries must be deleted)', () => {
    const current = new Set(currentMockImporters());
    const stale = [...MOCK_IMPORT_BASELINE].filter((f) => !current.has(f));
    expect(stale).toEqual([]);
  });
});
