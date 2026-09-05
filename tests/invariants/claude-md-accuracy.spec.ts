/**
 * CLAUDE.md Accuracy Invariants
 * ============================================================================
 *
 * The CLAUDE.md / AGENTS.md steering files DIRECT Claude Code on every turn —
 * a stale path or a bloated file silently mis-directs every future agent
 * action. This spec makes steering-file rot DETECTABLE at CI time (the repo's
 * own Tier-3 principle applied to its own steering layer).
 *
 * Scope is deliberately narrow — it asserts ONLY what no other invariant owns:
 *   1. Path existence — every concrete repo path cited in a steering file
 *      resolves on disk (strip a leading `@`; skip globs/placeholders).
 *   2. Line budgets — root CLAUDE.md <= 200 lines; nested CLAUDE.md <= 80
 *      (Claude Code memory guidance: longer files reduce adherence).
 *   3. Nested hygiene — each nested CLAUDE.md carries a PROSE inheritance note
 *      (never an `@../../CLAUDE.md` import, which would double-load the
 *      always-loaded root), and no steering file resurrects a dead-terminology
 *      token (extends active-path-hygiene's root-only coverage to nested files).
 *
 * It does NOT re-assert the shared-schema table list (owned by
 * shared-schema-canonical.spec.ts + schema-invariants.spec.ts) nor the apps/
 * service count (owned by knowledge-ssot.spec.ts) — duplicating those would
 * violate the no-duplication rule the steering rewrite itself enforces.
 *
 * Worktree copies (.worktrees/, .codex-worktrees/, .claude/worktrees/) are
 * byte-identical checkouts of other branches and are excluded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { discoverSteeringFiles } from './_constants';
import { isKnownUnrunnable, runnersOf } from './helpers/spec-runners';
import { workflowScriptReferences } from './helpers/workflows';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Top-level repo directories a real cited path can start with. */
const KNOWN_TOP_LEVEL = [
  'apps',
  'libs',
  'platform',
  'web',
  'sens-api-gateway',
  'sensorprotocols',
  'infrastructure',
  'tools',
  'scripts',
  'docs',
  'e2e',
  'tests',
  '.claude',
] as const;

// `(?<!@)` rejects npm-scope aliases like `@platform/cqrs` (the real dir is
// `platform/libs/cqrs`) and agent-body `@.claude/...` reader-bookmarks.
// `{}*<>` are inside the char class so glob/placeholder tokens
// (`.claude/knowledge/layer-{1,2,3}-*.md`, `apps/<svc>/...`) are captured
// whole and then self-skip via the `[*{}<>$]` guard below.
const PATH_RX = new RegExp(
  `(?<!@)(?:${KNOWN_TOP_LEVEL.map((d) => d.replace('.', '\\.')).join('|')})\\/[A-Za-z0-9._\\/{}*<>-]+`,
  'g',
);

/**
 * Dead-terminology tokens (dir/command form, unambiguous) that must never
 * reappear in a steering file. Mirrors tests/invariants/_constants.ts
 * DEAD_TERMINOLOGY_TOKENS; active-path-hygiene already guards root CLAUDE.md
 * + .claude/README.md — this extends the same guard to NESTED CLAUDE.md files.
 */
const DEAD_TOKENS = [
  'agents-enterprise-v2',
  'npx claude-agent',
  'tools/scripts/orchestrator-runner',
] as const;

function lineCount(content: string): number {
  return content.replace(/\n+$/, '').split('\n').length;
}

/** Concrete, checkable repo paths cited in a steering file. */
function extractCheckablePaths(content: string): string[] {
  const out = new Set<string>();
  for (const match of content.match(PATH_RX) ?? []) {
    const cleaned = match.replace(/[)`.,;:]+$/g, '');
    // Skip globs, brace-sets, angle/variable placeholders, and ellipses.
    if (/[*{}<>$]/.test(cleaned) || cleaned.includes('...') || cleaned.includes('…')) {
      continue;
    }
    out.add(cleaned);
  }
  return [...out];
}

const steeringFiles = discoverSteeringFiles(REPO_ROOT);
const nestedFiles = steeringFiles.filter((f) => f !== 'CLAUDE.md' && f !== 'AGENTS.md');

describe('CLAUDE.md accuracy invariants', () => {
  it('discovers the root steering files', () => {
    expect(steeringFiles).toContain('CLAUDE.md');
    expect(steeringFiles).toContain('AGENTS.md');
  });

  describe('every cited repo path exists', () => {
    for (const file of steeringFiles) {
      it(`${file}: all concrete cited paths resolve on disk`, () => {
        const content = readFileSync(join(REPO_ROOT, file), 'utf8');
        const missing = extractCheckablePaths(content).filter(
          (p) => !existsSync(join(REPO_ROOT, p)),
        );
        if (missing.length > 0) {
          throw new Error(
            `${file} cites paths that do not exist: ${missing.join(', ')}. ` +
              `Fix the reference or skip it (globs/placeholders are ignored).`,
          );
        }
      });
    }
  });

  describe('every cited enforcement spec is executed by a CI lane', () => {
    // A steering file that says "enforced by <spec>" is making a claim about
    // CI, not about the filesystem. CLAUDE.md cited
    // apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts
    // (a target no workflow invoked) and e2e/tests/integration/
    // schema-invariants.spec.ts (a script no job ran) for months; both paths
    // resolved on disk, so the check above was green. This one asks the
    // question the reader asks: does anything actually run it on a PR?
    const scriptsRunByWorkflows = new Set(workflowScriptReferences().map((ref) => ref.script));
    // A citation may name a spec CI does not run only while the same line
    // names the OPEN finding that tracks the gap — the repository's one
    // sanctioned shape for debt (owner + deadline + id live on the finding).
    const openFindingIds = new Set(
      readFileSync(join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { id: string; state: string })
        .filter(
          (row) => row.state === 'OPEN' || row.state === 'IN-PROGRESS' || row.state === 'BLOCKED',
        )
        .map((row) => row.id),
    );
    const FINDING_ID_RX = /\b[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}\b/g;
    const testQuarantine = new Set(
      Object.keys(
        (
          JSON.parse(
            readFileSync(join(REPO_ROOT, 'scripts/ci/affected-target-policy.json'), 'utf8'),
          ) as { targets: { test: { knownUnstableProjects: Record<string, unknown> } } }
        ).targets.test.knownUnstableProjects,
      ),
    );

    function whyNotGated(spec: string): string | undefined {
      if (isKnownUnrunnable(spec)) return 'listed as unrunnable';
      const runners = runnersOf(spec);
      if (runners.length === 0) return 'no runner claims it';
      const reasons: string[] = [];
      for (const runner of runners) {
        switch (runner.kind) {
          case 'script':
          case 'declared-non-nx':
            if (scriptsRunByWorkflows.has(runner.script)) return undefined;
            reasons.push(`script ${runner.script} is invoked by no workflow`);
            break;
          case 'workflow':
            return undefined;
          case 'nx-test':
            if (!testQuarantine.has(runner.project)) return undefined;
            reasons.push(`project ${runner.project} is quarantined in the affected test lane`);
            break;
          case 'blanket':
            reasons.push(`only blanket-owned by ${runner.owner}; no script or workflow names it`);
            break;
        }
      }
      return reasons.join('; ');
    }

    for (const file of steeringFiles) {
      it(`${file}: every cited spec is gated, or its gap is tracked on the same line`, () => {
        const ungated: string[] = [];
        for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
          const specs = extractCheckablePaths(line).filter((p) => /\.spec\.tsx?$/.test(p));
          if (specs.length === 0) continue;
          const tracked = [...line.matchAll(FINDING_ID_RX)].some((m) => openFindingIds.has(m[0]));
          for (const spec of specs) {
            const why = whyNotGated(spec);
            if (why !== undefined && !tracked) ungated.push(`${spec}: ${why}`);
          }
        }
        expect(ungated).toEqual([]);
      });
    }
  });

  describe('line budgets', () => {
    it('root CLAUDE.md is <= 200 lines', () => {
      const n = lineCount(readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8'));
      expect(n).toBeLessThanOrEqual(200);
    });

    it('each nested CLAUDE.md is <= 80 lines', () => {
      for (const f of nestedFiles) {
        const n = lineCount(readFileSync(join(REPO_ROOT, f), 'utf8'));
        if (n > 80) {
          throw new Error(`${f} is ${n} lines (nested budget is 80).`);
        }
      }
    });
  });

  describe('nested-file hygiene', () => {
    it('each nested CLAUDE.md carries a prose inheritance note (not an @import of root)', () => {
      for (const f of nestedFiles) {
        const content = readFileSync(join(REPO_ROOT, f), 'utf8');
        if (!/Root rules in `?\/?CLAUDE\.md`?/.test(content)) {
          throw new Error(
            `${f} is missing the inheritance note ("Root rules in /CLAUDE.md already apply").`,
          );
        }
        if (/@(\.\.\/)+CLAUDE\.md/.test(content)) {
          throw new Error(
            `${f} @-imports root CLAUDE.md — root is always loaded, so this double-loads it. ` +
              `Use a plain prose inheritance note instead.`,
          );
        }
      }
    });

    it('no steering file resurrects a dead-terminology token', () => {
      for (const f of steeringFiles) {
        const content = readFileSync(join(REPO_ROOT, f), 'utf8');
        for (const token of DEAD_TOKENS) {
          if (content.includes(token)) {
            throw new Error(`${f} contains dead-terminology token "${token}".`);
          }
        }
      }
    });
  });
});
