/**
 * Agent-Prompt Accuracy Invariants
 * ============================================================================
 *
 * The `.claude/agents/**` prompt corpus STEERS every review the platform runs.
 * A brittle hardcoded count silently mis-directs the agent that reads it: the
 * 2026-06 agent-prompt audit found stale module/file/event/table counts in a
 * dozen prompts (sensor "~357 files", farm "28 modules", admin "232 files",
 * data "18 events", database-reviewer "67+ tables"). They drift the instant the
 * codebase changes. This spec makes that drift class DETECTABLE at CI time —
 * the repo's own Tier-3 principle applied to its own agent-steering layer.
 *
 * ASSERTS (the unowned gap — no other invariant owns it):
 *   1. No brittle exact counts — an agent body must not hardcode a multi-digit
 *      "N modules/files/events/tables" claim. Use "~N" or an SSoT pointer (e.g.
 *      MODULE_SCHEMAS) instead. Rates (`events/s`) and ADR numbers
 *      (`ADR-006 ... events`) are NOT counts and are excluded by design.
 *   2. Defect-catalog coverage (AGENT-PROMPT-006) — every code-review CATCHER
 *      that consumes the layer-2 knowledge SSoT (`layer-2-patterns.md`) MUST
 *      also consume `layer-2-defect-catalog.md`, so the generic real-defect
 *      classes are hunted everywhere. Exempt (NOT code-defect hunters):
 *      `_maintenance/*` WRITERs/tooling; meta/compaction (context-manager x2);
 *      doc producers (edge-docs writers); the process-meta auditor
 *      (root-cause-auditor verifies tier-claims, not code).
 *
 * Does NOT duplicate: agent-frontmatter-schema (frontmatter), agent-size-limit
 * (<=200 lines), agent-ownership-uniqueness / agent-name-uniqueness,
 * orchestrator-routing-coverage (glob<->routing parity), knowledge-ssot
 * (`@.claude/knowledge/*` refs).
 *
 * INTENTIONALLY DEFERRED — documented debt, not silently dropped:
 *   - Path-existence of cited repo paths. The agent corpus LEGITIMATELY cites
 *     paths that do not pre-exist: review/recommendation OUTPUT dirs the agent
 *     creates (`docs/reviews/<agent>/`, `docs/recommendations/<agent>/`), the
 *     docs the edge-docs writers PRODUCE (`docs/api/*.md`, `docs/architecture/
 *     *.md`, ...), runtime artifacts (`tools/audit/*.jsonl`), illustrative
 *     example paths (ARIA agents reasoning over hypothetical diffs), and
 *     to-author files. A sound path-existence guard needs an output-aware
 *     allowlist design — follow-on work, not forced-red here. (The genuine
 *     code-path drifts surfaced while designing this guard —
 *     billing-expert's decimal-transformer ref + implementation-planner's
 *     `libs/outbox` — were fixed in the same PR.)
 *   - 9-section template completeness: agent structures legitimately VARY
 *     across Lane-A experts / Lane-B auditors / edge-docs writers / ARIA
 *     agents; a uniform-section assertion is not green-able roster-wide.
 *
 * Worktree copies (.worktrees/, .codex-worktrees/, .claude/worktrees/) are
 * byte-identical checkouts of other branches and are excluded.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const EXCLUDED_DIR_RX =
  /(^|\/)(\.worktrees|\.codex-worktrees|\.claude\/worktrees|node_modules)\//;

// Brittle hardcoded structural count. Direct adjacency (no intervening word)
// keeps false-positives out: `(?<![~\-\d.])` rejects tilde-prefixed (`~50`),
// ADR numbers (`ADR-006`), decimals, and mid-number splits; `(?!\/)` rejects
// rates (`1000+ events/s`). Catches the canonical drift form: `232 files`,
// `67+ tables`, `8 modules`, `18 events`.
const BRITTLE_COUNT_RX =
  /(?<![~\-\d.])\d{2,}\+?\s+(modules|files|events|tables)\b(?!\/)/gi;

// AGENT-PROMPT-006: code-review CATCHERs that consume the layer-2 knowledge
// SSoT must also consume the defect-catalog SSoT. These agents reference
// layer-2-patterns but are NOT code-defect hunters, so they are exempt —
// meta/compaction, an edge-docs doc producer, and the process-meta auditor.
const DEFECT_CATALOG_EXEMPT = new Set<string>([
  '.claude/agents/context-manager.md',
  '.claude/agents/product-audit/context-manager.md',
  '.claude/agents/edge-docs/architecture-writer.md',
  '.claude/agents/root-cause-auditor.md',
  // architectural-arbiter reviews REVIEWS for cross-agent coherence, not source
  // code for defects ("you do not review code for defects; you review REVIEWS").
  // It consumes layer-2-patterns as the invariant set it arbitrates conflicting
  // recommendations against — same process-meta posture as root-cause-auditor,
  // which is already exempt. It is not a code-defect CATCHER.
  '.claude/agents/architectural-arbiter.md',
  // test-runner is a test-health quality gate (REVIEWER+Bash) that consumes
  // layer-2-patterns as the patterns its mock-boundary + tenant-coverage rules
  // assert against; it reviews TEST quality, not source for generic defect
  // classes. Domain code-defect hunting routes to the owning expert per its
  // Cross-Domain Dependencies. Not a code-defect CATCHER.
  '.claude/agents/test-runner.md',
]);

function gitList(cmd: string): string[] {
  try {
    return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Every agent prompt file (frontmatter-bearing `.md` under .claude/agents/). */
function discoverAgentFiles(): string[] {
  const all = [
    ...gitList('git ls-files .claude/agents'),
    ...gitList('git ls-files --others --exclude-standard .claude/agents'),
  ];
  return [...new Set(all)]
    .filter((f) => f.endsWith('.md') && !EXCLUDED_DIR_RX.test(f))
    .filter((f) => {
      const content = readFileSync(join(REPO_ROOT, f), 'utf8');
      // Agent files open with a YAML frontmatter block carrying a `name:` key.
      // Grab the block between the first `---` and the next `---`, then test
      // for a `name:` line with the `m` flag (handles `name:` as the FIRST
      // frontmatter field). Excludes README.md and other non-agent markdown.
      if (!content.startsWith('---')) return false;
      const frontmatter = content.slice(3).split(/\n---/)[0] ?? '';
      return /^name:\s*\S/m.test(frontmatter);
    });
}

const agentFiles = discoverAgentFiles();

describe('agent-prompt accuracy invariants', () => {
  it('discovers the agent prompt corpus', () => {
    // Sanity floor — the roster is dozens of agents across Lane-A/Lane-B/
    // _maintenance/edge-docs. If this collapses, discovery broke.
    expect(agentFiles.length).toBeGreaterThan(40);
    expect(agentFiles).toContain('.claude/agents/farm-expert.md');
  });

  describe('no brittle hardcoded structural counts', () => {
    for (const file of agentFiles) {
      it(`${file}: no hardcoded "N modules/files/events/tables"`, () => {
        const content = readFileSync(join(REPO_ROOT, file), 'utf8');
        const hits = content.match(BRITTLE_COUNT_RX) ?? [];
        if (hits.length > 0) {
          throw new Error(
            `${file} hardcodes brittle count(s): ${[...new Set(hits)].join(', ')}. ` +
              `These drift the moment the codebase changes — use "~N" or point at ` +
              `the SSoT (e.g. MODULE_SCHEMAS) instead.`,
          );
        }
      });
    }
  });

  describe('defect-catalog coverage for code-review CATCHERs (AGENT-PROMPT-006)', () => {
    for (const file of agentFiles) {
      if (file.includes('/_maintenance/')) continue; // WRITERs/tooling, not CATCHERs
      if (DEFECT_CATALOG_EXEMPT.has(file)) continue;
      const content = readFileSync(join(REPO_ROOT, file), 'utf8');
      // Only agents that opt into the layer-2 knowledge SSoT are in scope.
      if (!content.includes('layer-2-patterns')) continue;
      it(`${file}: a layer-2-patterns consumer also references layer-2-defect-catalog`, () => {
        expect(content).toContain('layer-2-defect-catalog');
      });
    }
  });
});
