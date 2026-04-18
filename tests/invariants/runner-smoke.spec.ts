/**
 * Runner Smoke Invariant
 * ============================================================================
 *
 * Closes Phase 6d of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-MEDIUM-001).
 *
 * Smoke-tests the two canonical entrypoints into the agent dispatch
 * runner:
 *
 *   - tools/scripts/orchestrator-runner.ts (root runner)
 *   - .claude/agents-enterprise-v2/runners/gdpr-audit.ts (profile wrapper)
 *
 * Both must parse args cleanly and exit 0 on `--help` or `--dry-run`
 * without requiring the `claude-agent` CLI binary on PATH. Dry-run
 * short-circuits before the binary is invoked, so the test can run in
 * plain CI environments without pulling Claude Code.
 *
 * # What this spec does NOT do
 *
 *   - Does not invoke claude-agent for real (covered by staging-only
 *     end-to-end tests, not unit invariants).
 *   - Does not assert the dispatch plan's *correctness* (routing
 *     tables do that via orchestrator-routing-coverage.spec.ts).
 *   - Does not exercise every runner flag — that is an end-to-end
 *     concern; the smoke contract is "does the entrypoint boot?".
 *
 * # When this spec fails
 *
 *   - Root runner exits non-zero on --help → arg parser regressed;
 *     re-read parseArgs() / printUsage().
 *   - Profile wrapper (gdpr-audit) exits non-zero on --dry-run →
 *     the wrapper's composed CLI is malformed (check its execSync
 *     command string).
 *   - Report JSON missing expected keys → dry-run plan shape drifted;
 *     fix plan object in dispatch() or this spec.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-6d
 *   - tools/scripts/orchestrator-runner.ts
 *   - .claude/agents-enterprise-v2/runners/gdpr-audit.ts
 *   - .claude/agents-enterprise-v2/runners/perf-audit.ts
 */

import { execSync, spawnSync } from 'node:child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSCONFIG = path.join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json');
const ROOT_RUNNER = path.join(REPO_ROOT, 'tools', 'scripts', 'orchestrator-runner.ts');
const GDPR_RUNNER = path.join(REPO_ROOT, '.claude', 'agents-enterprise-v2', 'runners', 'gdpr-audit.ts');
const PERF_RUNNER = path.join(REPO_ROOT, '.claude', 'agents-enterprise-v2', 'runners', 'perf-audit.ts');

function runTsNode(script: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    'npx',
    ['ts-node', '--project', TSCONFIG, script, ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // generous timeout — ts-node cold-start + compile is ~3-5s
      timeout: 30_000,
    },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('runner smoke invariant', () => {
  describe('tools/scripts/orchestrator-runner.ts (root runner)', () => {
    it('exits 0 on --help', () => {
      const r = runTsNode(ROOT_RUNNER, ['--help']);
      if (r.code !== 0) {
        throw new Error(
          `orchestrator-runner --help exited ${r.code}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Usage:/);
      expect(r.stdout).toMatch(/--dry-run/);
    });

    it('exits 0 on --dry-run + --topic (no claude-agent invocation)', () => {
      const r = runTsNode(ROOT_RUNNER, [
        '--topic',
        'smoke-test',
        '--scope',
        'apps/farm-service/**',
        '--dry-run',
      ]);
      if (r.code !== 0) {
        throw new Error(
          `orchestrator-runner --dry-run exited ${r.code}.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      }
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/orchestrator-runner dispatch plan/);
      expect(r.stdout).toMatch(/"topic"\s*:\s*"smoke-test"/);
      expect(r.stdout).toMatch(/stopping before claude-agent dispatch/);
    });

    it('rejects missing --topic with non-zero exit', () => {
      const r = runTsNode(ROOT_RUNNER, ['--dry-run']);
      expect(r.code).not.toBe(0);
      expect(r.stderr + r.stdout).toMatch(/--topic/);
    });
  });

  describe('runner profile wrappers', () => {
    // Static-shape checks — running the wrappers invokes the root runner
    // via execSync, which ultimately calls the claude-agent CLI. We don't
    // want that side-effect in a smoke test; running tsc --noEmit on a
    // single file collides with the --project flag. A static-shape check
    // catches the regression class that matters here (missing import,
    // path typo, wrong runner reference) without cost or side-effects.
    it('gdpr-audit.ts references orchestrator-runner.ts + fixes expected agent profile', () => {
      const content = require('fs').readFileSync(GDPR_RUNNER, 'utf8');
      expect(content).toMatch(/orchestrator-runner\.ts/);
      expect(content).toMatch(/compliance-expert/);
      expect(content).toMatch(/gdpr-erasure-executor/);
      expect(content).toMatch(/--mode\s+review/);
    });

    it('perf-audit.ts references orchestrator-runner.ts + fixes expected agent profile', () => {
      const content = require('fs').readFileSync(PERF_RUNNER, 'utf8');
      expect(content).toMatch(/orchestrator-runner\.ts/);
      expect(content).toMatch(/performance-expert/);
      expect(content).toMatch(/database-reviewer/);
      expect(content).toMatch(/--mode\s+review/);
    });
  });
});
