/**
 * INVARIANT: tank stock mutations are ALWAYS driven from the central command
 * path — the legacy BatchService write-shadow does not exist and nothing calls it.
 *
 * WHY: mortality / cull / transfer / allocation / harvest must flow through ONE
 * central system regardless of entry surface (mobile REST, web GraphQL, another
 * session) so every write goes through the same command handler → the single
 * writer (applyBatchDelta) → the same event stream. BatchService used to carry an
 * older second write path (`allocateBatchToTank`, `transferBatch`,
 * `recordOperation` + their private `updateTankBatch*` helpers) that wrote
 * tank_batches / current* directly, bypassing the handlers.
 *
 * FARM-HIGH-109 / FARM-LOW-211 deleted it once the last consumers — four
 * tenant-isolation e2e suites — were re-pointed at the real handlers. So this
 * invariant no longer needs to exempt a definition file, and it adds a second
 * check: BatchService must not regrow a write method, and the shadow's private
 * tank_batches writers must not exist anywhere. The METHOD NAMES themselves are
 * not banned — `batch.resolver.ts` legitimately exposes `allocateBatchToTank`
 * and `transferBatch` as GraphQL mutations that dispatch to the command bus.
 * What is banned is a service re-implementing the write. Comments and
 * *.spec.ts are excluded.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, normalize, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

// The legacy BatchService write-shadow methods. A call is `.<method>(`.
const LEGACY_BYPASS_CALL = /\.(allocateBatchToTank|transferBatch|recordOperation)\s*\(/;

// The shadow's private tank_batches writers. Unlike the mutation names, these
// exist for no reason other than a second write path.
const SHADOW_PRIVATE_WRITER =
  /^\s*(?:private\s+)?(?:async\s+)?updateTankBatch(?:WithManager)?\s*\(/m;

// BatchService is read-only now; any write method here is the shadow regrowing.
const BATCH_SERVICE = normalize('apps/farm-service/src/batch/services/batch.service.ts');
const BATCH_SERVICE_WRITE =
  /^\s*(?:private\s+)?(?:async\s+)?(?:createBatch|updateBatch|deleteBatch|allocateBatchToTank|transferBatch|recordOperation)\s*\(/m;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== 'node_modules' &&
        entry.name !== '__tests__' &&
        !entry.name.startsWith('.')
      ) {
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
      .filter(({ content }) => LEGACY_BYPASS_CALL.test(stripComments(content)))
      .map(({ rel }) => rel);

    expect(violations).toEqual([]);
  });

  it("the shadow's private tank_batches writers are not defined anywhere", () => {
    const definitions = productionFiles(FARM_SRC)
      .map((file) => ({
        rel: normalize(relative(REPO_ROOT, file)).split(sep).join('/'),
        content: readFileSync(file, 'utf-8'),
      }))
      .filter(({ content }) => SHADOW_PRIVATE_WRITER.test(stripComments(content)))
      .map(({ rel }) => rel);

    expect(definitions).toEqual([]);
  });

  it('BatchService stays read-only', () => {
    const file = productionFiles(FARM_SRC).find(
      (candidate) =>
        normalize(relative(REPO_ROOT, candidate)).split(sep).join('/') === BATCH_SERVICE,
    );
    expect(file).toBeDefined();
    expect(BATCH_SERVICE_WRITE.test(stripComments(readFileSync(file as string, 'utf-8')))).toBe(
      false,
    );
  });
});
