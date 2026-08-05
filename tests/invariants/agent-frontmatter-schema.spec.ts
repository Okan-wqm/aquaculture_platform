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

  // Plan 023 §A — model/effort tiering, as amended by the K5 tier flip
  // (operator decision 2026-07-01). READ THE ASSERTION, NOT THE HISTORY: in
  // this repo `fable` is the EXPENSIVE, most-capable tier (priced 2x opus in
  // budget.MODEL_PRICING_USD_PER_MTOK, and the target DEFAULT_MODEL fails safe
  // to), while `opus` is the cheaper judge/scout tier and the credit-fallback
  // destination (MODEL_FALLBACK_TIER = {fable: opus}). These comments said
  // "opus/xhigh" for both tiers long after K5 moved writers to fable, which is
  // how the tiering came to be read backwards. Non-ARIA platform reviewers stay
  // on their own pinned policy. ARIA agents tier per the "scout-and-verify"
  // decision: read-only scorers/scanners may run on the cheaper opus tier,
  // while the consensus decider and every writer stay on fable. Runtime SSoT:
  // aria-kernel/aria_kernel/agent_runtime_profile.py; rationale:
  // docs/aria/plans/023-cost-tiering-and-consensus-escalation.md.
  const ARIA_VALID_MODELS = new Set<string>(['opus', 'fable']);
  const ARIA_VALID_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);
  // Writers (Edit/Write/Bash) + governance-artifact authors run the
  // IMPLEMENTATION tier: opus at effort max, with sonnet as its credit
  // fallback (MODEL_FALLBACK_TIER = {fable: opus, opus: sonnet}). Planning
  // agents stay on fable, the most capable pool. Mirrors python
  // WRITE_TIER_AGENTS — the two sets must never diverge (ORPHAN-HIGH-285).
  // Plan tranquil-sniffing-pancake Faz 2.1 — the acceptance lane's four
  // agents are pinned explicitly so a silent tier downgrade fails here
  // rather than only changing behaviour. Lead is the decision node (fable);
  // the three reviewers are judge-tier (opus). Fixer is also in
  // ARIA_WRITE_TIER below, which additionally pins its effort.
  const ARIA_ACCEPTANCE_TIER: ReadonlyMap<string, [string, string]> = new Map([
    ['aria-acceptance-lead', ['fable', 'max']],
    ['aria-acceptance-output-validator', ['opus', 'max']],
    ['aria-acceptance-gap-hunter', ['opus', 'max']],
    ['aria-acceptance-gap-fixer', ['opus', 'max']],
  ]);

  const ARIA_WRITE_TIER = new Set<string>([
    'aria-implementer',
    'aria-drafter',
    'aria-prompt-writer',
    // Plan 030 — the acceptance lane's fixer holds Edit/Write/Bash and opens PRs;
    // pin it to opus/max so a write-capable auditor can never be downgraded.
    'aria-acceptance-gap-fixer',
    // K3 (ORPHAN-HIGH-285) — the promoted-plan assignment executor holds the
    // full write toolset; mirrored in python WRITE_TIER_AGENTS.
    'aria-worker',
  ]);
  const isAriaAgent = (file: AgentFile): boolean => file.filenameStem.startsWith('aria-');

  it.each(files.map((f) => [f.relPath, f] as const))(
    '%s — model/effort honor the tiering policy',
    (_label, file) => {
      const model = file.frontmatter.get('model');
      const effort = file.frontmatter.get('effort');
      if (!isAriaAgent(file)) {
        // Non-ARIA platform reviewers keep their own pinned policy. The
        // effort: max change is scoped to ARIA's own agents; raising 84
        // unrelated reviewers is a separate decision with its own cost and
        // latency profile.
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
      const acceptancePin = ARIA_ACCEPTANCE_TIER.get(file.filenameStem);
      if (acceptancePin) {
        expect([model, effort]).toEqual(acceptancePin);
      }
      if (ARIA_WRITE_TIER.has(file.filenameStem)) {
        // K5 tier flip — the write tier runs on the most capable model.
        expect(model).toBe('opus');
        expect(effort).toBe('max');
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
