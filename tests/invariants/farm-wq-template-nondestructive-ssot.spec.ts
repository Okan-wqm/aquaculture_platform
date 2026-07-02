/**
 * INVARIANT: water-quality parameter-config handlers never destructively
 * replace a tenant's configs.
 *
 * WHY: applying a template must be update-or-insert per parameter, never a
 * tenant-wide `delete(WaterQualityParameterConfig, { tenantId })` followed by a
 * bulk insert — that wipes a tenant's tuned per-parameter thresholds and every
 * CUSTOM (non-template) parameter (ORPHAN-MEDIUM-267). This invariant fails the
 * build if a water-quality handler reintroduces the destructive delete.
 *
 * Scope: every `*.handler.ts` under `apps/farm-service/src/water-quality`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, normalize, join, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WQ_SRC = resolve(REPO_ROOT, 'apps/farm-service/src/water-quality');

// `.delete(WaterQualityParameterConfig, { tenantId })` — a tenant-wide wipe
// keyed only by tenantId (no narrower predicate).
const DESTRUCTIVE_DELETE = /\.delete\(\s*WaterQualityParameterConfig\s*,\s*\{\s*tenantId\s*\}\s*\)/;

function findHandlerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findHandlerFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.handler.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('INVARIANT: water-quality config handlers apply templates non-destructively', () => {
  it('has no handler doing a tenant-wide delete of WaterQualityParameterConfig', () => {
    const violations = findHandlerFiles(WQ_SRC)
      .map((file) => ({
        relativePath: normalize(relative(WQ_SRC, file)).split(sep).join('/'),
        content: readFileSync(file, 'utf-8'),
      }))
      .filter(({ content }) => DESTRUCTIVE_DELETE.test(content))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });
});
