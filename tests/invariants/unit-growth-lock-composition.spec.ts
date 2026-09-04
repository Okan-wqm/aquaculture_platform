/**
 * INVARIANT: the unit-growth lock protocol is composed the same way everywhere.
 *
 * ## Why a gate rather than "we fixed the two callers"
 *
 * Applying growth to a unit takes TWO pieces that must be assembled in a
 * specific relationship, and neither piece can enforce the other:
 *
 *   - `lockUnitForGrowth(...)` acquires the canonical lock INSIDE the
 *     transaction, and throws `ConflictException` when the unit's batch
 *     membership changed between its lockless preview and its locked read;
 *   - `withUnitLockRetry(fn)` must wrap the WHOLE unit of work, OUTSIDE the
 *     transaction, because what gets retried is the work, not the lock.
 *
 * Assembling that by hand at every call site is a copy, and copies drift. They
 * did: five call sites wrapped correctly while `CreateFeedingRecordHandler` —
 * an operator-facing GraphQL mutation — called the lock bare, so a concurrent
 * transfer, stocking or full harvest surfaced to the operator as a raw 409
 * (FARM-MEDIUM-288). Nothing upstream absorbs it: `@platform/cqrs` has no retry
 * layer.
 *
 * The same shape produced the second defect. Deciding whether a batch still
 * needs its own lock was ALSO hand-written per call site, and the two copies
 * disagreed: one asked whether the unit lock actually covers this batch, the
 * other asked merely whether a unit lock exists. The second is wrong whenever
 * `lockUnitForGrowth` returns a token with an empty `batches` map (an emptied
 * tank) or when the record's batch has since left the unit — the aggregate was
 * then read-modify-written with no lock at all, under a comment asserting it was
 * safe (FARM-HIGH-248).
 *
 * So the rule is not "remember to wrap" and not "remember to check membership".
 * It is: there is ONE way to ask each question, and this gate fails the build
 * for any file that asks it a second way.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Callers that acquire the unit lock without an enclosing retry, each with the
 * reason the retry is genuinely unnecessary. A ConflictException here must have
 * somewhere safe to land.
 */
const RETRY_EXEMPT: Readonly<Record<string, string>> = {
  'apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts':
    'Sweep job: a ConflictException aborts this tenant tick and the same work is ' +
    'retried by the next hourly tick, so no operator ever sees it.',
};

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('.spec.ts'));
}

interface Hit {
  readonly file: string;
  readonly source: string;
}

/** Files that call `lockUnitForGrowth`, excluding the service that defines it. */
function lockCallers(files: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    if (file.endsWith('biomass-growth-applier.service.ts')) continue;
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    if (!/\blockUnitForGrowth\s*\(/.test(source)) continue;
    hits.push({ file, source });
  }
  return hits;
}

describe('INVARIANT: unit-growth lock composition', () => {
  const files = sourceFiles();
  const callers = lockCallers(files);

  it('scans a real corpus (a broken glob must not fake a pass)', () => {
    expect(files.length).toBeGreaterThan(500);
    // The call sites this invariant was written for.
    expect(callers.map((c) => c.file)).toEqual(
      expect.arrayContaining([
        'apps/farm-service/src/feeding/handlers/create-feeding-record.handler.ts',
        'apps/farm-service/src/feeding/handlers/update-feeding-record.handler.ts',
        'apps/farm-service/src/feeding-protocol/services/meal-execution.service.ts',
      ]),
    );
  });

  it('wraps every unit-lock acquisition in the shared retry', () => {
    const unwrapped = callers
      .filter((c) => !(c.file in RETRY_EXEMPT))
      .filter((c) => !/\bwithUnitLockRetry\s*\(/.test(c.source))
      .map(
        (c) =>
          `${c.file} calls lockUnitForGrowth() without withUnitLockRetry() — a concurrent ` +
          `membership change reaches the caller as a raw 409`,
      );

    expect(unwrapped).toEqual([]);
  });

  it('never decides batch locking from the mere PRESENCE of a unit lock', () => {
    // `lock: locked ? undefined : {...}` and friends: the truthiness of the
    // token is not the question. `lockBatchForWrite()` asks the token whether it
    // actually covers the batch, and is the only sanctioned way to ask.
    const offenders: string[] = [];
    for (const { file, source } of callers) {
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        if (/lock:\s*locked\s*\?/.test(line) || /locked\s*\?\s*undefined\s*:/.test(line)) {
          offenders.push(
            `${file}:${index + 1} decides the batch lock from token presence; ` +
              `call growthApplier.lockBatchForWrite() instead`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the retry exemption honest — every entry still acquires the lock', () => {
    const stale = Object.entries(RETRY_EXEMPT).filter(([file, reason]) => {
      expect(reason.length).toBeGreaterThan(0);
      return !callers.some((c) => c.file === file);
    });

    expect(stale.map(([file]) => file)).toEqual([]);
  });
});
