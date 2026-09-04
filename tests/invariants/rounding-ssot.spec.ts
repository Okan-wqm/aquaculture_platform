/**
 * INVARIANT: farm-service has exactly ONE decimal-rounding implementation.
 *
 * ## Why this gate exists rather than a docblock
 *
 * The same 3-decimal rounding was copied across farm-service and a wave was
 * shipped that claimed to consolidate it. It did not. The finding's prose named
 * four files, four were folded in, and the commit message repeated the number —
 * but `git grep 'function round3'` at that commit returned SIX declaration
 * sites. Matching the count in the ticket rather than the state of the tree left
 * two copies behind, one of them in the SSoT's own directory.
 *
 * Then it got worse in the way only an unguarded rule can: a SEVENTH copy was
 * added AFTER the consolidation shipped, in `update-feeding-record.handler.ts`.
 * So "single source of truth" was, for several waves, an assertion in a comment
 * while the code kept growing new copies (FARM-LOW-295).
 *
 * ## Why the drift is not cosmetic
 *
 * These values enter the same reconciliation equations. `plannedTotalKg` is
 * produced by the meal-plan generator and re-derived by the intra-day recalc;
 * biomass shares are written by the growth applier and re-summed by the rollup.
 * While the generator rounded through its private copy and the recalc through
 * the shared one, the two halves of the same equation depended on separately
 * editable functions. A divergence there does not raise — the totals simply stop
 * reconciling, which is the failure mode hardest to notice and hardest to
 * reconstruct after the fact.
 *
 * The rule is therefore structural: import the util, or fail the build.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The one file allowed to declare a rounding helper. */
const SSOT = 'apps/farm-service/src/common/utils/rounding.util.ts';

/**
 * Rounding helpers that must not be redeclared. Keyed by name so a second
 * precision (round2 for money, say) joins the rule by being added here rather
 * than by being copied into a service.
 */
const GUARDED = ['round3', 'round2'] as const;

function farmServiceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'apps/farm-service/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface Declaration {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

/** Local declarations of a guarded helper: `function roundN` / `const roundN =`. */
function declarations(files: readonly string[]): Declaration[] {
  const found: Declaration[] = [];
  for (const file of files) {
    const source = readFileSync(join(REPO_ROOT, file), 'utf8');
    source.split('\n').forEach((line, index) => {
      for (const name of GUARDED) {
        const declared =
          new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(line) ||
          new RegExp(`\\b(?:const|let)\\s+${name}\\s*[:=]`).test(line);
        if (declared) found.push({ file, line: index + 1, name });
      }
    });
  }
  return found;
}

describe('INVARIANT: rounding SSoT', () => {
  const files = farmServiceFiles();

  it('scans a real corpus (a broken glob must not fake a pass)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(SSOT);
  });

  it('declares each guarded rounding helper in exactly one place', () => {
    const offenders = declarations(files)
      .filter((d) => d.file !== SSOT)
      // A spec may define its own expected-value helper; it is not a production
      // rounding path and cannot cause the production halves to diverge.
      .filter((d) => !d.file.endsWith('.spec.ts'))
      .map(
        (d) =>
          `${d.file}:${d.line} redeclares ${d.name}() — import it from ` +
          `${SSOT} instead; two editable copies let the same equation's halves drift`,
      );

    expect(offenders).toEqual([]);
  });

  it('keeps the SSoT exporting what the rule promises', () => {
    const source = readFileSync(join(REPO_ROOT, SSOT), 'utf8');
    // round3 must exist and be exported; the others are guarded-if-present, so
    // the list can grow without this assertion needing to know about them.
    expect(source).toMatch(/export function round3\s*\(/);
  });

  it('is reachable from the domains that need it (no boundary excuse to copy)', () => {
    // The two surviving copies lived in `batch/` and `feeding/` precisely
    // because the util used to sit inside `feeding-protocol/services/`, so
    // importing it would have crossed a domain boundary. Pinning the shared
    // location keeps that excuse from returning.
    expect(SSOT.startsWith('apps/farm-service/src/common/')).toBe(true);
  });
});
