/**
 * INVARIANT: tank stock mutations are ALWAYS driven from the central command
 * path — no production code calls the legacy BatchService write-shadow.
 *
 * WHY: mortality / cull / transfer / allocation / harvest must flow through ONE
 * central system regardless of entry surface (mobile REST, web GraphQL, another
 * session) so every write goes through the same command handler → the single
 * writer (applyBatchDelta) → the same event stream. BatchService still carries an
 * older, now-DEAD second write path (`allocateBatchToTank`, `transferBatch`,
 * `recordOperation` + their private `updateTankBatch*` helpers) that writes
 * tank_batches / current* directly, bypassing the handlers. It has zero production
 * callers today; this invariant fails the build if any production file revives one
 * as a bypass. Its physical deletion + the e2e-spec migration off it is tracked as
 * FARM-HIGH-109 (the only remaining caller is a tenant-isolation e2e spec that must
 * first be re-pointed at AllocateToTankHandler / TransferBatchHandler). Comments
 * and *.spec.ts are excluded from the scan.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, normalize, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

// The legacy BatchService write-shadow methods. A call is `.<method>(`.
const LEGACY_BYPASS_CALL = /\.(allocateBatchToTank|transferBatch|recordOperation)\s*\(/;

// The definition file (BatchService itself) is where the dead methods still live
// until FARM-HIGH-109 deletes them — not a "caller", so it is excluded.
const DEFINITION_FILE = normalize('apps/farm-service/src/batch/services/batch.service.ts');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__' && !entry.name.startsWith('.')) {
        files.push(...productionFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('INVARIANT: tank stock mutations are central-command only', () => {
  it('no production code calls the legacy BatchService write-shadow (allocateBatchToTank / transferBatch / recordOperation)', () => {
    const violations = productionFiles(FARM_SRC)
      .map((file) => ({
        rel: normalize(relative(REPO_ROOT, file)).split(sep).join('/'),
        content: readFileSync(file, 'utf-8'),
      }))
      .filter(({ rel }) => normalize(rel) !== DEFINITION_FILE)
      .filter(({ content }) => LEGACY_BYPASS_CALL.test(stripComments(content)))
      .map(({ rel }) => rel);

    expect(violations).toEqual([]);
  });
});
