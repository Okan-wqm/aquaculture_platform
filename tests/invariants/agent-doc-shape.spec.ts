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

  describe('CLAUDE-MEDIUM-006 — settings.json declares PreToolUse Agent dispatch gate', () => {
    it('hooks block carries a PreToolUse entry running the dispatch gate', () => {
      const body = read('.claude/settings.json');
      expect(body).toMatch(/"PreToolUse"/);
      expect(body).toMatch(/agent-dispatch-gate\.ts/);
    });
  });

  describe('CLAUDE-MEDIUM-007 — .claude/worktrees + dispatch-log gitignored', () => {
    it('.gitignore contains both entries', () => {
      const body = read('.gitignore');
      expect(body).toMatch(/^\.claude\/worktrees\/$/m);
      expect(body).toMatch(/^\.claude\/agents\/\.dispatch-log\.jsonl$/m);
    });
  });

  describe('CLAUDE-MEDIUM-008 — agents.legacy README carries DO-NOT-READ warning', () => {
    it('README.md opens with the archived/do-not-read blockquote', () => {
      const body = read('.claude/agents.legacy/README.md');
      // First 200 chars must mention the legacy/archived warning so a
      // reader (or agent) opening the file can't miss it.
      const head = body.slice(0, 200);
      expect(head).toMatch(/ARCHIVED|DO NOT READ|DO-NOT-READ/i);
    });
  });

  describe('CLAUDE-MEDIUM-009 — Phase 4.5 root-cause-auditor MUST-dispatch clause', () => {
    it('orchestrator-phases.md carries the mechanical trigger clause', () => {
      const body = read('.claude/shared/orchestrator-phases.md');
      // The CLAUDE-MEDIUM-009 cure: the phase document must declare an
      // unambiguous MUST-dispatch trigger anchored on (a) tier-claim
      // presence, OR (b) prior-cycle arbiter IN-PROGRESS transition.
      expect(body).toMatch(
        /Mechanical trigger.*CLAUDE-MEDIUM-009.*Orchestrator MUST dispatch.*root-cause-auditor/s,
      );
    });
  });

  describe('CLAUDE-MEDIUM-010 — build-validator agent exists', () => {
    it('the build-validator agent file is committed', () => {
      const lines = execSync(`git ls-files .claude/agents/build-validator.md`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      expect(lines).toContain('.claude/agents/build-validator.md');
    });
  });

  describe('CLAUDE-MEDIUM-011 — .full-review state-file dir is gitignored', () => {
    it('.gitignore contains the .full-review/ entry', () => {
      const body = read('.gitignore');
      expect(body).toMatch(/^\.full-review\/$/m);
    });
  });

  describe('CLAUDE-HIGH-005 — product-audit orchestrator is split into shared phases + routing', () => {
    it('the two shared files exist', () => {
      const lines = execSync(
        `git ls-files .claude/shared/product-audit-orchestrator-*.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      expect(lines).toContain(
        '.claude/shared/product-audit-orchestrator-phases.md',
      );
      expect(lines).toContain(
        '.claude/shared/product-audit-orchestrator-routing.md',
      );
    });

    it('main product-audit/orchestrator.md is at or under the 200-line cap', () => {
      const body = read('.claude/agents/product-audit/orchestrator.md');
      const lineCount = body.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(200);
    });
  });

  describe('CLAUDE-HIGH-006 — messaging-expert description scopes ai-service as delegated', () => {
    it('description carries the "delegated from ai-safety-auditor" disambiguation', () => {
      const body = read('.claude/agents/messaging-expert.md');
      // The description must clarify ai-service is owned by
      // ai-safety-auditor primary; messaging-expert is the secondary
      // reviewer on the chat-persistence slice. Without the
      // disambiguation, two agents claim the same surface and routing
      // conflicts re-emerge.
      expect(body).toMatch(/ai-safety-auditor/);
      expect(body).toMatch(/delegated from ai-safety-auditor/);
    });
  });

  describe('CLAUDE-HIGH-007 — routing-table glob-uniqueness invariant exists', () => {
    it('agent-ownership-uniqueness.spec.ts declares the glob-uniqueness describe block', () => {
      const body = read('tests/invariants/agent-ownership-uniqueness.spec.ts');
      expect(body).toMatch(/CLAUDE-HIGH-007/);
      expect(body).toMatch(/routing-table glob-uniqueness/);
    });
  });

  describe('CLAUDE-HIGH-008 — orchestrator-routing-coverage carries reverse-roster check', () => {
    it('orchestrator-routing-coverage.spec.ts declares the CLAUDE-HIGH-008 seal', () => {
      const body = read('tests/invariants/orchestrator-routing-coverage.spec.ts');
      expect(body).toMatch(/CLAUDE-HIGH-008/);
    });
  });

  describe('CLAUDE-HIGH-009 — agent-size-limit covers Lane-B (product-audit/)', () => {
    it('agent-size-limit.spec.ts scans the product-audit subdirectory', () => {
      const body = read('tests/invariants/agent-size-limit.spec.ts');
      // Must reference the product-audit path so Lane-B files are
      // bound to the same 200-line cap as Lane-A.
      expect(body).toMatch(/product-audit/);
      expect(body).toMatch(/Lane-B/);
    });
  });

  describe('CLAUDE-HIGH-010 — Lane-B output paths renamed to docs/product-audits', () => {
    it('docs/product-audits/ exists and docs/test-audits/ does not', () => {
      const lsAudits = execSync(`git ls-files docs/product-audits/ | head -1`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      // At least one entry under docs/product-audits/ confirms the rename landed.
      expect(lsAudits.length).toBeGreaterThan(0);
      const lsLegacy = execSync(`git ls-files docs/test-audits/`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim();
      expect(lsLegacy).toBe('');
    });
  });

  describe('CLAUDE-HIGH-011 — INVOCATION-PACK moved to docs/runbooks', () => {
    it('docs/runbooks/product-audit-invocation.md exists; legacy auto-discovery copy does not', () => {
      const newPath = execSync(
        `git ls-files docs/runbooks/product-audit-invocation*.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ).trim();
      expect(newPath).toContain('docs/runbooks/product-audit-invocation.md');
      const oldPath = execSync(
        `git ls-files .claude/agents/product-audit/INVOCATION-PACK.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ).trim();
      expect(oldPath).toBe('');
    });
  });

  describe('CLAUDE-HIGH-012 — maintenance agents isolated under _maintenance/', () => {
    it('the _maintenance subdir contains the three maintenance agents', () => {
      const lines = execSync(
        `git ls-files .claude/agents/_maintenance/*.md`,
        { cwd: REPO_ROOT, encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
      const expected = [
        '.claude/agents/_maintenance/prompt-writer.md',
        '.claude/agents/_maintenance/implementation-planner.md',
        '.claude/agents/_maintenance/gdpr-erasure-executor.md',
      ];
      for (const path of expected) {
        expect(lines).toContain(path);
      }
    });

    it('the maintenance-isolation invariant exists and is registered', () => {
      const cfg = read('tests/invariants/jest.config.ts');
      expect(cfg).toMatch(/maintenance-isolation\.spec\.ts/);
    });
  });
});
