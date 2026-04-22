#!/usr/bin/env ts-node
/**
 * Seed the finding registry (docs/reviews/_registry/findings.jsonl) with the
 * Phase-0 audit findings (P0-1..P0-7) that were raised by the 2026-04-16 v2
 * audit. Computes hash chain properly:
 *
 *   prev_hash[0]   = 64 zeros
 *   prev_hash[i]   = entries[i-1].content_hash
 *   content_hash[i] = sha256hex( canonical JSON of entry[i] with content_hash removed )
 *
 * This is a one-shot seed. Subsequent finding appends go through
 * tools/gates/finding-registry.ts (Phase 2 deliverable).
 *
 * Usage:
 *   npx ts-node --project tools/gates/tsconfig.json tools/scripts/seed-finding-registry.ts [--dry-run]
 *
 * Phase reference: /root/.claude/plans/abstract-brewing-mochi.md#Phase-6
 */

import { createHash } from 'node:crypto';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

const AUDIT_FILE = 'docs/reviews/orchestrator/2026-04-16-v2-audit.md';
const AUDIT_CYCLE = '2026-04-16-v2-audit';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type State = 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';

interface SeedEntry {
  id: string;
  severity: Severity;
  state: State;
  title: string;
  layer: 1 | 2 | 3;
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
}

interface ChainedEntry extends SeedEntry {
  prev_hash: string;
  content_hash: string;
}

// Seed entries. Phase 0 audit findings (P0-1..P0-7) — most already RESOLVED by
// the 4 commits: 32839e24 (P0-1/2/3/4), f931f935 (P0-6), 2dd09f99 (P0-2/3 invariants),
// b907c235 (P0-5 partial via root-cause-auditor).
const seedEntries: readonly SeedEntry[] = [
  {
    id: 'P0-CRITICAL-001',
    severity: 'CRITICAL',
    state: 'RESOLVED',
    title: 'createTenantQueryKey signature inverted in layer-1-react.md (would produce cross-tenant cache bleed via TEACHER output)',
    layer: 1,
    evidence: [
      '.claude/knowledge/layer-1-react.md:36',
      'web/shared-ui/src/utils/tenant-query-keys.ts:39',
    ],
    rule_violated: 'SSoT claim must match real code signature (Layer-1 React anchor)',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: '2026-04-16T18:00:00Z',
    closing_commits: ['32839e24'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Closed by Phase 0 commit. Regression guard: tests/invariants/knowledge-ssot.spec.ts (2dd09f99) asserts the signature on every PR.',
  },
  {
    id: 'P0-HIGH-002',
    severity: 'HIGH',
    state: 'RESOLVED',
    title:
      'Orchestrator routing table missing 13+ repo paths (apps/db-migrate, libs/shared-contracts, scripts/**, docs/**, tools/gates, .claude/skills, CLAUDE.md, etc.)',
    layer: 3,
    evidence: [
      '.claude/agents-enterprise-v2/orchestrator.md:105',
      'apps/db-migrate/project.json:1',
      'libs/shared-contracts/package.json:1',
    ],
    rule_violated:
      'Orchestrator self-rule: "Every changed file MUST map to at least one primary agent"',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: '2026-04-16T18:30:00Z',
    closing_commits: ['32839e24', '2dd09f99'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'CI-locked by tests/invariants/orchestrator-routing-coverage.spec.ts (67 repo-surface assertions).',
  },
  {
    id: 'P0-HIGH-003',
    severity: 'HIGH',
    state: 'RESOLVED',
    title:
      'Three primary-ownership conflicts (platform/libs/outbox, libs/backend-common/src/database, libs/backend-common/src/redis) break pair-review invariant',
    layer: 3,
    evidence: [
      '.claude/agents-enterprise-v2/data-expert.md:34',
      '.claude/agents-enterprise-v2/messaging-expert.md:32',
      '.claude/agents-enterprise-v2/multi-tenant-saas-expert.md:33',
      '.claude/agents-enterprise-v2/_shared/operating-modes.md:39',
    ],
    rule_violated:
      '_shared/operating-modes.md pair-review invariant (TEACHER and WRITER for the same surface must be different agents)',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: '2026-04-16T18:30:00Z',
    closing_commits: ['32839e24', '2dd09f99'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Introduced primary/secondary/delegated grammar in handoff-protocol.md. CI-locked by tests/invariants/agent-ownership-uniqueness.spec.ts. Also discovered a fourth conflict (sensorprotocols/** edge-expert vs sensor-expert) caught by the invariant and fixed in 2dd09f99.',
  },
  {
    id: 'P0-MEDIUM-004',
    severity: 'MEDIUM',
    state: 'RESOLVED',
    title:
      'CLAUDE.md service count (15) and layer-3-adrs.md misfiled-ADR count (4) drifted from real repo (16 and 5 respectively)',
    layer: 3,
    evidence: [
      'CLAUDE.md:51',
      '.claude/knowledge/layer-3-adrs.md:31',
      'apps/db-migrate:1',
      'docs/architecture/ADR-010-AI-REVIEW.md:1',
    ],
    rule_violated: 'Knowledge SSoT numerical claims must match real state',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: '2026-04-16T18:30:00Z',
    closing_commits: ['32839e24', '2dd09f99'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'CI-locked by tests/invariants/knowledge-ssot.spec.ts (5 concrete claim assertions including service count and ADR count).',
  },
  {
    id: 'P0-HIGH-005',
    severity: 'HIGH',
    state: 'IN-PROGRESS',
    title:
      '21 phantom artefacts referenced by agent prompts but missing from repo (tools/gates/*, .claude/skills/*, root-cause-auditor, registry, 5 invariant tests, 2 workflows)',
    layer: 3,
    evidence: [
      '.claude/agents-enterprise-v2/_shared/tier-claim-syntax.md:3',
      '.claude/agents-enterprise-v2/_shared/handoff-protocol.md:7',
      '.claude/agents-enterprise-v2/data-expert.md:1',
    ],
    rule_violated:
      'Agent prompts must reference real infrastructure, not future W-N deliverables as if present',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: null,
    closing_commits: ['b907c235'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Partial: root-cause-auditor agent landed (b907c235, Phase 5). Remaining phantoms tracked via abstract-brewing-mochi plan Phase 2 (tools/gates), Phase 3 (.claude/skills), Phase 6 (registry seeded by this commit), Phase 7 (workflows). State will transition to RESOLVED when all phases complete.',
  },
  {
    id: 'P0-HIGH-006',
    severity: 'HIGH',
    state: 'RESOLVED',
    title:
      'Three parallel agent directories (agents/, agents-enterprise-v2/, test-agents/) with colliding `name:` frontmatter produced undefined dispatch behaviour',
    layer: 3,
    evidence: ['.claude/settings.json:1'],
    rule_violated: 'Single-source agent loader discipline',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: '2026-04-16T18:15:00Z',
    closing_commits: ['f931f935'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Legacy .claude/agents/ renamed to .claude/agents.legacy/ (git mv preserved history). 30-day grace period before deletion (after 2026-05-16). test-agents/ untouched (orthogonal product-E2E concern). CI-locked by orchestrator-routing-coverage.spec.ts which asserts archived dir is marked ARCHIVED not dispatched.',
  },
  {
    id: 'P0-HIGH-007',
    severity: 'HIGH',
    state: 'OPEN',
    title: '10 enterprise-v2 agents exceed the 200-line conversion cap (W3 conversion wave in-flight)',
    layer: 3,
    evidence: [
      '.claude/agents-enterprise-v2/security-reviewer.md:1',
      '.claude/agents-enterprise-v2/_shared/_conversion-template.md:71',
    ],
    rule_violated: '_shared/_conversion-template.md hard cap: ≤200 lines per agent file',
    owner_agent: 'prompt-writer',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Over-cap agents: security-reviewer (317), orchestrator (308), implementation-planner (279), frontend-expert (246), platform-services (218), hr-expert (197), database-reviewer (192), context-manager (184), admin-expert (177), prompt-writer (175). W3 conversion wave in-flight on branch agentic; parallel session is converting data-expert and infra-expert. Remaining 8 agents tracked in abstract-brewing-mochi.md Phase 1.',
  },
  {
    id: 'COMPLIANCE-CRITICAL-001',
    severity: 'CRITICAL',
    state: 'OPEN',
    title:
      'GDPR Art 17 tenant erasure cascade absent across 10 tenant-data services (was MT-CRITICAL-003; transferred to compliance-expert in Phase 9.1)',
    layer: 3,
    evidence: [
      '.claude/agents-enterprise-v2/multi-tenant-saas-expert.md:46',
      '.claude/agents-enterprise-v2/compliance-expert.md:48',
    ],
    rule_violated:
      'GDPR Art 17 right-to-erasure cascade fan-out across all tenant-data-bearing services',
    owner_agent: 'compliance-expert',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T14:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Renamed from MT-CRITICAL-003 on 2026-04-16 when ownership transferred from multi-tenant-saas-expert to compliance-expert (Phase 9.1 of abstract-brewing-mochi). 0 grep hits for `eraseTenantData`, `TenantErased`, `TenantPurged` anywhere in repo. Fan-out targets: farm, sensor, hr, messaging, ai, billing, notification, hydroponics, alert-engine, admin-api (10 services minimum). Closer: gdpr-erasure-executor agent (Phase 9.2 sibling, pending) implements per-service handlers; compliance-expert reviews. Legal-hold precedence enforced by legal-hold-auditor (Phase 9.4 sibling, pending). Hash-signed proof event TenantErased mandatory.',
  },
  {
    id: 'PROC-MEDIUM-001',
    severity: 'MEDIUM',
    state: 'RESOLVED',
    title:
      'Phase 0-7 commit messages used bare "deferred" without strict owner+deadline+finding-ID format (caught by banned-phrase gate when activated)',
    layer: 3,
    evidence: ['tools/gates/banned-phrase.ts:97'],
    rule_violated: 'CLAUDE.md Architectural Approach banned-phrase contract for "deferred"',
    owner_agent: 'orchestrator',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-16T19:00:00Z',
    closed_at: '2026-04-16T19:30:00Z',
    closing_commits: ['47bea207'],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Self-discovered finding: banned-phrase gate (Phase 2 deliverable, commit 47bea207) flagged 2 of my own pre-Phase-2 commits using bare "deferred". Resolution: (a) gate accepts plan-phase references (Phase N, W-N, abstract-brewing-mochi, declarative-riding-shamir) as valid tracking, (b) PRE_GATE_SHAS allowlist exempts pre-Phase-2 commits since amending is forbidden, (c) future commits MUST include explicit plan reference per the extended allowIf regex.',
  },
  {
    id: 'PROC-MEDIUM-002',
    severity: 'MEDIUM',
    state: 'RESOLVED',
    title:
      'Introduced UNVERIFIED actions/setup-node SHA in closes-footer-check.yml (Phase 2 landing commit) — infra-expert supply-chain rule violation',
    layer: 3,
    evidence: ['.github/workflows/closes-footer-check.yml:32'],
    rule_violated:
      'infra-expert GHA supply-chain rule: every `uses:` MUST reference a verified 40-char commit SHA; inventing or guessing a SHA is equivalent to a floating tag reference (CRITICAL class, 2026-03 aquasecurity/trivy-action precedent)',
    owner_agent: 'infra-expert',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-17T07:30:00Z',
    closed_at: '2026-04-17T07:35:00Z',
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      "Self-discovered within the same session: wrote `49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0` as the setup-node pin without cross-checking the GitHub release page. The repo's other 5 workflows already pin `39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0`. Architectural fix: converge every workflow onto a single pinned SHA so dependabot github-actions rotation is one PR, divergence is visible at review. Tier-3 automation: infra-expert `require_pinned_sha` invariant (planned W5) would structurally catch an unresolvable SHA; manual catch here is the Tier-4 backstop until that invariant lands.",
  },
  {
    id: 'PROC-MEDIUM-004',
    severity: 'MEDIUM',
    state: 'RESOLVED',
    title:
      'Pre-existing CI failures on agentic: gitleaks-action v2 missing GITHUB_TOKEN + lighthouse-ci-action SHA 2f8dda0c does not resolve',
    layer: 3,
    evidence: [
      '.github/workflows/security-gitleaks.yml:34',
      '.github/workflows/performance-benchmark.yml:52',
    ],
    rule_violated:
      'infra-expert GHA rule: every `uses:` must pin a verified commit SHA; every pre-existing workflow must remain functional after a CI-visibility-restoring sweep',
    owner_agent: 'infra-expert',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-17T08:55:00Z',
    closed_at: '2026-04-17T09:00:00Z',
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Two pre-existing broken CI workflows caught during the Phase-2 self-audit sweep. (a) security-gitleaks.yml: the pinned gitleaks-action v2.3.9 introduced a BREAKING CHANGE requiring GITHUB_TOKEN in env for PR scans — our workflow never set it, and the gate had been silently failing on every PR since the v2 bump. Fix: add `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to the step env. (b) performance-benchmark.yml: the pinned treosh/lighthouse-ci-action SHA `2f8dda0cf82e7b8f5b3e1e7d0dd88b9e35d5c2d4` does NOT resolve at upstream — "unable to find version" error. The comment said `# v11.4.0`, so resolved via `gh api repos/treosh/lighthouse-ci-action/git/refs/tags/11.4.0` then resolved annotated tag → underlying commit SHA `1b0e7c33270fbba31a18a0fbb1de7cc5256b6d39`. Same mistake class as PROC-MEDIUM-002 — lesson: SHAs go through `gh api` verification, never transcribe from memory. Separate pre-existing failures NOT closed here: dependency-review (needs GH Advanced Security enabled at repo level — admin action), ci-affected.yml Nx graph check (NX native-binding failure with --ignore-scripts — separate investigation class, potentially caused by `@nx/eslint/plugin` not rebuilding postinstall due to the security flag).',
  },
  {
    id: 'PROC-MEDIUM-003',
    severity: 'MEDIUM',
    state: 'RESOLVED',
    title:
      'Phase-2 workflow regressions: (a) closes-footer-check.yml bare colon in YAML step name, (b) quality-gates.yml + closes-footer-check.yml missed --legacy-peer-deps convention',
    layer: 3,
    evidence: [
      '.github/workflows/closes-footer-check.yml:58',
      '.github/workflows/quality-gates.yml:49',
    ],
    rule_violated:
      'infra-expert CI rule: every `npm ci` in the repo uses `--legacy-peer-deps --ignore-scripts --no-audit` (convergent convention across ci-full.yml, ci-affected.yml, deploy-*.yml, e2e-*.yml). YAML step names containing `: ` MUST be quoted.',
    owner_agent: 'infra-expert',
    raised_in_cycle: AUDIT_CYCLE,
    review_file: AUDIT_FILE,
    created_at: '2026-04-17T08:10:00Z',
    closed_at: '2026-04-17T08:15:00Z',
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    notes:
      'Root-cause analysis: (a) YAML bug was latent in the Phase 6 closes-footer-check.yml landing (7090c9509) — the step name "Validate Closes: trailers" was never exercised because the file never triggered on PR against main/develop from agentic. My Phase-2 edit to the same file (daed8ae8) caused GH to re-validate the workflow on push, surfacing the latent colon-in-name error. (b) The missing --legacy-peer-deps flag was a net-new regression in my Phase-2 landing — I did not look at the repo-wide convention before writing the `npm ci --ignore-scripts --no-audit --no-fund` command. Both are Tier-4 Document-it-then-automate class: detection belongs in a `lint-workflow-convergence` invariant (planned W5 sibling of require_pinned_sha) that would structurally enforce every new workflow to match the flag set. Separate pre-existing failures NOT closed here: gitleaks-action (token missing), dependency-review-action (GH Advanced Security disabled), lighthouse-ci-action SHA 404, Nx project-count check failing on CI — each is its own finding class, unrelated to Phase 2.',
  },
];

function canonicalJson(value: unknown): string {
  // Key-sorted JSON without whitespace (canonical form for hashing).
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');

  if (existsSync(REGISTRY)) {
    const existing = readFileSync(REGISTRY, 'utf8').trim();
    if (existing.length > 0) {
      console.error(`Registry already seeded (${existing.split('\n').length} entries present).`);
      console.error(`Refusing to overwrite. Delete ${REGISTRY} manually to re-seed.`);
      process.exit(1);
    }
  }

  const lines: string[] = [];
  let prevHash = '0'.repeat(64);

  for (const draft of seedEntries) {
    const entry = { ...draft, prev_hash: prevHash };
    // content_hash = sha256(canonical JSON of entry WITHOUT content_hash field).
    // Destructure defensively so the hashing contract matches
    // tools/gates/finding-registry.ts even if `draft` shape evolves.
    const { content_hash: _omit, ...forHash } = entry as typeof entry & {
      content_hash?: string;
    };
    const hash = sha256hex(canonicalJson(forHash));
    const final: ChainedEntry = { ...entry, content_hash: hash };
    lines.push(JSON.stringify(final));
    prevHash = hash;
  }

  const output = lines.join('\n') + '\n';

  if (dryRun) {
    console.log(output);
    return;
  }

  writeFileSync(REGISTRY, output, 'utf8');
  console.log(`Seeded ${seedEntries.length} entries to ${REGISTRY}.`);
  console.log(`Final chain tip: ${prevHash}`);
}

main();
