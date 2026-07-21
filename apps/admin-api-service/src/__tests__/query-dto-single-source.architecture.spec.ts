import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * RC-3 single query-source discipline (APA-013 / APA-114).
 *
 * A controller handler that mixes named `@Query('x')` params with a bare
 * whole-object `@Query() dto` in the SAME method 400s every filtered request:
 * under the global ValidationPipe (`whitelist` + `forbidNonWhitelisted`) the
 * bare DTO receives the ENTIRE query object and rejects the named keys it does
 * not declare. Every handler must take its query through exactly ONE source — a
 * single `@Query() dto` (extend `PaginationQueryDto` for the paginated ones)
 * whose class declares every filter key. This gate fails the build the moment a
 * handler declares both forms, so the footgun cannot reappear.
 *
 * There is deliberately NO allowlist.
 */
const REPO_ROOT = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf-8',
}).trim();

function controllerFiles(): string[] {
  const out = execSync(
    "git ls-files -- 'apps/admin-api-service/src/**/*.controller.ts'",
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter(Boolean);
}

interface Offender {
  readonly file: string;
  readonly method: string;
}

/** Balance-match the parameter list of every `async <name>(...)` and flag the
 *  ones whose params carry BOTH a named `@Query('x')` and a bare `@Query()`. */
function findMixedQueryHandlers(): Offender[] {
  const offenders: Offender[] = [];
  const asyncRe = /\basync\s+(\w+)\s*\(/g;
  for (const rel of controllerFiles()) {
    const src = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
    let m: RegExpExecArray | null;
    while ((m = asyncRe.exec(src)) !== null) {
      const method = m[1];
      if (method === undefined) continue;
      const open = asyncRe.lastIndex - 1; // index of the '('
      let depth = 0;
      let i = open;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const params = src.slice(open + 1, i);
      const hasNamedQuery = /@Query\(\s*['"]/.test(params);
      const hasBareQuery = /@Query\(\s*\)/.test(params);
      if (hasNamedQuery && hasBareQuery) {
        offenders.push({ file: rel, method });
      }
    }
  }
  return offenders;
}

describe('admin-api single query-source (RC-3)', () => {
  it('no controller handler mixes named @Query(...) params with a bare @Query() DTO', () => {
    const offenders = findMixedQueryHandlers();
    if (offenders.length > 0) {
      const list = offenders
        .map((o) => `  ${o.file} :: ${o.method}()`)
        .join('\n');
      throw new Error(
        `${offenders.length} controller handler(s) mix named @Query('x') params ` +
          `with a bare @Query() DTO:\n${list}\n\n` +
          `Under the global ValidationPipe (forbidNonWhitelisted) the bare DTO ` +
          `receives the WHOLE query object and 400s on the named keys it does ` +
          `not declare — breaking every filtered request. Consolidate the ` +
          `handler to ONE @Query() DTO (extend PaginationQueryDto for paginated ` +
          `endpoints) that declares every filter key.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
