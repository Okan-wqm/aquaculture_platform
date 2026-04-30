/**
 * CLAUDE-LOW-005 + CLAUDE-LOW-007 + CLAUDE-LOW-008 invariants:
 * lock-down for doc-shape regressions in the agent system that
 * have already been cured in-repo but lacked a structural seal.
 *
 * Each finding's underlying state was fixed in earlier commits
 * but the absence of a regression-catching test left the cure
 * brittle: a future agent-system refactor could silently
 * un-fix any of the three. This invariant is the architectural
 * seal (Tier-3 — make detectable).
 *
 * # CLAUDE-LOW-005 — mcp-expert finding-ID prefix carries MCP-
 *
 * The mcp-expert agent's finding-ID example MUST use the
 * MCP-{severity}-{NNN} namespace, not bare {severity}-{NNN}.
 * Bare format collides with the test-runner agent's
 * deliberately-bare prefix and breaks `Closes:` traceability
 * because the registry's id pattern requires a domain prefix.
 *
 * # CLAUDE-LOW-007 — cardinality literals wrapped
 *
 * Numeric prose counts in shared phases + product-audit README
 * MUST be wrapped in `<!-- cardinality:NAME -->NN<!-- /cardinality -->`
 * markers. The existing doc-cardinality.spec.ts gate enforces
 * marker-vs-truth match; this invariant pins that the markers
 * EXIST around the two specific literals the audit flagged.
 *
 * # CLAUDE-LOW-008 — three-store-invariants in invariant-gates table
 *
 * `.claude/README.md`'s "Invariant gates" table MUST list
 * `three-store-invariants.spec.ts`. Without the listing, an
 * operator reading the doc cannot discover the cross-store
 * traceability gate exists; agents reading the doc miss the
 * dependency.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf8',
}).trim();

function read(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

describe('agent-doc-shape (CLAUDE-LOW-005/007/008 seals)', () => {
  describe('CLAUDE-LOW-005 — mcp-expert finding-ID example uses MCP- prefix', () => {
    const file = '.claude/agents/mcp-expert.md';

    it('declares finding-ID format with the MCP- namespace', () => {
      const body = read(file);
      // The format declaration line MUST contain `MCP-{severity}-{NNN}`.
      const formatLine = body
        .split('\n')
        .find((line) => /Report finding ID format/.test(line));
      expect(formatLine).toBeDefined();
      expect(formatLine).toMatch(/MCP-\{severity\}-\{NNN\}/);
    });

    it('illustrates MCP-CRITICAL-001 / MCP-HIGH-007 / MCP-MEDIUM-023 examples', () => {
      const body = read(file);
      // Pin the three specific examples used in the format declaration.
      // A future doc rewrite that drops the namespace from any of these
      // re-introduces the CLAUDE-LOW-005 bug.
      expect(body).toMatch(/MCP-CRITICAL-001/);
      expect(body).toMatch(/MCP-HIGH-007/);
      expect(body).toMatch(/MCP-MEDIUM-023/);
    });
  });

  describe('CLAUDE-LOW-007 — prose cardinality literals are marker-wrapped', () => {
    it('wraps the lane-B-specialists count in orchestrator-phases.md', () => {
      const body = read('.claude/shared/orchestrator-phases.md');
      // The "19 UI/product specialists" literal MUST be enclosed in
      // a cardinality:lane-b-specialists marker so doc-cardinality
      // can keep it in sync with the real roster.
      expect(body).toMatch(
        /<!--\s*cardinality:lane-b-specialists\s*-->\d+<!--\s*\/cardinality\s*-->\s*UI\/product specialists/,
      );
    });

    it('wraps the lane-B-active-agents count in product-audit/README.md', () => {
      const body = read('.claude/agents/product-audit/README.md');
      expect(body).toMatch(
        /<!--\s*cardinality:lane-b-active-agents\s*-->\d+<!--\s*\/cardinality\s*-->\s*agents/,
      );
    });
  });

  describe('CLAUDE-LOW-008 — three-store-invariants listed in invariant-gates table', () => {
    it('lists three-store-invariants.spec.ts in .claude/README.md', () => {
      const body = read('.claude/README.md');
      // The invariant-gates table row format is `| spec.ts | description |`.
      expect(body).toMatch(/\|\s*`three-store-invariants\.spec\.ts`\s*\|/);
    });
  });

  describe('CLAUDE-LOW-004 — tenant-cost-attribution agent uses -expert suffix', () => {
    it('the agent file is named tenant-cost-attribution-expert.md (not -agent.md)', () => {
      // The repo MUST carry the -expert variant; the legacy -agent name
      // would re-introduce the audit's "naming convention drift" finding.
      const lines = execSync(
        `git ls-files .claude/agents/tenant-cost-attribution-*.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      expect(lines).toContain(
        '.claude/agents/tenant-cost-attribution-expert.md',
      );
      expect(lines).not.toContain(
        '.claude/agents/tenant-cost-attribution-agent.md',
      );
    });
  });

  describe('CLAUDE-LOW-006 — product-audit arbiter filename matches frontmatter', () => {
    it('the arbiter file is named product-audit-arbiter.md (not architectural-arbiter.md)', () => {
      const lines = execSync(
        `git ls-files .claude/agents/product-audit/*arbiter*.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      expect(lines).toContain(
        '.claude/agents/product-audit/product-audit-arbiter.md',
      );
      // Legacy filename must NOT exist; if it did, two arbiter agents
      // with overlapping responsibility would coexist and routing would
      // become ambiguous.
      expect(lines).not.toContain(
        '.claude/agents/product-audit/architectural-arbiter.md',
      );
    });
  });
});
