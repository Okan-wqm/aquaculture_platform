#!/usr/bin/env ts-node
/**
 * Plan ARIA-V4 §2 — narrative-prompt-lint.
 *
 * Pre-commit / CI gate that validates every ARIA agent prompt file
 * against the pedagogy contract declared in
 * `.claude/agents/_pedagogy-registry.json`.
 *
 * Mirrors the Python validator at
 * `aria-kernel/aria_kernel/narrative_prompt_validator.py`. The two
 * implementations MUST stay logically equivalent — Plan ARIA-V4
 * invariant `test_phase_v4_b_narrative_shape` is the Python
 * authoritative path; this TS gate is the operator-facing pre-commit
 * mirror (fast feedback before the invariant runs in CI).
 *
 * Tiered shape rules:
 *   - Tier-1 — bare imperative; no `### Prohibition:` blocks with
 *     narrative sections expected.
 *   - Tier-2 hybrid — imperative headline (Rule line starts with
 *     grep-stable imperative) + 4 narrative sections (Temptation /
 *     Why-looks-correct / Downstream-consequence / Correct-path).
 *   - Tier-3 full narrative — same 4 sections for every
 *     `### Prohibition:` block; ends on invariant being protected.
 *
 * Consequence-leak protection (Plan §2d):
 *   When the prohibition block's `rule-class:` tag is on the
 *   `_pedagogy-registry.json` consequence-leak allowlist for that
 *   agent, the "downstream consequence" section MUST be omitted
 *   (describing how the attack works IS the attack-surface manual).
 *
 * Token budget (Plan §2g):
 *   ≤ 2000 approx tokens per agent file (≈ 4 chars / token).
 *
 * Usage:
 *   ts-node tools/gates/narrative-prompt-lint.ts            # validate all aria-*.md
 *   ts-node tools/gates/narrative-prompt-lint.ts <file.md>  # validate single file
 *
 * Exit codes:
 *   0 — all files pass
 *   1 — at least one file has violations (printed to stderr)
 *   2 — usage error or registry missing
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Plan ARIA-V4 §2g — the per-tier narrative token budget.
 *
 * The budget is DERIVED from the kernel validator, which the plan names as its
 * SSoT, instead of being restated here. This gate used to carry a flat
 * `const TOKEN_BUDGET_PER_FILE = 2000` while
 * `aria_kernel/narrative_prompt_validator.py` scaled the budget by tier
 * (1 → 1500, 2 → 2800, 3 → 3500). A Tier-3 prompt of 2400 tokens therefore
 * passed the validator that owns the rule and failed the lint that copies it,
 * and neither number could be called wrong by reading only one file. Reading
 * the table makes the two agree by construction rather than by discipline.
 */
const TOKEN_BUDGET_SSOT = 'aria-kernel/aria_kernel/narrative_prompt_validator.py';
const TOKEN_BUDGET_TABLE_RE = /TOKEN_BUDGET_PER_TIER: dict\[int, int\] = \{([^}]*)\}/;
const TOKEN_BUDGET_ENTRY_RE = /(\d+):\s*(\d+)/g;

function loadTierBudgets(): ReadonlyMap<number, number> {
  const ssotPath = path.resolve(__dirname, '..', '..', TOKEN_BUDGET_SSOT);
  const source = fs.readFileSync(ssotPath, 'utf8');
  const table = TOKEN_BUDGET_TABLE_RE.exec(source);
  const body = table?.[1];
  if (body === undefined) {
    throw new Error(
      `${TOKEN_BUDGET_SSOT} no longer declares TOKEN_BUDGET_PER_TIER in the expected shape; ` +
        'this gate reads that table so the two implementations cannot diverge.',
    );
  }
  const budgets = new Map<number, number>();
  for (const entry of body.matchAll(TOKEN_BUDGET_ENTRY_RE)) {
    const tier = entry[1];
    const budget = entry[2];
    if (tier === undefined || budget === undefined) continue;
    budgets.set(Number(tier), Number(budget));
  }
  if (budgets.size === 0) {
    throw new Error(`${TOKEN_BUDGET_SSOT} declares an empty TOKEN_BUDGET_PER_TIER table`);
  }
  return budgets;
}

const TIER_BUDGETS = loadTierBudgets();
/** Tier-3 headroom is the documented default for an unknown or absent tier. */
const DEFAULT_TIER = 3;

function budgetForTier(tier: number | null): number {
  const fallback = TIER_BUDGETS.get(DEFAULT_TIER);
  if (fallback === undefined) {
    throw new Error(`${TOKEN_BUDGET_SSOT} declares no tier ${DEFAULT_TIER} budget`);
  }
  if (tier === null) return fallback;
  return TIER_BUDGETS.get(tier) ?? fallback;
}

function writeStdout(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = ''): void {
  process.stderr.write(`${message}\n`);
}

const FRONTMATTER_RE = /^---\n(.*?)\n---\n/s;
const PEDAGOGY_TIER_RE = /^pedagogy-tier:\s*(\d+)\s*$/m;
const NAME_RE = /^name:\s*(\S+)\s*$/m;
const PROHIBITION_HEADER_RE = /^### Prohibition:\s*(?<summary>[^\n]+)\n/gm;
const RULE_CLASS_RE = /^\*?\*?rule-class:\*?\*?\s*(?<ruleClass>[a-z][a-z0-9_-]*)\s*$/m;
const IMPERATIVE_PREFIX_RE =
  /^(?:Never|Don't|Do not|MUST NOT|Must not|FORBIDDEN|Forbidden|Reject|Refuse|Block|Always)\b/i;

const SECTION_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Rule', /\*\*Rule\.\*\*/i],
  ['The temptation', /\*\*The temptation\.\*\*/i],
  ['Why it looks correct', /\*\*Why it looks correct\.\*\*/i],
  ['The downstream consequence', /\*\*The downstream consequence\.\*\*/i],
  ['The correct path', /\*\*The correct path\.\*\*/i],
];

const REQUIRED_SECTIONS_FULL = [
  'Rule',
  'The temptation',
  'Why it looks correct',
  'The downstream consequence',
  'The correct path',
] as const;

const REQUIRED_SECTIONS_WITHOUT_CONSEQUENCE = [
  'Rule',
  'The temptation',
  'Why it looks correct',
  'The correct path',
] as const;

interface RegistryEntry {
  pedagogy_tier: number;
  rationale: string;
  consequence_leak_protections?: string[];
}

interface PedagogyRegistry {
  schema_version: number;
  tier_assignments: Record<string, RegistryEntry>;
  consequence_leak_allowlist: Array<{
    agent_name: string;
    rule_class: string;
    rationale: string;
  }>;
}

interface ProhibitionBlock {
  summary: string;
  rule_class: string | null;
  sections_present: string[];
  rule_first_line: string;
  start_line: number;
}

interface FileValidationResult {
  path: string;
  agent_name: string | null;
  pedagogy_tier: number | null;
  prohibitions: ProhibitionBlock[];
  violations: string[];
  approx_tokens: number;
}

function approxTokens(text: string): number {
  return Math.max(0, Math.floor(text.length / 4));
}

function detectSections(blockText: string): string[] {
  const present: string[] = [];
  for (const [label, pattern] of SECTION_MARKERS) {
    if (pattern.test(blockText)) {
      present.push(label);
    }
  }
  return present;
}

function extractProhibitions(body: string): ProhibitionBlock[] {
  const matches: RegExpMatchArray[] = [];
  for (const m of body.matchAll(PROHIBITION_HEADER_RE)) {
    matches.push(m);
  }
  const blocks: ProhibitionBlock[] = [];
  for (let idx = 0; idx < matches.length; idx++) {
    const headerMatch = matches[idx];
    if (!headerMatch) continue;
    const headerStart = headerMatch.index ?? 0;
    const nextHeaderStart =
      idx + 1 < matches.length ? (matches[idx + 1]?.index ?? body.length) : body.length;
    let end = nextHeaderStart;
    const afterHeader = body.slice(headerStart + headerMatch[0].length, end);
    const nextH3 = afterHeader.match(/^### /m);
    if (nextH3 && nextH3.index !== undefined) {
      end = headerStart + headerMatch[0].length + nextH3.index;
    }
    const raw = body.slice(headerStart, end);
    const summary = headerMatch.groups?.summary?.trim() ?? '';
    const rcMatch = RULE_CLASS_RE.exec(raw);
    const ruleClass = rcMatch?.groups?.ruleClass ?? null;
    const sections = detectSections(raw);
    const ruleLineMatch = /\*\*Rule\.\*\*\s*\n?\s*(?<line>[^\n]*)/i.exec(raw);
    const ruleFirstLine = (ruleLineMatch?.groups?.line ?? '')
      .trim()
      .replace(/^`+|`+$/g, '')
      .replace(/^\*+|\*+$/g, '')
      .trim();
    const startLine = body.slice(0, headerStart).split('\n').length;
    blocks.push({
      summary,
      rule_class: ruleClass,
      sections_present: sections,
      rule_first_line: ruleFirstLine,
      start_line: startLine,
    });
  }
  return blocks;
}

function parseAgentFile(filePath: string): FileValidationResult {
  const text = fs.readFileSync(filePath, 'utf-8');
  const fmMatch = text.match(FRONTMATTER_RE);
  let agentName: string | null = null;
  let pedagogyTier: number | null = null;
  let body = text;
  if (fmMatch) {
    const fm = fmMatch[1] ?? '';
    const nameMatch = fm.match(NAME_RE);
    const tierMatch = fm.match(PEDAGOGY_TIER_RE);
    const tierValue = tierMatch?.[1];
    agentName = nameMatch?.[1] ?? null;
    pedagogyTier = tierValue ? parseInt(tierValue, 10) : null;
    body = text.slice(fmMatch[0].length);
  }
  const prohibitions = extractProhibitions(body);
  return {
    path: filePath,
    agent_name: agentName,
    pedagogy_tier: pedagogyTier,
    prohibitions,
    violations: [],
    approx_tokens: approxTokens(body),
  };
}

function validateFile(filePath: string, registry: PedagogyRegistry): FileValidationResult {
  const result = parseAgentFile(filePath);
  const tier = result.pedagogy_tier;
  if (tier === null) {
    result.violations.push(
      `${path.basename(filePath)}: missing \`pedagogy-tier:\` frontmatter (Plan ARIA-V4 §2a I-V4-01)`,
    );
    return result;
  }

  // Determine consequence-leak protected rule_classes for this agent.
  const protectedClasses = new Set<string>();
  for (const entry of registry.consequence_leak_allowlist ?? []) {
    if (entry.agent_name === result.agent_name && entry.rule_class) {
      protectedClasses.add(entry.rule_class);
    }
  }

  // Token-budget check, at the tier's budget rather than a flat ceiling.
  const tokenBudget = budgetForTier(tier);
  if (result.approx_tokens > tokenBudget) {
    result.violations.push(
      `${path.basename(filePath)}: approx tokens ${result.approx_tokens} > budget ${tokenBudget} for tier ${tier} (Plan ARIA-V4 §2g I-V4-07)`,
    );
  }

  if (tier === 1) {
    // Tier-1: no narrative blocks expected.
    for (const block of result.prohibitions) {
      if (block.sections_present.some((s) => s !== 'Rule')) {
        result.violations.push(
          `${path.basename(filePath)}:${block.start_line} — Tier-1 file contains a narrative-shape Prohibition block (${block.summary}); either remove the narrative sections or reclassify the agent as Tier-2/3 (Plan ARIA-V4 §2a)`,
        );
      }
    }
    return result;
  }

  // Tier-2 + Tier-3 structural validation.
  for (const block of result.prohibitions) {
    const isProtected = block.rule_class !== null && protectedClasses.has(block.rule_class);
    const required = isProtected ? REQUIRED_SECTIONS_WITHOUT_CONSEQUENCE : REQUIRED_SECTIONS_FULL;
    const missing = required.filter((s) => !block.sections_present.includes(s));
    if (missing.length > 0) {
      result.violations.push(
        `${path.basename(filePath)}:${block.start_line} prohibition ${JSON.stringify(block.summary)} missing sections: ${JSON.stringify(missing)} (rule_class=${JSON.stringify(block.rule_class)}, consequence_leak_protected=${isProtected}; Plan ARIA-V4 §2b I-V4-04)`,
      );
    }
    // Imperative-residue check.
    if (block.rule_first_line && !IMPERATIVE_PREFIX_RE.test(block.rule_first_line)) {
      result.violations.push(
        `${path.basename(filePath)}:${block.start_line} prohibition ${JSON.stringify(block.summary)} Rule line ${JSON.stringify(block.rule_first_line)} does not start with a grep-stable imperative (Plan ARIA-V4 §2c I-V4-05)`,
      );
    }
    // Consequence-leak protection.
    if (isProtected && block.sections_present.includes('The downstream consequence')) {
      result.violations.push(
        `${path.basename(filePath)}:${block.start_line} prohibition ${JSON.stringify(block.summary)} rule_class=${JSON.stringify(block.rule_class)} is on the consequence-leak allowlist for ${result.agent_name}; remove the consequence section (Plan ARIA-V4 §2d I-V4-06)`,
      );
    }
  }
  return result;
}

function findAriaAgentFiles(repoRoot: string): string[] {
  const agentsDir = path.join(repoRoot, '.claude', 'agents');
  const files: string[] = [];
  for (const f of fs.readdirSync(agentsDir)) {
    if (f.startsWith('aria-') && f.endsWith('.md')) {
      files.push(path.join(agentsDir, f));
    }
  }
  const maintenanceDir = path.join(agentsDir, '_maintenance');
  if (fs.existsSync(maintenanceDir)) {
    for (const f of fs.readdirSync(maintenanceDir)) {
      if (f.startsWith('aria-') && f.endsWith('.md')) {
        files.push(path.join(maintenanceDir, f));
      }
    }
  }
  return files.sort();
}

function main(): number {
  const argv = process.argv.slice(2);
  // Repo-root resolution — walk up from this file to find .git OR rely on cwd.
  const repoRoot = process.cwd();
  const registryPath = path.join(repoRoot, '.claude', 'agents', '_pedagogy-registry.json');
  if (!fs.existsSync(registryPath)) {
    writeStderr(`[narrative-prompt-lint] FATAL: registry missing at ${registryPath}`);
    return 2;
  }
  const registry = JSON.parse(
    fs.readFileSync(registryPath, 'utf-8'),
  ) as unknown as PedagogyRegistry;

  const targets = argv.length > 0 ? argv : findAriaAgentFiles(repoRoot);
  if (targets.length === 0) {
    writeStderr('[narrative-prompt-lint] FATAL: no ARIA agent files found');
    return 2;
  }

  let totalViolations = 0;
  for (const filePath of targets) {
    const result = validateFile(filePath, registry);
    if (result.violations.length > 0) {
      totalViolations += result.violations.length;
      for (const v of result.violations) {
        writeStderr(`[narrative-prompt-lint] ${v}`);
      }
    }
  }

  if (totalViolations > 0) {
    writeStderr(
      `[narrative-prompt-lint] FAIL: ${totalViolations} violation(s) across ${targets.length} file(s)`,
    );
    return 1;
  }
  writeStdout(
    `[narrative-prompt-lint] OK: ${targets.length} file(s) pass the Plan ARIA-V4 pedagogy contract`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

export { main, validateFile, parseAgentFile };
