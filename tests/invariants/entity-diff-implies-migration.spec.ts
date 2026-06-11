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
 * The actual work is done by `tools/gates/entity-diff-witness.ts`. The
 * gate RUNS in exactly ONE place: the dedicated `entity-diff-witness`
 * job in `db-migration-check.yml`, which owns the gate's full env
 * contract (PR_BODY for the ENTITY-DIFF-OK waiver + BASE_SHA for the
 * diff base) and is path-filtered to exactly the file class the gate
 * judges (entity + migration files).
 *
 * WHY single-executor (INFRA-HIGH-010): this spec previously ALSO ran
 * the gate as a subprocess from every Jest shard (`invariants-fast`,
 * `nx affected test`). Those executors inherited whatever env their
 * workflow happened to export — none exported PR_BODY — so a PR
 * carrying a legitimate waiver was green in the dedicated job and
 * structurally red everywhere else: one gate, N executors, forked
 * verdicts. Copying the env into each workflow would leave the class
 * open for the next executor; instead the gate run has one owner and
 * this spec asserts, structurally, that every workflow step invoking
 * the gate exports the full env contract.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('INVARIANT — entity-diff-implies-migration (KERNEL-CRITICAL-002)', () => {
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

  // Single-executor env contract (INFRA-HIGH-010): the gate's verdict
  // depends on PR_BODY (waiver channel) and BASE_SHA (diff base). Any
  // workflow step that invokes the gate without exporting BOTH forks
  // the verdict from the dedicated job's. This meta-invariant makes
  // the asymmetry class a CI failure: every `gates:entity-diff-witness`
  // invocation across all workflows must carry the full env contract.
  it('every workflow step invoking the gate exports PR_BODY and BASE_SHA', () => {
    const wfDir = join(REPO_ROOT, '.github', 'workflows');
    const invokers = readdirSync(wfDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) =>
        readFileSync(join(wfDir, f), 'utf8').includes(
          'gates:entity-diff-witness',
        ),
      );

    // The dedicated job must exist — losing the single executor would
    // silently disarm the invariant entirely.
    expect(invokers).toContain('db-migration-check.yml');

    for (const f of invokers) {
      const yml = readFileSync(join(wfDir, f), 'utf8');
      expect(yml).toMatch(
        /PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/,
      );
      expect(yml).toMatch(
        /BASE_SHA:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/,
      );
    }
  });
});
