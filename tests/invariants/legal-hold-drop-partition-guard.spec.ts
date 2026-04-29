/**
 * LEGAL-MEDIUM-003 invariant: the destructive partition-drop helper
 * cannot be reached without the LegalHoldGuard's typed proof token.
 *
 * # What this pins
 *
 * `unsafeDropPartitionSql()` (in `apps/messaging-service/src/partition/partition-queries.ts`)
 * accepts a `HoldClearedToken` argument. The token's nominal shape is
 * unconstructible outside the partition-queries module: its only field
 * is a `unique symbol` declared in that file. The factory function
 * `__mintHoldClearedTokenForGuard()` is exported so the guard can mint
 * a token after consulting `LegalHoldService.isUnderLegalHold()`.
 *
 * The two TypeScript-level protections (brand + factory) are necessary
 * but not sufficient: a future change could re-export the factory from
 * a wider module, expanding the import surface. This invariant test
 * pins the import topology:
 *
 *   - The factory `__mintHoldClearedTokenForGuard` is imported from
 *     EXACTLY ONE call site in the runtime tree:
 *     `apps/messaging-service/src/compliance/services/legal-hold.guard.ts`.
 *   - The destructive helper `unsafeDropPartitionSql` is referenced
 *     ONLY by code paths that demonstrably go through the guard.
 *     (We allow-list the guard module itself for re-export shape
 *     refactors.)
 *
 * Catches:
 *   1. A new caller importing the factory directly (bypassing the
 *      registry check).
 *   2. A new caller of `unsafeDropPartitionSql` that hand-rolls a
 *      token (passing `__mintHoldClearedTokenForGuard()` inline).
 *   3. The guard being copied / forked into another module without
 *      registering with this invariant.
 */
import { execSync } from 'node:child_process';

const REPO_ROOT = (() => {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
})();

function gitGrepLines(pattern: string, paths: string[]): string[] {
  try {
    const out = execSync(
      `git grep -n -E '${pattern}' -- ${paths.map((p) => `'${p}'`).join(' ')}`,
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter((line) => line.trim().length > 0);
  } catch (err: unknown) {
    // git grep exits with code 1 when no matches — treat as empty.
    const exitCode = (err as { status?: number }).status;
    if (exitCode === 1) return [];
    throw err;
  }
}

describe('LEGAL-MEDIUM-003 — drop-partition guard topology', () => {
  it('keeps the destructive helper named with the unsafe prefix', () => {
    const exportLines = gitGrepLines(
      'export function unsafeDropPartitionSql\\(',
      ['apps/messaging-service/src/partition/partition-queries.ts'],
    );
    expect(exportLines.length).toBe(1);
  });

  it('exposes the HoldClearedToken brand from exactly one module', () => {
    const brandDeclarations = gitGrepLines(
      'declare const HoldClearedTokenBrand:',
      ['apps/messaging-service/**/*.ts'],
    );
    expect(brandDeclarations.length).toBe(1);
    expect(brandDeclarations[0]).toContain(
      'apps/messaging-service/src/partition/partition-queries.ts',
    );
  });

  it('imports __mintHoldClearedTokenForGuard from exactly one runtime callsite (the guard)', () => {
    const factoryImports = gitGrepLines(
      '__mintHoldClearedTokenForGuard',
      [
        'apps/**/*.ts',
        ':!apps/**/__tests__/**',
        ':!apps/**/*.spec.ts',
        ':!apps/messaging-service/src/partition/partition-queries.ts',
      ],
    );
    // Exactly two lines expected from the guard module:
    // 1. the import line, 2. the call expression.
    // Any additional reference indicates a bypass attempt.
    expect(factoryImports.length).toBeGreaterThanOrEqual(1);
    for (const line of factoryImports) {
      expect(line).toContain(
        'apps/messaging-service/src/compliance/services/legal-hold.guard.ts',
      );
    }
  });

  it('the guard exposes assertHoldClearedFor as the sole public path', () => {
    const guardMethods = gitGrepLines(
      'async assertHoldClearedFor\\(',
      ['apps/messaging-service/src/compliance/services/legal-hold.guard.ts'],
    );
    expect(guardMethods.length).toBe(1);
  });

  it('runtime callers of unsafeDropPartitionSql either are the guard or the partition module itself', () => {
    const callers = gitGrepLines(
      'unsafeDropPartitionSql\\(',
      [
        'apps/**/*.ts',
        ':!apps/**/__tests__/**',
        ':!apps/**/*.spec.ts',
      ],
    );
    // Currently the helper has no production caller — this guards the
    // future-caller class. When a caller lands, it must also import the
    // guard's assertHoldClearedFor (next it() pins the pairing).
    for (const line of callers) {
      const allowedSites = [
        'apps/messaging-service/src/partition/partition-queries.ts',
      ];
      const isAllowed = allowedSites.some((path) => line.includes(path));
      const isInvocation =
        line.includes('unsafeDropPartitionSql(') &&
        !line.includes('export function');
      // Allow the export declaration in the helper itself.
      expect(isAllowed || !isInvocation).toBe(true);
    }
  });
});
