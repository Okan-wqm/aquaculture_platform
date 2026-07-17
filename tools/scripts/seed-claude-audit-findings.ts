#!/usr/bin/env ts-node
/**
 * Seed the 15 CLAUDE-* findings from the 2026-04-18 enterprise-v2 audit into
 * docs/reviews/_registry/findings.jsonl. Idempotent: entries are added only
 * when the id is not already present. Re-runs are safe.
 *
 * Routes every historical fixed-id entry through the governed add-explicit
 * command, which owns duplicate checks, reservation high-water, validation,
 * hash chaining, and atomic replacement under the common Git-dir lock.
 *
 * One-shot seed per Phase 0 of /root/.claude/plans/synthetic-dazzling-hippo.md.
 * Subsequent state transitions (e.g. OPEN → RESOLVED on each fix commit) go
 * through tools/gates/finding-registry.ts close.
 *
 * Usage:
 *   npx ts-node --project tools/gates/tsconfig.json tools/scripts/seed-claude-audit-findings.ts [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');
const REGISTRY_CLI = resolve(REPO_ROOT, 'tools', 'gates', 'finding-registry.ts');
const CLI_TSCONFIG = resolve(REPO_ROOT, 'tools', 'gates', 'tsconfig.json');

const AUDIT_FILE = 'docs/reviews/context-manager/2026-04-18-enterprise-v2-audit.md';
const AUDIT_CYCLE = '2026-04-18-enterprise-v2-audit';
const RAISED_AT = '2026-04-18T00:00:00Z';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type Layer = 1 | 2 | 3 | null;

interface FindingEntry {
  id: string;
  severity: Severity;
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  evidence: string[];
  rule_violated: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes: string;
  layer?: 1 | 2 | 3;
  prev_hash?: string;
  content_hash?: string;
}

function mk(
  id: string,
  severity: Severity,
  layer: Layer,
  title: string,
  evidence: string[],
  ruleViolated: string,
  notes: string,
): FindingEntry {
  const entry: FindingEntry = {
    id,
    severity,
    state: 'OPEN',
    title,
    evidence,
    rule_violated: ruleViolated,
    owner_agent: 'context-manager',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: RAISED_AT,
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes,
  };
  // Schema allows layer in [1,2,3]; doc-only findings (tier-4) omit the field
  // entirely since the schema marks it optional and tier-4 doesn't fit the
  // knowledge-layer taxonomy.
  if (layer !== null && layer >= 1 && layer <= 3) {
    entry.layer = layer;
  }
  return entry;
}

const entries: FindingEntry[] = [
  mk(
    'CLAUDE-CRITICAL-001',
    'CRITICAL',
    3,
    'Lane-A / Lane-B name-frontmatter collisions (orchestrator, context-manager, architectural-arbiter) produce undefined dispatch',
    [
      '.claude/agents-enterprise-v2/orchestrator.md:2',
      '.claude/test-agents/orchestrator.md:2',
      '.claude/agents-enterprise-v2/context-manager.md:2',
      '.claude/test-agents/context-manager.md:2',
      '.claude/agents-enterprise-v2/architectural-arbiter.md:2',
      '.claude/test-agents/architectural-arbiter.md:2',
      'tools/scripts/orchestrator-runner.ts:261',
    ],
    'Every agent name globally unique per _shared/handoff-protocol.md; sub-agents docs leave same-scope collisions undefined',
    'Fix direction: rename Lane-B duplicates to product-audit-*; land tests/invariants/agent-name-uniqueness.spec.ts.',
  ),
  mk(
    'CLAUDE-CRITICAL-002',
    'CRITICAL',
    3,
    'Deprecated platform-services.md retains valid name: frontmatter and is still loadable by claude-agent CLI',
    [
      '.claude/agents-enterprise-v2/platform-services.md:2',
      '.claude/agents-enterprise-v2/orchestrator.md:79',
      '.claude/agents-enterprise-v2/platform-services.md:28',
    ],
    'CLAUDE.md Architectural Approach — tier-1 (make impossible) preferred over tier-4 (markdown strikethrough + prose warning)',
    'Fix direction: move file to .claude/agents.legacy/ + remove row from orchestrator.md roster.',
  ),
  mk(
    'CLAUDE-CRITICAL-003',
    'CRITICAL',
    3,
    '@.claude/... references in agent bodies are inert; SSoT include mechanism does not exist at runtime',
    [
      '.claude/agents-enterprise-v2/data-expert.md:14',
      '.claude/knowledge/README.md:11',
      'tools/scripts/orchestrator-runner.ts:1',
    ],
    'Documentation promises a runtime behavior that does not exist — sub-agents docs confirm @ imports apply to CLAUDE.md only',
    'Fix direction: documentation-only convention (per user directive) — rewrite Canonical References header to READ-via-Read-tool wording; add .claude/README.md.',
  ),
  mk(
    'CLAUDE-HIGH-001',
    'HIGH',
    3,
    'All 7 skill files omit the handoff: frontmatter field mandated by _shared/handoff-protocol.md',
    [
      '.claude/agents-enterprise-v2/_shared/handoff-protocol.md:16',
      '.claude/skills/add-entity-field.md:1',
      '.claude/skills/change-event-contract.md:1',
      '.claude/skills/add-rls-policy.md:1',
      '.claude/skills/add-shared-table.md:1',
      '.claude/skills/provision-tenant.md:1',
      '.claude/skills/pre-migration-restore-test.md:1',
      '.claude/skills/run-migration-prod.md:1',
    ],
    '_shared/handoff-protocol.md § Skill frontmatter handoff field — MANDATORY on every skill',
    'Fix direction: add handoff: block to all 7 skills; land skills-catalog.spec.ts.',
  ),
  mk(
    'CLAUDE-HIGH-002',
    'HIGH',
    3,
    '7 CI invariant tests red on agentic branch (adoption ×4, finding-registry-integrity ×1, three-store ×2)',
    [
      'apps/alert-engine/src/app.module.ts:157',
      'apps/event-store-service/src/app.module.ts:1',
      'docs/reviews/_registry/findings.jsonl:15',
      'docs/reviews/infra-expert/2026-04-17-deploy-debug.md:1',
    ],
    'CLAUDE.md "Run nx affected --target=test after changes. Never commit with red tests"',
    'Fix direction: Phase 2 of plan — alert-engine serviceName; event-store-service SchemaDriftModule add; registry FE-CRITICAL-001 + PROC-MEDIUM-005 repair.',
  ),
  mk(
    'CLAUDE-HIGH-003',
    'HIGH',
    3,
    'Phase 4.5 fallback path coexists with live finding-registry CLI in orchestrator-phases.md, producing ambiguous cycle state',
    [
      '.claude/agents-enterprise-v2/_shared/orchestrator-phases.md:130',
      'tools/gates/finding-registry.ts:1',
    ],
    'Non-determinism — two parallel paths for the same orchestrator phase',
    'Fix direction: remove fallback paragraph; registry is a hard dependency.',
  ),
  mk(
    'CLAUDE-HIGH-004',
    'HIGH',
    3,
    '28 Lane-B agent files do not carry Canonical References section; zero follow _conversion-template.md',
    [
      '.claude/agents-enterprise-v2/_shared/_conversion-template.md:18',
      '.claude/test-agents/form-write-auditor.md:1',
      '.claude/test-agents/soc2-readiness-auditor.md:1',
    ],
    '_conversion-template.md conversion rules #1 (≤200 lines) and #2-4 (no layer-1/2/3 inline duplication)',
    'Fix direction: port 24 active + 4 DEPRECATED Lane-B files per Phase 5 of plan.',
  ),
  mk(
    'CLAUDE-MEDIUM-001',
    'MEDIUM',
    3,
    'Runner smoke test absent — npm run audit:gdpr / audit:perf have no CI assertion of clean execution',
    [
      '.claude/agents-enterprise-v2/runners/gdpr-audit.ts:53',
      '.claude/agents-enterprise-v2/runners/perf-audit.ts:56',
    ],
    'CI health — every wired entrypoint should be smoke-tested',
    'Fix direction: add runner-smoke.spec.ts + --dry-run flag in orchestrator-runner.ts.',
  ),
  mk(
    'CLAUDE-MEDIUM-002',
    'MEDIUM',
    3,
    'Skills deprecation frontmatter (status, superseded_by) documented but not enforced by any invariant',
    ['.claude/skills/README.md:90'],
    '.claude/skills/README.md § Skill lifecycle',
    'Fix direction: covered by skills-catalog.spec.ts landing (see CLAUDE-HIGH-001 and CLAUDE-MEDIUM-002 overlap).',
  ),
  mk(
    'CLAUDE-MEDIUM-003',
    'MEDIUM',
    3,
    '200-line conversion-template cap has no CI gate; Lane-B already over cap (soc2-readiness-auditor.md 271 lines)',
    [
      '.claude/agents-enterprise-v2/_shared/_conversion-template.md:72',
      '.claude/test-agents/soc2-readiness-auditor.md:1',
    ],
    '_conversion-template.md hard size cap — Tier-3 detectable gate missing',
    'Fix direction: add agent-size-limit.spec.ts walking both agents-enterprise-v2/ and test-agents/.',
  ),
  mk(
    'CLAUDE-MEDIUM-004',
    'MEDIUM',
    1,
    'layer-1-ai.md Claude Agent SDK version anchor not verified against package.json',
    ['.claude/knowledge/layer-1-ai.md:3', 'package.json:1'],
    'knowledge-ssot.spec.ts covers 4 other anchors; AI anchor uncovered',
    'Fix direction: extend knowledge-ssot.spec.ts with layer-1-ai describe block.',
  ),
  mk(
    'CLAUDE-MEDIUM-005',
    'MEDIUM',
    3,
    'boundary-files.yaml expires: never entries lack mechanical ADR-reference invariant',
    [
      '.claude/allowlists/boundary-files.yaml:40',
      '.claude/agents-enterprise-v2/_shared/tier-claim-syntax.md:99',
    ],
    'Tier-3 (make detectable) missing — CODEOWNERS-gated + prose-only enforcement',
    'Fix direction: add boundary-allowlist-invariants.spec.ts checking ADR reference in reason/notes for every expires:never entry.',
  ),
  mk(
    'CLAUDE-LOW-001',
    'LOW',
    3,
    '.claude/agents.legacy/ loader exclusion not asserted by any test',
    ['.claude/agents.legacy/README.md:3'],
    'Defensive invariant absent',
    'Fix direction: superseded by CLAUDE-CRITICAL-001 new agent-name-uniqueness.spec.ts which walks the whole .claude/ tree.',
  ),
  mk(
    'CLAUDE-LOW-002',
    'LOW',
    null,
    'add-entity-field.md cites non-existent create-entity skill',
    ['.claude/skills/add-entity-field.md:19'],
    'Dangling reference — listed skill does not exist on disk',
    'Fix direction: remove the "use create-entity skill for that" phrase.',
  ),
  mk(
    'CLAUDE-LOW-003',
    'LOW',
    null,
    'platform-services.md contains untranslated Turkish paragraph inside an otherwise-English corpus',
    ['.claude/agents-enterprise-v2/platform-services.md:12'],
    'Corpus language consistency',
    'Fix direction: translate during Phase 1c archival commit.',
  ),
];

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const existing: FindingEntry[] = existsSync(REGISTRY)
    ? readFileSync(REGISTRY, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FindingEntry)
    : [];

  const existingIds = new Set(existing.map((entry) => entry.id));
  const toAdd = entries.filter((entry) => !existingIds.has(entry.id));
  if (toAdd.length === 0) {
    console.log(
      `All 15 CLAUDE-* findings already present (${existing.length} total entries). No-op.`,
    );
    return;
  }
  if (dryRun) {
    console.log(`DRY RUN: would append ${toAdd.length} entries through add-explicit.`);
    return;
  }

  const stubDirectory = mkdtempSync(join(tmpdir(), 'claude-finding-seed-'));
  try {
    for (const entry of toAdd) {
      const stubPath = join(stubDirectory, `${entry.id}.json`);
      writeFileSync(stubPath, `${JSON.stringify(entry)}\n`, 'utf8');
      execFileSync(
        'npx',
        ['ts-node', '--project', CLI_TSCONFIG, REGISTRY_CLI, 'add-explicit', stubPath],
        { cwd: REPO_ROOT, stdio: 'inherit' },
      );
    }
  } finally {
    rmSync(stubDirectory, { recursive: true, force: true });
  }
  console.log(
    `Appended ${toAdd.length} CLAUDE-* findings through the common allocation authority.`,
  );
}

main();
