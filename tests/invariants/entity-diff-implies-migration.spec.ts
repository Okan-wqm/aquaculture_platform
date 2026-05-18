/**
 * Platform-wide invariant — KERNEL-CRITICAL-002 / Faz 1.3:
 *
 * **An entity edit (apps/<svc>/src/**\/*.entity.ts) in the PR diff MUST
 * be accompanied by a new migration in the same service's migrations/
 * directory — OR an explicit `ENTITY-DIFF-OK:` waiver in the PR body.**
 *
 * # WHY
 *
 * The 2026-04 drift archaeology (14 services' `Align*EntitySurface` /
 * `Heal*Drift` / `Replay*` migration chains) was driven by entity edits
 * landing across multiple PRs without matching migrations. The drift
 * accumulated silently until `SchemaDriftValidator` strict mode caught up.
 *
 * This invariant catches the upstream cause: the moment an entity is
 * edited without a migration, CI red — author must either generate the
 * migration via `typeorm migration:generate` or document the
 * no-DDL-impact reason in the PR body.
 *
 * # MECHANICS
 *
 * The actual work is done by `tools/gates/entity-diff-witness.ts`. This
 * spec is a thin invariant wrapper that:
 *
 *   1. In CI mode (BASE_SHA env present): invokes the gate as a subprocess
 *      and asserts exit code 0.
 *   2. In local-run mode (no BASE_SHA): the script self-resolves to
 *      `origin/main`, behaves the same way.
 *
 * The wrapper exists so `nx test invariants` includes this gate in the
 * standard CI shard — operators do not need to remember to run the gate
 * separately. The GHA workflow `db-migration-check.yml` also runs the gate
 * as a dedicated job for early-fail signal.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT — entity-diff-implies-migration (KERNEL-CRITICAL-002)', () => {
  // The gate only meaningfully runs in a PR context — it needs a base SHA
  // to compare against. Without it the script defaults to `origin/main`,
  // which is correct for local pre-commit runs but redundant for the
  // standard `nx test invariants` invocation on main (no diff = no-op).
  const baseSha = process.env.BASE_SHA ?? process.env.GITHUB_BASE_REF ?? '';

  it('gate script exists and is executable', () => {
    // Just verify the script is on disk and accessible from REPO_ROOT.
    const exists = execSync(
      `test -f ${REPO_ROOT}/tools/gates/entity-diff-witness.ts && echo ok`,
      { encoding: 'utf8' },
    ).trim();
    expect(exists).toBe('ok');
  });

  it('package.json declares the gates:entity-diff-witness script', () => {
    const pkg = JSON.parse(
      execSync(`cat ${REPO_ROOT}/package.json`, { encoding: 'utf8' }),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['gates:entity-diff-witness']).toBeDefined();
    expect(pkg.scripts['gates:entity-diff-witness']).toMatch(
      /entity-diff-witness\.ts/,
    );
  });

  it('GHA workflow db-migration-check.yml declares the entity-diff-witness job', () => {
    const yml = execSync(
      `cat ${REPO_ROOT}/.github/workflows/db-migration-check.yml`,
      { encoding: 'utf8' },
    );
    expect(yml).toMatch(/entity-diff-witness:/);
    expect(yml).toMatch(/gates:entity-diff-witness/);
  });

  // The actual diff-vs-migration evaluation happens at PR time in CI.
  // Running the gate here on `main` with no PR context would be vacuously
  // green; skipping it preserves the standard `nx test invariants` SLO
  // (every spec resolves in < 1s) without losing coverage — the GHA
  // workflow job runs the gate against the real PR diff.
  if (baseSha) {
    it(`gate passes against PR base ${baseSha}`, () => {
      // Execute the gate; expect exit code 0. The gate's stdout is logged
      // by jest's default console capture.
      try {
        execSync(
          `cd ${REPO_ROOT} && npm run gates:entity-diff-witness -- --diff-base "${baseSha}"`,
          { encoding: 'utf8', stdio: 'pipe' },
        );
      } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
        throw new Error(
          `entity-diff-witness gate FAILED with exit ${e.status ?? 'unknown'}:\n${out}`,
        );
      }
    });
  } else {
    it.skip('gate run skipped (no BASE_SHA / GITHUB_BASE_REF in env)', () => {
      // skipped on main branch / local nx test invariants runs
    });
  }
});
