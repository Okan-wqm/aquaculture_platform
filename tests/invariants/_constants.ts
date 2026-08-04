/**
 * Single source of truth for schema-owning services.
 *
 * Every service in SCHEMA_OWNING_SERVICES:
 *   1. Owns a Postgres schema declared on @Entity({ schema: '<name>' }) per ADR-011.
 *   2. MUST register SchemaDriftModule.forRoot({ serviceName }) in its AppModule per ADR-012.
 *   3. Is enforced by tests/invariants/adoption-invariants.spec.ts (BLOCKER-8, Round 3).
 *
 * Services in SCHEMALESS_SERVICES do not own a schema (pure API gateway or
 * observability aggregator); adoption invariants skip them.
 *
 * Historical note: Round-2 review (2026-04-16) incorrectly listed 9 services.
 * Round-3 ground-truth pass against CLAUDE.md Architecture Map confirmed 13.
 * Pre-existing ADR-011 violations to fix in W2: event-store-service and
 * config-service have @Entity() classes without schema: option.
 *
 * See /root/.claude/plans/declarative-riding-shamir.md BLOCKER-8 for context.
 */

import { execSync } from 'node:child_process';

export const SCHEMA_OWNING_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'alert-engine',
  'auth-service',
  'billing-service',
  'admin-api-service',
  'event-store-service',
  'ai-service',
  'config-service',
  'notification-service',
  // observability-service: promoted from SCHEMALESS to SCHEMA_OWNING
  // 2026-04-29. The service owns the `observability` schema (cost
  // rollup hypertable, migration-events, schema-object history,
  // emergency overrides, migration backfill progress) and registers
  // SchemaDriftModule.forRoot({ serviceName: 'observability' }) in
  // its AppModule. The previous SCHEMALESS classification was a
  // Round-3 miss; observability has had its own entities + migrations
  // on disk for several cycles.
  'observability-service',
] as const;

export type SchemaOwningService = (typeof SCHEMA_OWNING_SERVICES)[number];

export const SCHEMALESS_SERVICES = [
  // Gateway-api is the only true schemaless service — it terminates
  // external traffic, runs the auth guard / rate limit / CSP / OPA
  // pipeline, and proxies to schema-owning subgraphs. No @Entity()
  // anywhere under apps/gateway-api/src.
  'gateway-api',
] as const;

export type SchemalessService = (typeof SCHEMALESS_SERVICES)[number];

/**
 * Per-tenant schema services: schemas are provisioned once per tenant
 * during provision-tenant skill execution. Distinct from the full
 * SCHEMA_OWNING_SERVICES set — auth/billing/admin/event-store/config/
 * notification own cross-tenant schemas, not per-tenant.
 *
 * Cited by CLAUDE.md Architecture Map and enforced by provision-tenant skill.
 */
export const PER_TENANT_SCHEMA_SERVICES = [
  'farm-service',
  'sensor-service',
  'hr-service',
  'messaging-service',
  'hydroponics-service',
  'alert-engine',
  'ai-service',
] as const;

export type PerTenantSchemaService = (typeof PER_TENANT_SCHEMA_SERVICES)[number];

/**
 * Runtime assertion helpers — callers can narrow a string at the boundary
 * without importing Zod or duplicating the list.
 */
export function isSchemaOwningService(s: string): s is SchemaOwningService {
  return (SCHEMA_OWNING_SERVICES as readonly string[]).includes(s);
}

export function isPerTenantSchemaService(s: string): s is PerTenantSchemaService {
  return (PER_TENANT_SCHEMA_SERVICES as readonly string[]).includes(s);
}

/**
 * Files that live under .claude/agents/** but are NOT dispatchable agents —
 * README indices, operational runbooks. Used by multiple invariant specs
 * (active-path-hygiene, doc-cardinality) to filter file-count enumerations.
 */
export const NON_AGENT_FILES = ['README.md', 'INVOCATION-PACK.md'] as const;

/**
 * Active agent dispatch directories — Claude Code CLI auto-discovers
 * `.claude/agents/**\/*.md` and keys on `name:` frontmatter. Lane-A at root,
 * Lane-B under product-audit/. Retired prompt directories are deleted rather
 * than archived because stale copies duplicate names and output contracts.
 */
export const ACTIVE_AGENT_DIRS = [
  '.claude/agents',
  '.claude/agents/product-audit',
] as const;

/**
 * File globs subject to active-path hygiene checks (cross-reference
 * integrity + legacy terminology ban). Historical/archival paths are
 * excluded by ACTIVE_PATH_EXEMPT_GLOBS.
 */
export const ACTIVE_HYGIENE_PATHS = [
  '.claude/agents',
  '.claude/agents/product-audit',
  '.claude/shared',
  '.claude/knowledge',
  '.claude/skills',
] as const;

/**
 * Root-level files also subject to hygiene checks.
 */
export const ACTIVE_HYGIENE_ROOT_FILES = [
  '.claude/README.md',
  'CLAUDE.md',
] as const;

/**
 * Tokens banned in active paths. Each represents a pre-flatten or pre-CLI
 * artifact whose re-appearance in live docs signals drift.
 */
export const DEAD_TERMINOLOGY_TOKENS = [
  'test-agents',
  'agents-enterprise-v2',
  'agents.legacy',
  'npx claude-agent',
  'tools/scripts/orchestrator-runner',
  'platform-services',
] as const;

/**
 * Evidence-path prefixes recorded in `docs/reviews/_registry/findings.jsonl`
 * that predate the 2026-04-18 flatten. The sidecar
 * `docs/reviews/_registry/path-corrections.yaml` maps each to its current
 * equivalent; finding-registry-integrity.spec.ts asserts every dead-prefix
 * evidence has a sidecar entry.
 */
export const DEAD_EVIDENCE_PATH_PREFIXES = [
  '.claude/agents-enterprise-v2/',
  '.claude/test-agents/',
] as const;

/**
 * Dynamic placeholder names that appear inline in agent body prose but
 * resolve at runtime rather than to a static agent file. Treated as valid
 * by active-path-hygiene cross-reference integrity check.
 */
export const DYNAMIC_AGENT_PLACEHOLDERS = [
  'respective-domain-expert',
  'respective-producer-agent',
  'all-consumers',
  'all-frontend',
  'primary-destructive-handler-owner',
  'cross-cutting',
  'read-only',
  'maintenance-only',
  'no-dispatch',
] as const;

/**
 * Steering-file discovery, shared by every spec that validates CLAUDE.md /
 * AGENTS.md content.
 *
 * Lists TRACKED plus UNTRACKED-not-ignored files, so a brand-new nested
 * CLAUDE.md is covered by the invariants before it is ever committed.
 * Worktree copies are byte-identical checkouts of other branches and would
 * double-report every finding, so they are excluded.
 *
 * Promoted here from claude-md-accuracy.spec.ts when nested-steering-parity
 * became a second consumer: two hand-maintained copies of a discovery rule
 * is the same copied-SSoT defect these specs exist to catch.
 */
export const STEERING_EXCLUDED_DIR_RX =
  /(^|\/)(\.worktrees|\.codex-worktrees|\.claude\/worktrees|node_modules)\//;

export function discoverSteeringFiles(repoRoot: string): string[] {
  const gitList = (cmd: string): string[] => {
    try {
      return execSync(cmd, { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const all = [
    ...gitList('git ls-files'),
    ...gitList('git ls-files --others --exclude-standard'),
  ];
  return [...new Set(all)].filter(
    (f) =>
      (/(^|\/)CLAUDE\.md$/.test(f) || f === 'AGENTS.md') &&
      !STEERING_EXCLUDED_DIR_RX.test(f),
  );
}
