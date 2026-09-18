/**
 * Platform-wide invariant — SENSOR-MEDIUM-112:
 *
 * A focused `ScadaPackageService` test module is wired in exactly ONE place:
 * `apps/sensor-service/src/process/services/__tests__/scada-package-harness.ts`.
 *
 * # Why
 *
 * Five `Test.createTestingModule` blocks across three spec files each restated
 * the same four providers — the service, an `EventEmitter2` stub, and the
 * `ScadaPackage` / `Process` repository tokens — differing only in the mocks
 * they passed. No spec asserted on the emitter; it was there because the
 * constructor requires it.
 *
 * That shape fails in a specific, unhelpful way. When the production
 * constructor gains a dependency, each copy has to learn about it separately,
 * and the copy that does not fails at DI resolution with an error naming a
 * missing provider rather than the behaviour under test — so the signal points
 * at the test harness instead of at the change that broke it. The more copies,
 * the more likely one is edited and the rest silently drift.
 *
 * # What this test enforces
 *
 *   1. No spec beside the harness lists `ScadaPackageService` in a
 *      `Test.createTestingModule` providers array.
 *   2. The harness itself supplies the dependencies a copy would have to
 *      remember: `EventEmitter2` and both repository tokens.
 *   3. The specs actually use it — so the rule cannot pass vacuously by every
 *      spec having stopped constructing the service at all.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const SPEC_DIR = 'apps/sensor-service/src/process/services/__tests__/';
const HARNESS = `${SPEC_DIR}scada-package-harness.ts`;

/**
 * A `Test.createTestingModule({ ... })` call whose provider list names
 * ScadaPackageService. `[\s\S]` rather than `.` so a multi-line providers array
 * is matched; bounded to 2000 chars so it cannot run past the call it is in.
 */
const INLINE_SERVICE_MODULE = /Test\.createTestingModule\(\{[\s\S]{0,2000}?\bScadaPackageService\b/;

function specFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', `${SPEC_DIR}*.spec.ts`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT (SENSOR-MEDIUM-112): the ScadaPackageService test module has one definition', () => {
  it('finds the spec directory (guards against a silently empty file list)', () => {
    expect(specFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('no spec wires ScadaPackageService into its own testing module', () => {
    const offenders = specFiles().filter((rel) => INLINE_SERVICE_MODULE.test(read(rel)));

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} spec(s) build their own ScadaPackageService test module:\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nUse createScadaPackageHarness() from ${HARNESS} instead. A second copy of the\n` +
          'wiring has to learn about every new constructor dependency separately, and the\n' +
          'copy that does not fails at DI resolution with an error about a missing provider\n' +
          'rather than about the behaviour under test (SENSOR-MEDIUM-112).',
      );
    }
  });

  it('the harness supplies what a copy would have to remember', () => {
    const src = read(HARNESS);
    expect(src).toMatch(/provide:\s*EventEmitter2/);
    expect(src).toMatch(/getRepositoryToken\(ScadaPackage\)/);
    expect(src).toMatch(/getRepositoryToken\(Process\)/);
    expect(src).toMatch(/export async function createScadaPackageHarness\(/);
  });

  it('the specs actually use the harness (the rule is not vacuous)', () => {
    const users = specFiles().filter((rel) => /createScadaPackageHarness\(/.test(read(rel)));
    expect(users.length).toBeGreaterThanOrEqual(3);
  });
});
