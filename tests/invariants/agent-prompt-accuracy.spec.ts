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
 *   No brittle exact counts — an agent body must not hardcode a multi-digit
 *   "N modules/files/events/tables" claim. Use "~N" or an SSoT pointer (e.g.
 *   MODULE_SCHEMAS) instead. Rates (`events/s`) and ADR numbers
 *   (`ADR-006 ... events`) are NOT counts and are excluded by design.
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
 *   - Defect-catalog-reference coverage: the 2026-06 audit wired
 *     `layer-2-defect-catalog.md` into the ~15 domain + cross-cutting CATCHERs
 *     it upgraded; roster-wide coverage (Lane-B product-auditors, edge-docs
 *     writers, remaining cross-cutting auditors) is the rolling scope of
 *     AGENT-PROMPT-006 (docs/reviews/2026-06-16-agent-prompt-audit/ROLLUP.md),
 *     not yet complete — asserting it now would be red.
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
});
