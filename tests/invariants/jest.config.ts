/**
 * Jest config for `tests/invariants/**` — always-on invariant suite.
 *
 * Runs under Nx via `nx test invariants` (see sibling project.json).
 * Not scoped by `nx affected` — these invariants must run on every PR,
 * not only when code under the invariant's scope happens to change,
 * because the invariant surface itself (e.g., which services are
 * schema-owning) is cross-cutting and drift detection requires
 * unconditional execution.
 *
 * =============================================================================
 * Phase 14.3 sharding (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.3):
 *
 * Pre-phase-14 the suite ran sequentially at ~18-23s wall time. The
 * two heavy specs (orchestrator-routing-coverage at ~14s and
 * agent-ownership-uniqueness at ~10s) serialize ts-jest compile cost.
 * Splitting into 3 Jest `projects` + `--maxWorkers=3` parallelises
 * compilation across shards and takes wall time to max(heavy-spec)
 * + startup ≈ ~13-15s, meeting the `invariants:fast` <15s SLO.
 *
 * Shard assignment:
 *
 *   layer-1 (knowledge SSoT + registry integrity):
 *     - knowledge-ssot.spec.ts
 *     - finding-registry-integrity.spec.ts
 *     - upcaster-chain.spec.ts
 *
 *   layer-3 (routing + ownership):
 *     - orchestrator-routing-coverage.spec.ts
 *     - agent-ownership-uniqueness.spec.ts
 *
 *   registry (adoption + cross-cutting SSoT consumers):
 *     - adoption-invariants.spec.ts
 *
 * Rationale: heavy specs are split across layer-3 to pair the slowest
 * (~14s) spec with the next-slowest (~10s) so neither shard idles.
 * layer-1 bundles the 3 fastest specs (each < 1s) which individually
 * would under-use a shard. registry shard owns adoption-invariants
 * alone because adoption probes the app.module.ts of every schema-
 * owning service (large AST read surface) and benefits from isolation.
 *
 * A new spec goes in whichever shard its subject matter lives in;
 * if a shard's wall time crosses ~12s, rebalance by promoting the
 * heaviest member of that shard to its own shard.
 *
 * Every project sets `rootDir: __dirname` explicitly and scopes
 * `testMatch` to files inside this directory only. Without this,
 * jest-haste-map scans the repo root (104k+ files under worktrees/
 * and node_modules shadows) and takes >60s before even starting.
 *
 * Plan ref: /root/.claude/plans/declarative-riding-shamir.md D.2
 *           docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.3
 * =============================================================================
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Resolve the invariant-dir relative to cwd when jest is invoked with
// `--config tests/invariants/jest.config.ts`. Avoids `__dirname` which
// is not defined when ts-jest transpiles as ESM under newer Node/Jest.
const INVARIANT_DIR = resolve(process.cwd(), 'tests/invariants');

/**
 * Shard membership, declared once and consumed by all three projects.
 *
 * `layer-3` and `registry` are EXPLICIT because their membership is a wall-time
 * balancing decision (the two slowest specs are paired so neither shard idles).
 * `layer-1` is a GLOB over everything else, so a new spec joins the suite by
 * existing rather than by being remembered in a second place.
 */
const LAYER_3_SPECS: string[] = [
  '<rootDir>/orchestrator-routing-coverage.spec.ts',
  '<rootDir>/agent-ownership-uniqueness.spec.ts',
  '<rootDir>/agent-name-uniqueness.spec.ts',
  '<rootDir>/agent-size-limit.spec.ts',
  '<rootDir>/agent-frontmatter-schema.spec.ts',
  '<rootDir>/agent-doc-shape.spec.ts',
  '<rootDir>/agent-inlining-ssot.spec.ts',
  '<rootDir>/maintenance-isolation.spec.ts',
  '<rootDir>/settings-hook-coverage.spec.ts',
  '<rootDir>/active-path-hygiene.spec.ts',
  '<rootDir>/doc-cardinality.spec.ts',
  '<rootDir>/skills-catalog.spec.ts',
  '<rootDir>/boundary-allowlist-invariants.spec.ts',
  '<rootDir>/farm-service-tenant-isolation.spec.ts',
  '<rootDir>/farm-read-boundary-ssot.spec.ts',
  '<rootDir>/farm-outbox-publish-ssot.spec.ts',
  '<rootDir>/farm-count-single-writer.spec.ts',
  '<rootDir>/farm-tank-count-ssot.spec.ts',
  '<rootDir>/farm-stock-mutation-central-only.spec.ts',
  '<rootDir>/farm-wq-template-nondestructive-ssot.spec.ts',
  '<rootDir>/farm-event-handler-tenant-context-ssot.spec.ts',
  '<rootDir>/farm-no-mock-data-growth-ssot.spec.ts',
  '<rootDir>/farm-identity-ssot.spec.ts',
  '<rootDir>/farm-rest-cqrs-ssot.spec.ts',
  '<rootDir>/farm-graphql-fe-be-parity.spec.ts',
  '<rootDir>/hr-graphql-fe-be-parity.spec.ts',
  '<rootDir>/farm-graphql-enum-parity.spec.ts',
  '<rootDir>/farm-graphql-resolver-field-uniqueness.spec.ts',
  '<rootDir>/dead-contract-fe-operations.spec.ts',
  '<rootDir>/farm-batch-policy-transaction-ssot.spec.ts',
  '<rootDir>/farm-stock-mutation-ssot.spec.ts',
  '<rootDir>/farm-minio-orphan-cleanup-ssot.spec.ts',
  '<rootDir>/stock-mutating-handlers-reject-legacy.spec.ts',
  '<rootDir>/feeding-legacy-cutover-gate.spec.ts',
  '<rootDir>/feeding-v1-retired-symbols.spec.ts',
  '<rootDir>/farm-site-system-eventing-transaction-ssot.spec.ts',
  '<rootDir>/sites-setup-remediation-plan-contract.spec.ts',
  '<rootDir>/strip-internal-headers-mounted.spec.ts',
  '<rootDir>/verified-user-assertion-mounted.spec.ts',
  '<rootDir>/access-log-middleware-mounted.spec.ts',
  '<rootDir>/tenant-execution-context-registered.spec.ts',
  '<rootDir>/tenant-schema-cache-module-registered.spec.ts',
  '<rootDir>/no-default-tenant-storage-key.spec.ts',
  '<rootDir>/farm-cacheable-has-evict.spec.ts',
  '<rootDir>/tenant-context-ssot.spec.ts',
  '<rootDir>/spec-module-mode.spec.ts',
  '<rootDir>/aria-workflow-sha-pin.spec.ts',
  '<rootDir>/aria-workflow-input-injection.spec.ts',
  '<rootDir>/github-actions-tpm-deps-ssot.spec.ts',
  '<rootDir>/aria-plan-doc-presence.spec.ts',
  '<rootDir>/aria-doc-runtime-ssot.spec.ts',
  '<rootDir>/invariant-reachability.spec.ts',
  '<rootDir>/migration-spec-quarantine.spec.ts',
  '<rootDir>/claude-md-accuracy.spec.ts',
  '<rootDir>/agent-prompt-accuracy.spec.ts',
  '<rootDir>/farm-service-security-hardening.spec.ts',
  '<rootDir>/tenant-erasure-ssot.spec.ts',
  '<rootDir>/agent-prompt-contract.spec.ts',
  '<rootDir>/graphql-operation-limit-ssot.spec.ts',
];

const REGISTRY_SPECS: string[] = [
  '<rootDir>/adoption-invariants.spec.ts',
  '<rootDir>/workflow-npm-script-references.spec.ts',
  '<rootDir>/git-hook-binding.spec.ts',
  '<rootDir>/billing-money-decimal-coexistence.spec.ts',
  '<rootDir>/tenant-permission-guard-adoption.spec.ts',
  '<rootDir>/sensor-enum-fe-be-parity.spec.ts',
  '<rootDir>/sensor-no-forged-user-payload.spec.ts',
  '<rootDir>/sensor-single-write-path.spec.ts',
  '<rootDir>/sensor-parameter-catalog-ssot.spec.ts',
  '<rootDir>/authoritative-runtime-ddl-contract.spec.ts',
  '<rootDir>/source-schema-write-guard-ssot.spec.ts',
  '<rootDir>/no-runtime-synchronize.spec.ts',
  '<rootDir>/required-signals-vs-emitters.spec.ts',
  '<rootDir>/all-services-env-aware-migrations.spec.ts',
  '<rootDir>/migration-registration-completeness.spec.ts',
  '<rootDir>/migration-glob-contract.spec.ts',
  '<rootDir>/migration-immutability.spec.ts',
  '<rootDir>/db-migrate-entity-metadata-contract.spec.ts',
  '<rootDir>/metrics-endpoint-adoption.spec.ts',
  '<rootDir>/monitoring-scrape-catalog-sync.spec.ts',
  '<rootDir>/monitoring-alert-runbook-url.spec.ts',
  '<rootDir>/monitoring-alert-delivery.spec.ts',
  '<rootDir>/postgres-ddl-contract.spec.ts',
  '<rootDir>/postgres-image-uniformity.spec.ts',
  '<rootDir>/postgres-runtime-contract.spec.ts',
  '<rootDir>/service-criticality-profile-contract.spec.ts',
  '<rootDir>/deploy-startup-budget-ssot.spec.ts',
  '<rootDir>/edge-v2-plan-contract.spec.ts',
  '<rootDir>/edge-device-dual-model-guard.spec.ts',
  '<rootDir>/platform-service-catalog-parity.spec.ts',
  '<rootDir>/platform-entity-registry-parity.spec.ts',
  '<rootDir>/farm-service-migration-array-completeness.spec.ts',
  '<rootDir>/three-store-invariants.spec.ts',
  '<rootDir>/protected-tables-guard.spec.ts',
  '<rootDir>/no-savepoint-in-migrations.spec.ts',
  '<rootDir>/rls-predicate-canonical.spec.ts',
  '<rootDir>/entity-schema-declaration.spec.ts',
  '<rootDir>/entity-diff-implies-migration.spec.ts',
  '<rootDir>/tenant-fanout-entity-parity.spec.ts',
  '<rootDir>/finance-currency-ssot.spec.ts',
  '<rootDir>/finance-derived-source-category-parity.spec.ts',
  '<rootDir>/tenant-aware-migration-ddl-guard.spec.ts',
  '<rootDir>/critical-infra-ssot.spec.ts',
  '<rootDir>/infrastructure-ledger-ssot.spec.ts',
  '<rootDir>/admin-backup-encryption-ssot.spec.ts',
  '<rootDir>/timescale-rls-columnstore-contract.spec.ts',
  '<rootDir>/jwt-rs256-only.spec.ts',
  '<rootDir>/messaging-partition-ddl-authority.spec.ts',
  '<rootDir>/single-partition-creator.spec.ts',
  '<rootDir>/shared-schema-canonical.spec.ts',
  '<rootDir>/audit-log-mandatory-shape.spec.ts',
  '<rootDir>/drift-repair-naming.spec.ts',
  '<rootDir>/init-scripts-no-schema-ddl.spec.ts',
  '<rootDir>/toolchain-config-ssot.spec.ts',
  '<rootDir>/strict-property-initialization-ssot.spec.ts',
  '<rootDir>/farm-environment-deployment-contract.spec.ts',
  '<rootDir>/token-revocation-writer-reader-ssot.spec.ts',
];

/**
 * Specs deliberately excluded, read from the dormancy manifest so there is ONE
 * exclusion list rather than a config list and a manifest that can disagree.
 *
 * `invariant-reachability.dormant.json` already existed and already carried
 * owner / reason / expiry per entry, enforced by
 * `invariant-reachability.spec.ts`. What did NOT exist was any comparison of
 * `expires_on` against the clock: the spec asserted the FORMAT of the date and
 * never its meaning, so all 25 waivers sat a month past expiry with the suite
 * green. A waiver whose expiry nothing checks is a waiver with no expiry — the
 * same shape as every other defect on this branch, which is checking the syntax
 * of a thing instead of the thing.
 *
 * The date is load-bearing now, and eighteen of those entries turned out to need
 * no waiver at all: they pass. They were revived rather than re-dated.
 */
const DORMANT_SPECS: string[] = Object.keys(
  JSON.parse(
    readFileSync(resolve(INVARIANT_DIR, 'invariant-reachability.dormant.json'), 'utf8'),
  ) as Record<string, unknown>,
).map((name) => `<rootDir>/${name}`);

const baseTransform = {
  '^.+\\.[tj]s$': [
    'ts-jest',
    {
      tsconfig: resolve(INVARIANT_DIR, 'tsconfig.spec.json'),
      // Skip full type-check on every compile — ts-jest's default
      // project-wide type-check dominates startup (~5s per spec file).
      // The invariant suite's type safety is already enforced by the
      // `type-check` root script (tsc --noEmit platform-wide); this
      // transform needs only syntactic transpilation, owned by
      // tsconfig.spec.json instead of deprecated ts-jest inline config.
    },
  ],
};

const commonProjectOptions = {
  rootDir: INVARIANT_DIR,
  // `roots` pins Jest's file scan to this directory only. Without it
  // jest-haste-map walks up to the repo root and scans ~104k files
  // (worktrees, node_modules shadows) — adds 60+s of cold-start cost
  // per invocation. See commit message for Phase 14.3.
  roots: ['<rootDir>'],
  testEnvironment: 'node' as const,
  moduleFileExtensions: ['ts', 'js', 'html'],
  // schema-manager.service.ts (read by tenant-erasure-ssot.spec) imports the
  // proof-ledger table constant via the @platform/outbox alias; map it so jest
  // resolves the source the same way tsconfig.base paths do at build time.
  moduleNameMapper: {
    '^@platform/outbox$': '<rootDir>/../../platform/libs/outbox/src/index.ts',
    // outbox aliases the platform routing segment from the event contract
    // (SEC-HIGH-159), so the specs that load outbox need the contract resolved.
    '^@platform/event-contracts$': '<rootDir>/../../libs/event-contracts/src/index.ts',
  },
  transform: baseTransform,
};

export default {
  displayName: 'invariants',
  rootDir: INVARIANT_DIR,
  coverageDirectory: resolve(process.cwd(), 'coverage/tests/invariants'),
  passWithNoTests: false,
  projects: [
    {
      ...commonProjectOptions,
      displayName: 'layer-1',
      // DEFAULT SHARD, by glob. Every spec in this directory that the two
      // balanced shards below do not claim runs here.
      //
      // WHY A GLOB AND NOT A LIST. All three shards used explicit file lists,
      // so a spec was IN the suite only if someone remembered to add its name
      // in a second place. Twenty-four did not get remembered: they sat in
      // `tests/invariants/`, were maintained, were read as enforcement, and
      // matched no `testMatch` in any project — they ran under NO command,
      // including `invariants:full` and `nx test invariants`. Measured, not
      // inferred: 204 spec files on disk, 179 in the config, and
      // `jest --listTests` returns exactly 179.
      //
      // That is the ORPHAN-HIGH-455 shape at suite level — a control that
      // exists, is tested, and is not wired where it matters — and it is the
      // fourth enumerated-allowlist defect on this branch after 507's
      // hardcoded roots, 509's single spelling and 510's single gate family.
      // The cure is the same each time: the correct state must be the default.
      // A new spec is now IN the suite because it exists.
      testMatch: ['<rootDir>/*.spec.ts'],
      testPathIgnorePatterns: [...DORMANT_SPECS, ...LAYER_3_SPECS, ...REGISTRY_SPECS],
    },
    {
      ...commonProjectOptions,
      displayName: 'layer-3',
      testMatch: LAYER_3_SPECS,
    },
    {
      ...commonProjectOptions,
      displayName: 'registry',
      testMatch: REGISTRY_SPECS,
    },
  ],
};
