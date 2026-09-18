/**
 * A nullable numeric column read never loses its zero (FARM-HIGH-321).
 *
 * `DecimalTransformer.from` returns `number | null`, so a read already carries
 * two distinct values: `null` means nobody measured this, `0` means someone
 * measured zero. The response mapping is where they get collapsed —
 *
 *     sgr: batch.sgr ? Number(batch.sgr) : undefined
 *
 * — because the guard is truthiness, not nullness. It always collapses in the
 * direction that reads as "no data": a batch that did not grow reports as
 * unmeasured, a tank filled to the rim reports an unknown freeboard, feed that
 * cost nothing drops out of the total, a decommissioned location shows as
 * unbounded. Every column this reached is `nullable: true`, so zero was never a
 * sentinel for "unset" — the schema already had one.
 *
 * `numberOrUndefined` (libs/backend-common/src/database/decimal-transformer.ts)
 * is the only correct spelling, and this invariant keeps it that way.
 *
 * Scope: a guarded PROPERTY ACCESS (`obj.field`), which is what an entity read
 * looks like. A bare identifier is left alone on purpose — those are HTTP query
 * parameters (`page ? Number(page) : undefined`), where the value is a string
 * and the guard is also rejecting `''`. Different value, different rule.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Backend source trees whose reads go through the ORM. */
const SCANNED_ROOTS = ['apps', 'libs', 'platform'] as const;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  'build',
  '.nx',
  '__tests__',
  '.archive',
]);

/**
 * `obj.field ? Number(obj.field) : undefined` — the same property access on both
 * sides is what makes it a read-mapping rather than an unrelated ternary. The
 * backreference is the whole point: it will not match a guard on one value that
 * coerces another.
 */
const ZERO_DROPPING_READ =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\s*\?\s*Number\(\s*\1\s*\)\s*:\s*undefined/;

function sourceFiles(dirAbs: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const childAbs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...sourceFiles(childAbs));
    } else if (
      entry.isFile() &&
      extname(entry.name) === '.ts' &&
      !entry.name.endsWith('.spec.ts')
    ) {
      out.push(childAbs);
    }
  }
  return out;
}

describe('INVARIANT: a nullable numeric read keeps its zero', () => {
  const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(resolve(REPO_ROOT, root)));

  it('scans the backend source it is meant to govern', () => {
    // A walker that matched nothing would make the case below vacuous.
    expect(files.length).toBeGreaterThan(1_000);
  });

  it('maps every nullable numeric column through numberOrUndefined', () => {
    const offenders: string[] = [];

    for (const fileAbs of files) {
      const lines = readFileSync(fileAbs, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (ZERO_DROPPING_READ.test(line)) {
          offenders.push(`${relative(REPO_ROOT, fileAbs)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} read(s) drop a legitimate 0 by guarding on truthiness. ` +
          `Use numberOrUndefined() from @aquaculture/backend-common/database, which ` +
          `maps only null/undefined away:\n` +
          offenders.map((line) => `  ${line}`).join('\n'),
      );
    }

    expect(offenders).toEqual([]);
  });

  it('leaves query-parameter coercion alone', () => {
    // The rule is about entity reads. A bare identifier is a query string, where
    // the guard also rejects '' and 0 is not a measurement — matching it would
    // make the invariant unlandable for a reason it cannot defend.
    expect(ZERO_DROPPING_READ.test('page ? Number(page) : undefined')).toBe(false);
    expect(ZERO_DROPPING_READ.test('tank.freeboard ? Number(tank.freeboard) : undefined')).toBe(
      true,
    );
    // A guard on one value that coerces another is not this defect.
    expect(ZERO_DROPPING_READ.test('a.x ? Number(a.y) : undefined')).toBe(false);
  });
});
