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

import { resolve } from 'path';

// Resolve the invariant-dir relative to cwd when jest is invoked with
// `--config tests/invariants/jest.config.ts`. Avoids `__dirname` which
// is not defined when ts-jest transpiles as ESM under newer Node/Jest.
const INVARIANT_DIR = resolve(process.cwd(), 'tests/invariants');

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
  },
  transform: baseTransform,
};

export default {
  displayName: 'invariants',
  rootDir: INVARIANT_DIR,
  passWithNoTests: false,
  projects: [
    {
      ...commonProjectOptions,
      displayName: 'layer-1',
      testMatch: [
        '<rootDir>/knowledge-ssot.spec.ts',
        '<rootDir>/finding-registry-integrity.spec.ts',
        '<rootDir>/finding-evidence-shape.spec.ts',
        '<rootDir>/upcaster-chain.spec.ts',
        '<rootDir>/lib-creation-rubric.spec.ts',
        '<rootDir>/messaging-joins.spec.ts',
        '<rootDir>/messaging-migration-runner.spec.ts',
        '<rootDir>/admin-api-schema-boundaries.spec.ts',
        '<rootDir>/eslint-rule-presence.spec.ts',
        '<rootDir>/eslint-disable-annotation-positional-binding.spec.ts',
        '<rootDir>/no-direct-getrepository-call.spec.ts',
        '<rootDir>/no-root-barrel-import.spec.ts',
        '<rootDir>/no-shared-entity-decorators-via-main-barrel.spec.ts',
        '<rootDir>/graphql-enum-valuesmap-metadata.spec.ts',
        '<rootDir>/messaging-schema-ssot.spec.ts',
        '<rootDir>/messaging-e2e-tenant-context.spec.ts',
        '<rootDir>/web-shared-ui-singleton-imports.spec.ts',
        '<rootDir>/federation-shared-singleton.spec.ts',
        '<rootDir>/web-remotes-no-nested-queryclient.spec.ts',
        '<rootDir>/web-no-raw-graphql-rest-fetch.spec.ts',
        '<rootDir>/web-usetenantquery-adoption-ratchet.spec.ts',
        '<rootDir>/web-no-createtenantquerykey-in-invalidate.spec.ts',
        '<rootDir>/web-no-hand-rolled-modal-shell.spec.ts',
        '<rootDir>/restore-mutation-tenant-admin.spec.ts',
        '<rootDir>/backup-production-secrets.spec.ts',
        '<rootDir>/deploy-ssot-contract.spec.ts',
        '<rootDir>/deploy-isolated-checkout-ssot.spec.ts',
        '<rootDir>/script-graphql-client-ssot.spec.ts',
        '<rootDir>/graphql-fe-drift-baseline-no-grow.spec.ts',
        '<rootDir>/production-ops-proof-contract.spec.ts',
        '<rootDir>/admin-billing-runtime-contract.spec.ts',
        '<rootDir>/admin-security-runtime-contract.spec.ts',
        '<rootDir>/plan-limits-ssot.spec.ts',
        '<rootDir>/plan-features-ssot.spec.ts',
        '<rootDir>/event-contract-date-iso-ssot.spec.ts',
        '<rootDir>/shared-contracts-no-enum-drift.spec.ts',
        '<rootDir>/config-env-access-ratchet.spec.ts',
        '<rootDir>/messaging-unread-count-ssot.spec.ts',
        '<rootDir>/metrics-service-module-ratchet.spec.ts',
        '<rootDir>/stripe-calls-via-canonical-client.spec.ts',
        '<rootDir>/plan-quota-enforcement.spec.ts',
        '<rootDir>/nats-config-ssot.spec.ts',
        '<rootDir>/rls-exclude-tables-ssot.spec.ts',
        '<rootDir>/sensor-ingestion-honest-deployment.spec.ts',
        '<rootDir>/rbac-vocabulary-ssot.spec.ts',
        '<rootDir>/tenant-provisioning-ssot.spec.ts',
        '<rootDir>/repo-hygiene-invariants.spec.ts',
        '<rootDir>/enterprise-grade-debt-plan-contract.spec.ts',
        '<rootDir>/stabilization-manifest.spec.ts',
        '<rootDir>/runtime-lifecycle-timer-ssot.spec.ts',
        '<rootDir>/mobile-csp-headers.spec.ts',
      ],
    },
    {
      ...commonProjectOptions,
      displayName: 'layer-3',
      testMatch: [
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
        '<rootDir>/farm-stock-mutation-central-only.spec.ts',
        '<rootDir>/farm-wq-template-nondestructive-ssot.spec.ts',
        '<rootDir>/farm-event-handler-tenant-context-ssot.spec.ts',
        '<rootDir>/farm-no-mock-data-growth-ssot.spec.ts',
        '<rootDir>/farm-identity-ssot.spec.ts',
        '<rootDir>/farm-rest-cqrs-ssot.spec.ts',
        '<rootDir>/farm-graphql-fe-be-parity.spec.ts',
        '<rootDir>/farm-graphql-resolver-field-uniqueness.spec.ts',
        '<rootDir>/dead-contract-fe-operations.spec.ts',
        '<rootDir>/farm-batch-policy-transaction-ssot.spec.ts',
        '<rootDir>/farm-stock-mutation-ssot.spec.ts',
        '<rootDir>/farm-minio-orphan-cleanup-ssot.spec.ts',
        '<rootDir>/stock-mutating-handlers-reject-legacy.spec.ts',
        '<rootDir>/farm-site-system-eventing-transaction-ssot.spec.ts',
        '<rootDir>/sites-setup-remediation-plan-contract.spec.ts',
        '<rootDir>/strip-internal-headers-mounted.spec.ts',
        '<rootDir>/verified-user-assertion-mounted.spec.ts',
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
      ],
    },
    {
      ...commonProjectOptions,
      displayName: 'registry',
      testMatch: [
        '<rootDir>/adoption-invariants.spec.ts',
        '<rootDir>/authoritative-runtime-ddl-contract.spec.ts',
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
        '<rootDir>/postgres-ddl-contract.spec.ts',
        '<rootDir>/postgres-image-uniformity.spec.ts',
        '<rootDir>/postgres-runtime-contract.spec.ts',
        '<rootDir>/service-criticality-profile-contract.spec.ts',
        '<rootDir>/deploy-startup-budget-ssot.spec.ts',
        '<rootDir>/edge-v2-plan-contract.spec.ts',
        '<rootDir>/platform-service-catalog-parity.spec.ts',
        '<rootDir>/farm-service-migration-array-completeness.spec.ts',
        '<rootDir>/three-store-invariants.spec.ts',
        '<rootDir>/protected-tables-guard.spec.ts',
        '<rootDir>/no-savepoint-in-migrations.spec.ts',
        '<rootDir>/rls-predicate-canonical.spec.ts',
        '<rootDir>/entity-schema-declaration.spec.ts',
        '<rootDir>/entity-diff-implies-migration.spec.ts',
        '<rootDir>/tenant-fanout-entity-parity.spec.ts',
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
      ],
    },
  ],
};
