/**
 * Agent Size-Limit Invariant
 * ============================================================================
 *
 * Closes Phase 6a of /root/.claude/plans/synthetic-dazzling-hippo.md
 * (finding CLAUDE-MEDIUM-003).
 *
 * .claude/agents-enterprise-v2/_shared/_conversion-template.md declares:
 *
 *   > Hard size cap: ≤200 lines total (including frontmatter + blank lines).
 *
 * The cap exists to keep agent prompts within a single-screen review surface
 * and to force SSoT-discipline (reference the knowledge layer, don't inline
 * it). The Lane-B (test-agents) roster was above the cap pre-Phase-5 —
 * soc2-readiness-auditor.md was 271 lines. Phase 5 ports every Lane-B file
 * into the canonical template and brings them under the cap, at which point
 * this spec's scope expands to include them.
 *
 * Current scope (Phase 6a landing):
 *   - .claude/agents-enterprise-v2/*.md  (max currently 197 lines)
 *
 * Phase 5 expansion:
 *   - adds .claude/test-agents/*.md once every Lane-B file has been ported.
 *
 * # When this spec fails
 *
 *   - An agent file grew past 200 lines → either (a) push content into the
 *     canonical SSoT (layer-1-*.md, layer-2-patterns.md, layer-3-adrs.md)
 *     and reference via the Canonical References section, or (b) create a
 *     domain-specific shard under _shared/ and reference from the agent.
 *     Do NOT split an agent in half — cohesion is load-bearing.
 *
 * # References
 *
 *   - /root/.claude/plans/synthetic-dazzling-hippo.md#Phase-6a
 *   - .claude/agents-enterprise-v2/_shared/_conversion-template.md § "Conversion rules (for prompt-writer)"
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAX_LINES = 200;

interface ScopedDir {
  readonly label: string;
  readonly path: string;
  readonly exempt: readonly string[];
}

/**
 * Test-agents scope added 2026-04-18 after the Phase 5 Lane-B template
 * port. Every Lane-B auditor now carries a Canonical References section
 * and comes in under the cap; exemptions cover:
 *   - README.md, INVOCATION-PACK.md (non-agent operational docs)
 *   - orchestrator.md (meta-agent, carries the full two-lane dispatch
 *     decision tree inline — cap relaxation scheduled for a later
 *     template-port cycle)
 *   - 4 DEPRECATED files that retain original content for historical
 *     review-file traceability, scheduled for deletion 2026-07-16.
 */
const SCOPED_DIRS: readonly ScopedDir[] = [
  {
    label: 'agents-enterprise-v2',
    path: path.join(REPO_ROOT, '.claude', 'agents-enterprise-v2'),
    exempt: ['README.md'],
  },
  {
    label: 'test-agents',
    path: path.join(REPO_ROOT, '.claude', 'test-agents'),
    exempt: [
      'README.md',
      'INVOCATION-PACK.md',
      // Meta-agent — inline dispatch decision tree. Separate port cycle.
      'orchestrator.md',
      // DEPRECATED 2026-04-16 — historical content retained for review-file
      // traceability; scheduled for deletion 2026-07-16.
      'gdpr-compliance-auditor.md',
      'soc2-readiness-auditor.md',
      'ai-tool-execution-auditor.md',
      'contract-parity-auditor.md',
    ],
  },
];

function walkAgentFiles(dir: ScopedDir): { name: string; full: string; lines: number }[] {
  if (!fs.existsSync(dir.path)) return [];
  return fs
    .readdirSync(dir.path)
    .filter((f) => f.endsWith('.md') && !dir.exempt.includes(f))
    .map((f) => {
      const full = path.join(dir.path, f);
      const content = fs.readFileSync(full, 'utf8');
      // Count lines including trailing blank — matches `wc -l` semantics.
      const lines = content.split('\n').length - 1;
      return { name: f, full: path.relative(REPO_ROOT, full), lines };
    });
}

describe('agent size-limit invariant (≤200 lines per _conversion-template.md)', () => {
  for (const dir of SCOPED_DIRS) {
    describe(dir.label, () => {
      const files = walkAgentFiles(dir);

      it('scope is non-empty (otherwise this invariant is a no-op regression)', () => {
        expect(files.length).toBeGreaterThan(0);
      });

      it(`every agent file is ≤ ${MAX_LINES} lines`, () => {
        const oversized = files.filter((f) => f.lines > MAX_LINES);
        if (oversized.length > 0) {
          const listing = oversized
            .map((f) => `  ${f.full} — ${f.lines} lines (limit ${MAX_LINES})`)
            .join('\n');
          const hint =
            'Push duplicated SSoT content into .claude/knowledge/layer-*.md or a new ' +
            '_shared/<topic>.md shard, then reference via the Canonical References section. ' +
            'Do not split the agent in half — cohesion is load-bearing.';
          throw new Error(`Agent files over size cap:\n${listing}\n\n${hint}`);
        }
        expect(oversized).toEqual([]);
      });
    });
  }
});
