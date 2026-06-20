/**
 * Active-Path Hygiene Invariant
 * ============================================================================
 *
 * Merged cross-reference integrity + legacy terminology ban spec.
 * Landed as Phase 1 of /root/.claude/plans/parallel-jumping-ladybug.md
 * after the 2026-04-18 ruthless-audit cycle.
 *
 * This spec closes two blind spots that no prior invariant caught:
 *
 *   1. **Dead agent dispatch refs.** A backtick-wrapped agent name in an
 *      active Lane-A / Lane-B / shared / skills body that does not resolve
 *      to a real `name:` frontmatter. Example: `contract-parity-auditor`
 *      was promoted to Lane-A `contract-parity-enforcer` and the old file
 *      moved to `agents.legacy/product-audit/`, but 7 active files kept
 *      routing to it — Claude Code CLI `Agent(subagent_type=...)` fails at
 *      dispatch time.
 *
 *   2. **Pre-flatten / pre-CLI terminology leaks.** Tokens like
 *      `test-agents`, `agents-enterprise-v2`, `npx claude-agent`,
 *      `orchestrator-runner` describe folders / binaries retired on
 *      2026-04-18 (flatten commit 2582592e + runner delete e8f06e98).
 *      They survive only in historical/archival paths — any re-appearance
 *      in active docs is drift.
 *
 *   3. **Invalid CLI model enum.** Claude Code sub-agents docs restrict
 *      `model:` frontmatter to `opus|sonnet|haiku`. `model: codex` (Lane-B
 *      audit artifact) caused silent fallback. 17 files fixed on 2026-04-18.
 *
 * # When this spec fails
 *
 *   - A Lane-A / Lane-B body cites an agent name that no longer exists:
 *     update the reference OR restore the agent file. The audit report that
 *     flagged the rename will say which.
 *   - A dead terminology token re-appeared in an active doc: rewrite to
 *     use the current terminology (e.g., "Lane-B product-audit" not
 *     "test-agents"; Claude Code Agent() not `npx claude-agent`).
 *   - An agent file declared `model: codex`: change to `model: opus` per
 *     orchestrator.md platform policy.
 *
 * # References
 *
 *   - /root/.claude/plans/parallel-jumping-ladybug.md#Faz-1
 *   - .claude/shared/handoff-protocol.md § Cross-domain handoff rules
 *   - .claude/agents.legacy/README.md (dormancy declaration — EXEMPT)
 *   - Commits: 2582592e (flatten), e8f06e98 (runner delete)
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  ACTIVE_HYGIENE_PATHS,
  ACTIVE_HYGIENE_ROOT_FILES,
  DEAD_TERMINOLOGY_TOKENS,
  DYNAMIC_AGENT_PLACEHOLDERS,
  NON_AGENT_FILES,
} from './_constants';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// File enumeration
// ---------------------------------------------------------------------------

function walkMdFiles(dirRel: string): string[] {
  const abs = path.join(REPO_ROOT, dirRel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return abs.endsWith('.md') ? [abs] : [];

  const files: string[] = [];
  const visit = (dirAbs: string): void => {
    const entries = fs
      .readdirSync(dirAbs, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        visit(childAbs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(childAbs);
      }
    }
  };
  visit(abs);
  return files;
}

function listActiveFiles(): string[] {
  const files: string[] = [];
  for (const dir of ACTIVE_HYGIENE_PATHS) {
    files.push(...walkMdFiles(dir));
  }
  for (const rootFile of ACTIVE_HYGIENE_ROOT_FILES) {
    const abs = path.join(REPO_ROOT, rootFile);
    if (fs.existsSync(abs)) files.push(abs);
  }
  return [...new Set(files)].sort();
}

// ---------------------------------------------------------------------------
// Cross-reference integrity — extract real agent `name:` values
// ---------------------------------------------------------------------------

function extractFrontmatterName(content: string): string | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const [, block] = m;
  if (!block) return null;
  const nameLine = block.split('\n').find((l) => /^name:\s*/.test(l));
  if (!nameLine) return null;
  return nameLine.replace(/^name:\s*/, '').trim();
}

function collectActiveAgentNames(): Set<string> {
  const names = new Set<string>();
  // All auto-discovered .claude/agents/** subdirectories participate in
  // the name registry — runtime roster (root), Lane-B specialists
  // (product-audit/), and maintenance tooling (_maintenance/). The
  // maintenance-isolation invariant separately enforces that
  // _maintenance agents are out of the runtime roster table; their
  // names still need to resolve as valid cross-references when cited
  // from active agent bodies (e.g., orchestrator.md Auxiliary
  // Maintenance Tooling section).
  const agentDirs = [
    '.claude/agents',
    '.claude/agents/product-audit',
    '.claude/agents/_maintenance',
    '.claude/agents/edge-docs',
  ];
  for (const dir of agentDirs) {
    for (const file of walkMdFiles(dir)) {
      const base = path.basename(file);
      if (NON_AGENT_FILES.some((n) => n === base)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const name = extractFrontmatterName(content);
      if (name !== null) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Agent-name-shaped token extraction from backtick-wrapped body content
// ---------------------------------------------------------------------------

/**
 * Match tokens that LOOK like an agent dispatch reference:
 *   - wrapped in backticks
 *   - kebab-case
 *   - end in a known agent suffix pattern OR match a specific known-name
 *
 * We use a name-suffix whitelist to avoid flagging every generic term
 * (e.g., `file-path`, `line-number` which could be false positives).
 */
const AGENT_NAME_SUFFIX_RE =
  /^(?:[a-z][a-z0-9]+-)+(?:expert|auditor|reviewer|executor|manager|arbiter|enforcer|planner|writer|mapper|agent|orchestrator)$/;

/**
 * Names that appear in agent body prose AS backtick tokens but are
 * NOT dispatch targets (domain-term allowlist). Expand as needed.
 *
 * NOTE — deprecated agent names (`contract-parity-auditor`,
 * `gdpr-compliance-auditor`, `soc2-readiness-auditor`,
 * `ai-tool-execution-auditor`) are NOT in this allowlist: they MUST
 * resolve to a current name OR appear in a HISTORICAL-citation line
 * (promoted to / absorbed into / superseded by). Untagged references
 * are dead dispatch and fail the cross-reference check.
 */
const NON_DISPATCH_TOKEN_ALLOWLIST = new Set<string>([
  // Skill references use same kebab-case shape — enumerate the 7 active skills
  'add-entity-field',
  'change-event-contract',
  'add-shared-table',
  'add-rls-policy',
  'provision-tenant',
  'pre-migration-restore-test',
  'run-migration-prod',
  // Domain terms sometimes appear as backtick tokens
  'aquaculture-engines',
  'backend-common',
  'event-contracts',
  'tenant-admin',
  'admin-panel',
  'sens-api-gateway',
]);

function extractBacktickAgentTokens(content: string): string[] {
  const matches = content.matchAll(/`([a-z][a-z0-9-]+)`/g);
  const tokens: string[] = [];
  for (const m of matches) {
    const [, tok] = m;
    if (!tok) continue;
    if (AGENT_NAME_SUFFIX_RE.test(tok)) tokens.push(tok);
  }
  return tokens;
}

/**
 * Line patterns that are HISTORICAL citations / retirement announcements.
 * Lines matching any of these are exempt from both cross-reference and
 * legacy-terminology checks — they legitimately mention retired artifacts
 * as part of explaining what changed.
 *
 * Add a new pattern ONLY when you are sure a specific phrasing is
 * unambiguously historical (commit-hash mention, explicit deletion verb,
 * retirement declaration). Avoid broad patterns that would mask drift.
 */
const HISTORICAL_CITATION_PATTERNS: readonly RegExp[] = [
  // Rename / transition phrases
  /promoted[\s-]from/i,
  /promoted[\s-]to/i,
  /superseded[\s-]by/i,
  /was\s+\w+[-]\w+\s+(finding|auditor)/i,
  /\babsorb(s|ed|ing)?\b/i,
  /frozen[\s-]reference/i,
  /\bsibling\b.+\blane/i,
  /→\s+lane-[ab]/i,
  /scheduled\s+for\s+deletion/i,

  // Deletion / retirement announcements
  /deleted\s+entirely/i,
  /deleted\s+\d{4}-\d{2}-\d{2}/,
  /\bretire[ds]?\b/i,
  /\barchived\b/i,
  /\bdormant\b/i,
  /pre-flatten/i,
  /\bprevious(ly)?\b/i,

  // Explicit absence statements (e.g., "no external CLI binary, no …")
  /no\s+external\s+(cli|binary|runner)/i,
  /no\s+background\s+runner/i,
  /no\s+api-key\s+dispatch/i,
  /does\s+not\s+exist/i,
  /(does|do)\s+not\s+resurface/i,

  // Commit hash citations (any 7+ hex — a historical reference anchor)
  /commit\s+[a-f0-9]{7,}/i,
  /`[a-f0-9]{7,}`/,

  // Old path explanations — "old `.claude/agents-enterprise-v2/` paths"
  /\bold\s+`?\.claude\/(agents-enterprise-v2|test-agents)/i,

  // Plan-document cross-ref (abstract-brewing-mochi, razing-zebra-flat, etc.)
  /\.claude\/plans\/(abstract|razing|synthetic|declarative|parallel)/i,

  // Legacy README dormancy declaration
  /no\s+new\s+work\s+lands\s+here/i,
];

function isHistoricalLine(line: string): boolean {
  return HISTORICAL_CITATION_PATTERNS.some((re) => re.test(line));
}

const LIVE_SNOWBALL_BRANCH_PATTERNS: readonly {
  readonly label: string;
  readonly re: RegExp;
}[] = [
  { label: '--base snowball', re: /--base\s+snowball/ },
  { label: 'origin/snowball', re: /origin\/snowball/ },
  { label: 'base = snowball', re: /base\s*=\s*snowball/ },
  { label: 'against the snowball branch', re: /against the snowball branch/i },
  { label: 'PR against snowball', re: /PR\s+against\s+snowball/i },
  { label: 'Branch: `snowball`', re: /Branch:\s*`snowball`/ },
];

// ---------------------------------------------------------------------------
// Cross-reference integrity check
// ---------------------------------------------------------------------------

describe('active-path hygiene invariant', () => {
  const activeFiles = listActiveFiles();
  const validAgentNames = collectActiveAgentNames();

  it('baseline — active files enumerated (regression guard)', () => {
    expect(activeFiles.length).toBeGreaterThan(50);
    expect(validAgentNames.size).toBeGreaterThan(50);
  });

  describe('cross-reference integrity', () => {
    it('every backtick-wrapped agent-shape token resolves to a real agent name', () => {
      const unresolved: string[] = [];

      for (const file of activeFiles) {
        const rel = path.relative(REPO_ROOT, file);
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (isHistoricalLine(line)) continue;

          const tokens = extractBacktickAgentTokens(line);
          for (const token of tokens) {
            if (validAgentNames.has(token)) continue;
            if (NON_DISPATCH_TOKEN_ALLOWLIST.has(token)) continue;
            if ((DYNAMIC_AGENT_PLACEHOLDERS as readonly string[]).includes(token)) continue;
            unresolved.push(`${rel}:${i + 1} — \`${token}\``);
          }
        }
      }

      if (unresolved.length > 0) {
        const hint =
          'Dead agent dispatch reference. Either:\n' +
          '  (a) rename the token to the current agent name (e.g., contract-parity-auditor → contract-parity-enforcer)\n' +
          '  (b) restore the agent file and roster entry\n' +
          '  (c) add the token to HISTORICAL_CITATION_PATTERNS if it is an intentional tombstone\n' +
          '  (d) add to NON_DISPATCH_TOKEN_ALLOWLIST in active-path-hygiene.spec.ts if it is a domain term';
        throw new Error(
          `Unresolved agent-shape tokens:\n  - ${unresolved.join('\n  - ')}\n\n${hint}`,
        );
      }
      expect(unresolved).toEqual([]);
    });
  });

  describe('legacy terminology ban', () => {
    it.each(DEAD_TERMINOLOGY_TOKENS)(
      'no active file contains the banned token "%s"',
      (token) => {
        const hits: string[] = [];
        for (const file of activeFiles) {
          const rel = path.relative(REPO_ROOT, file);
          const content = fs.readFileSync(file, 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? '';
            if (isHistoricalLine(line)) continue;
            if (line.includes(token)) {
              hits.push(`${rel}:${i + 1}`);
            }
          }
        }

        if (hits.length > 0) {
          const hint =
            `Token "${token}" is pre-flatten / pre-CLI drift. Rewrite to current terminology:\n` +
            `  - test-agents           → Lane-B product-audit\n` +
            `  - agents-enterprise-v2  → .claude/agents/ (flatten commit 2582592e)\n` +
            `  - npx claude-agent      → Claude Code built-in Agent() tool\n` +
            `  - orchestrator-runner   → Claude Code built-in Agent() tool (runner deleted commit e8f06e98)\n` +
            `  - platform-services     → active owning expert prefix from .claude/shared/output-format.md`;
          throw new Error(
            `Banned token "${token}" found in active paths:\n  - ${hits.join('\n  - ')}\n\n${hint}`,
          );
        }
        expect(hits).toEqual([]);
      },
    );
  });

  describe('live branch authority', () => {
    it('does not route active prompts through the historical snowball branch', () => {
      const hits: string[] = [];
      for (const file of activeFiles) {
        const rel = path.relative(REPO_ROOT, file);
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          if (isHistoricalLine(line)) continue;
          for (const pattern of LIVE_SNOWBALL_BRANCH_PATTERNS) {
            if (pattern.re.test(line)) {
              hits.push(`${rel}:${i + 1} — ${pattern.label}`);
            }
          }
        }
      }

      if (hits.length > 0) {
        throw new Error(
          `Active prompts must not route live work through snowball:\n  - ${hits.join(
            '\n  - ',
          )}\n\nUse aria-kernel/aria_kernel/pr_manager.py::ARIA_PR_BASE as the executable PR-base owner.`,
        );
      }
      expect(hits).toEqual([]);
    });
  });

  describe('model enum validity', () => {
    it('no active agent file declares model: codex (invalid CLI enum)', () => {
      const hits: string[] = [];
      for (const file of activeFiles) {
        const rel = path.relative(REPO_ROOT, file);
        if (!rel.startsWith('.claude/agents')) continue;
        const content = fs.readFileSync(file, 'utf8');
        if (/^model:\s*codex\s*$/m.test(content)) {
          hits.push(rel);
        }
      }
      expect(hits).toEqual([]);
    });
  });
});
