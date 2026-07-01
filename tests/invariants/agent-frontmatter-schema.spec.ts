/**
 * Agent Frontmatter Schema Invariant
 * ============================================================================
 *
 * Closes CLAUDE-CRITICAL-006 — zero tools: frontmatter on any agent file —
 * by enforcing a structural contract on every .claude/agents/**\/*.md
 * frontmatter. Tier-1 "make-it-impossible" for the WRITER vs READER boundary:
 * the Claude Code sub-agent loader honors the `tools:` field; this invariant
 * guarantees every agent carries one.
 *
 * Required keys per agent file:
 *   - name          — matches filename stem OR is an alias (e.g. Lane-B meta
 *                     agents carry `product-audit-*` names in frontmatter
 *                     while their files are named after role, not dispatch
 *                     token).
 *   - description   — non-empty prose.
 *   - model         — exactly `opus` (platform policy; intentional per
 *                     plan mutable-frolicking-yao.md).
 *   - effort        — exactly `xhigh` (platform policy).
 *   - tools         — comma-separated list drawn from the whitelist below.
 *
 * Optional keys:
 *   - dispatch      — `cross-cutting` / `ad-hoc` / `maintenance` — marks a
 *                     roster agent as non-glob; consumed by the routing-
 *                     coverage reverse-check in orchestrator-routing-
 *                     coverage.spec.ts.
 *   - color         — UI affordance, no invariant.
 *
 * Allowed `tools:` tokens per Claude Code sub-agent loader:
 *   Read, Grep, Glob, Edit, Write, Bash, Agent, WebFetch, WebSearch,
 *   NotebookEdit, TodoWrite.
 *
 * Role-based tool presets (reference; not enforced — presets are advisory
 * and can be widened or narrowed per agent-specific need):
 *   Reviewer    : Read, Grep, Glob
 *   Reviewer+Bash: Read, Grep, Glob, Bash (e.g. test-runner, build-validator)
 *   Meta (dispatcher): Read, Grep, Glob, Agent
 *   Writer      : Read, Grep, Glob, Edit, Write, Bash
 *   Maintenance : Read, Grep, Glob, Edit, Write
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_ROOT = path.join(REPO_ROOT, '.claude', 'agents');

const TOOL_WHITELIST = new Set<string>([
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash',
  'Agent',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
]);

const DISPATCH_VALUES = new Set<string>(['cross-cutting', 'ad-hoc', 'maintenance']);

interface AgentFile {
  readonly relPath: string;
  readonly absPath: string;
  readonly frontmatter: Map<string, string>;
  readonly filenameStem: string;
}

function walkAgentFiles(dir: string, acc: AgentFile[] = []): AgentFile[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkAgentFiles(full, acc);
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    if (entry === 'README.md' || entry === 'INVOCATION-PACK.md') continue;
    const content = fs.readFileSync(full, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm.has('name')) continue; // skip non-agent .md files
    acc.push({
      relPath: path.relative(REPO_ROOT, full),
      absPath: full,
      frontmatter: fm,
      filenameStem: entry.replace(/\.md$/, ''),
    });
  }
  return acc;
}

function parseFrontmatter(content: string): Map<string, string> {
  const fm = new Map<string, string>();
  if (!content.startsWith('---\n')) return fm;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return fm;
  const block = content.slice(4, end);
  for (const line of block.split('\n')) {
    const match = line.match(/^([a-z][a-z-]+):\s*(.*)$/);
    if (match && match[1] && match[2] !== undefined) {
      fm.set(match[1], match[2].trim());
    }
  }
  return fm;
}

describe('agent frontmatter schema invariant (CLAUDE-CRITICAL-006)', () => {
  const files = walkAgentFiles(AGENTS_ROOT);

  it('at least one agent file discovered (regression guard)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — frontmatter has required keys',
    (_label, file) => {
      const required = ['name', 'description', 'model', 'effort', 'tools'];
      for (const key of required) {
        expect({ file: file.relPath, key, value: file.frontmatter.get(key) }).toEqual({
          file: file.relPath,
          key,
          value: expect.any(String),
        });
        expect(file.frontmatter.get(key)?.length ?? 0).toBeGreaterThan(0);
      }
    },
  );

  // Plan 023 §A — model/effort tiering. Non-ARIA platform reviewers stay on the
  // pinned policy (opus/xhigh). ARIA agents tier per the "scout-and-verify"
  // decision: read-only scorers/scanners may run on the cheap tier, while the
  // consensus decider and every writer stay on opus/xhigh. Runtime SSoT:
  // aria-kernel/aria_kernel/agent_runtime_profile.py; rationale:
  // docs/aria/plans/023-cost-tiering-and-consensus-escalation.md.
  const ARIA_VALID_MODELS = new Set<string>(['opus', 'sonnet', 'fable']);
  const ARIA_VALID_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
  // Writers (Edit/Write/Bash) + governance-artifact authors must stay opus/xhigh.
  const ARIA_WRITE_TIER = new Set<string>([
    'aria-implementer',
    'aria-drafter',
    'aria-prompt-writer',
    // Plan 030 — the acceptance lane's fixer holds Edit/Write/Bash and opens PRs;
    // pin it to opus/xhigh so a write-capable auditor can never be downgraded.
    'aria-acceptance-gap-fixer',
  ]);
  const isAriaAgent = (file: AgentFile): boolean => file.filenameStem.startsWith('aria-');

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — model/effort honor the tiering policy',
    (_label, file) => {
      const model = file.frontmatter.get('model');
      const effort = file.frontmatter.get('effort');
      if (!isAriaAgent(file)) {
        expect(model).toBe('opus');
        expect(effort).toBe('xhigh');
        return;
      }
      expect({ file: file.relPath, model, valid: ARIA_VALID_MODELS.has(model ?? '') }).toEqual({
        file: file.relPath,
        model,
        valid: true,
      });
      expect({ file: file.relPath, effort, valid: ARIA_VALID_EFFORTS.has(effort ?? '') }).toEqual({
        file: file.relPath,
        effort,
        valid: true,
      });
      if (ARIA_WRITE_TIER.has(file.filenameStem)) {
        expect(model).toBe('opus');
        expect(effort).toBe('xhigh');
      }
    },
  );

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — tools: values drawn from whitelist',
    (_label, file) => {
      const toolsRaw = file.frontmatter.get('tools') ?? '';
      const tokens = toolsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      expect(tokens.length).toBeGreaterThan(0);
      for (const t of tokens) {
        expect({ file: file.relPath, token: t, inWhitelist: TOOL_WHITELIST.has(t) }).toEqual({
          file: file.relPath,
          token: t,
          inWhitelist: true,
        });
      }
    },
  );

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — dispatch field (if present) is cross-cutting | ad-hoc | maintenance',
    (_label, file) => {
      const dispatch = file.frontmatter.get('dispatch');
      if (dispatch === undefined) return;
      expect(DISPATCH_VALUES.has(dispatch)).toBe(true);
    },
  );

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — name matches filename stem OR is a known alias',
    (_label, file) => {
      const name = file.frontmatter.get('name') ?? '';
      // Direct match
      if (name === file.filenameStem) {
        expect(name).toBe(file.filenameStem);
        return;
      }
      // Known aliases (Lane-B meta agents use product-audit-* names while
      // their filenames are role-based: orchestrator.md →
      // product-audit-orchestrator, context-manager.md →
      // product-audit-context-manager). The product-audit-arbiter.md
      // filename was renamed 2026-04-18 to match its frontmatter name,
      // so no alias is required for it — direct match instead.
      const KNOWN_ALIASES: Record<string, string> = {
        orchestrator: 'product-audit-orchestrator',
        'context-manager': 'product-audit-context-manager',
      };
      if (
        file.relPath.includes('product-audit') &&
        KNOWN_ALIASES[file.filenameStem] === name
      ) {
        expect(KNOWN_ALIASES[file.filenameStem]).toBe(name);
        return;
      }
      // Otherwise report mismatch for operator clarity.
      expect({ file: file.relPath, filenameStem: file.filenameStem, name }).toEqual({
        file: file.relPath,
        filenameStem: file.filenameStem,
        name: file.filenameStem,
      });
    },
  );
});
