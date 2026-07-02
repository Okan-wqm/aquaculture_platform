# Orchestrator — Phase 1 Routing Table

**Audience:** `orchestrator.md` includes this fragment via `@.claude/shared/orchestrator-routing-table.md`. Tests (`tests/invariants/orchestrator-routing-coverage.spec.ts`) read both `orchestrator.md` AND this file to validate (a) every top-level repo surface has at least one matching glob, (b) every primary agent appearing here is in the runtime roster.

Hand-edit only in orchestrator-maintenance cycles. Adding a new top-level directory requires a new row here + a roster entry in `orchestrator.md` + a `prompt-writer` review.

## Routing Table

Phase 1 maps every changed file to one or more agents via these globs. `git diff --name-only` output is matched against the `File Pattern` column. Primary agent performs the review; Also-Notify agents receive cross-cutting context.

| File Pattern | Primary Agent | Also Notify |
|---|---|---|
| `apps/farm-service/**` | farm-expert | |
| `web/modules/farm-module/**` | farm-expert | |
| `apps/sensor-service/**` | sensor-expert | |
| `web/modules/sensor-module/**` | sensor-expert | |
| `apps/hr-service/**` | hr-expert | |
| `web/modules/hr-module/**` | hr-expert | |
| `apps/admin-api-service/**` | admin-expert | |
| `web/modules/admin-panel/**` | admin-expert | |
| `web/modules/tenant-admin/**` | admin-expert | |
| `apps/messaging-service/**` | messaging-expert | |
| `apps/ai-service/**` | ai-safety-auditor | messaging-expert (chat persistence) |
| `apps/auth-service/**` | auth-security-expert | security-reviewer |
| `apps/gateway-api/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/auth/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/guards/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/security/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/middleware/**` | auth-security-expert | security-reviewer |
| `libs/backend-common/src/audit/**` | auth-security-expert | |
| `libs/backend-common/src/config/**` | platform-kernel-expert | infra-expert |
| `libs/backend-common/src/bootstrap/**`, `libs/backend-common/src/context/**`, `libs/backend-common/src/filters/**`, `libs/backend-common/src/health/**`, `libs/backend-common/src/logging/**`, `libs/backend-common/src/metrics/**`, `libs/backend-common/src/monitoring/**`, `libs/backend-common/src/monetary/**`, `libs/backend-common/src/pagination/**`, `libs/backend-common/src/telemetry/**`, `libs/backend-common/src/types/**`, `libs/backend-common/src/utils/**`, `libs/backend-common/src/websocket/**` | platform-kernel-expert | |
| `libs/backend-common/src/database/**` | data-expert | database-reviewer |
| `libs/event-contracts/**` | data-expert | *all consumers* |
| `database/migrations/**` | data-expert | database-reviewer |
| `apps/*/src/**/entities/*.entity.ts` | {respective domain expert} | database-reviewer |
| `sens-api-gateway/**` | edge-expert | security-reviewer |
| `sensorprotocols/**` | edge-expert | sensor-expert |
| `web/shell/**` | frontend-expert | |
| `web/shared-ui/**` | frontend-expert | *all frontend modules* |
| `web/modules/dashboard/**` | frontend-expert | |
| `web/apps/aquamobil/**` | frontend-expert | |
| `web/modules/hydroponics-module/**` | farm-expert | |
| `apps/billing-service/**` | billing-expert | multi-tenant-saas-expert, security-reviewer, compliance-expert |
| `apps/notification-service/**` | alert-engine-expert | security-reviewer, auth-security-expert |
| `apps/config-service/**` | platform-kernel-expert | infra-expert |
| `apps/event-store-service/**` | data-expert | observability-expert |
| `apps/observability-service/**` | observability-expert | |
| `apps/hydroponics-service/**` | farm-expert | data-expert |
| `infrastructure/monitoring/**` | observability-expert | infra-expert |
| `platform/configs/**` | platform-kernel-expert | infra-expert, security-reviewer |
| `platform/libs/cqrs/**` | platform-kernel-expert | |
| `platform/libs/event-bus/**` | platform-kernel-expert | data-expert, security-reviewer |
| `infra/**` | infra-expert | security-reviewer |
| `infrastructure/**` | infra-expert | security-reviewer |
| `deploy/**` | infra-expert | security-reviewer |
| `.github/actions/**` | infra-expert | test-runner, security-reviewer |
| `.github/workflows/**` | infra-expert | security-reviewer |
| `docker-compose*` | infra-expert | |
| `nginx/**` | infra-expert | security-reviewer |
| `Dockerfile*` | infra-expert | security-reviewer |
| `package.json`, `package-lock.json` | infra-expert | security-reviewer |
| `Cargo.toml`, `Cargo.lock` | edge-expert | security-reviewer |
| `apps/*/src/**/tenant*.ts`, `libs/backend-common/src/database/**tenant**`, `libs/backend-common/src/guards/tenant*.ts` | multi-tenant-saas-expert | auth-security-expert, data-expert |
| `**/*.spec.ts`, `**/*.test.ts`, `e2e/**`, `tests/**`, `.github/workflows/*test*`, `.github/workflows/*ci*` | test-runner | |
| `mcp/**` | mcp-expert | farm-expert, messaging-expert, security-reviewer |
| `.claude/agents/*.md` | prompt-writer | maintenance-only; outside runtime review roster |
| `apps/alert-engine/**` | alert-engine-expert | sensor-expert, farm-expert, multi-tenant-saas-expert, security-reviewer |
| `libs/aquaculture-engines/**` | farm-expert | |
| `libs/farm-shared/**` | farm-expert | |
| `libs/node-components/**` | frontend-expert | |
| `libs/testing/**` | test-runner | |
| `libs/storage/**` | data-expert | |
| `libs/sdk/**` | data-expert | |
| `libs/shared/**` | data-expert | |
| `database/scripts/**` | data-expert | database-reviewer, security-reviewer |
| `libs/backend-common/src/redis/**` | auth-security-expert | multi-tenant-saas-expert |
| `libs/backend-common/src/nats/**` | data-expert | |
| `platform/libs/outbox/**` | data-expert | messaging-expert |
| `apps/db-migrate/**` | data-expert | infra-expert |
| `libs/shared-contracts/**` | data-expert | *all consumers* |
| `scripts/nats/**` | infra-expert | data-expert |
| `scripts/ci/**` | infra-expert | test-runner |
| `scripts/deploy*`, `scripts/*.sh`, `scripts/*.ts` | infra-expert | security-reviewer |
| `docs/adr/**` | architectural-arbiter | prompt-writer |
| `docs/runbooks/**` | infra-expert | security-reviewer |
| `docs/reviews/**` | context-manager | orchestrator |
| `docs/research/**` | prompt-writer | |
| `docs/architecture/**`, `docs/security/**`, `docs/api/**`, `docs/guides/**`, `docs/DEPLOY.md` | architectural-arbiter | infra-expert |
| `nx.json`, `tsconfig.base.json`, `jest.config.*`, `.prettierrc*`, `.nvmrc` | platform-kernel-expert | infra-expert |
| `.claude/knowledge/**`, `.claude/shared/**` | prompt-writer | architectural-arbiter |
| `.claude/allowlists/**` | security-reviewer | architectural-arbiter |
| `.claude/skills/**` | prompt-writer | implementation-planner |
| `tools/gates/**`, `tools/eslint-rules/**`, `tools/ripple-tracer/**` | infra-expert | architectural-arbiter, security-reviewer |
| `CLAUDE.md` | architectural-arbiter | prompt-writer, *all experts* |
| `apps/*/src/gdpr/**` (handler implementations) | gdpr-erasure-executor | compliance-expert (review), legal-hold-auditor (precedence), audit-trail-completeness-auditor (audit row) |
| `libs/backend-common/src/compliance/legal-hold/**` | legal-hold-auditor | compliance-expert |
| destructive action paths (cross-cutting) | legal-hold-auditor | *primary destructive handler owner* |
| every CQRS COMMAND handler audit capture | audit-trail-completeness-auditor | *respective domain expert* |
| `libs/backend-common/src/ai-safety/**` | ai-safety-auditor | messaging-expert, security-reviewer |
| `docs/api/openapi/**` | contract-parity-enforcer | *respective domain expert* |
| `libs/backend-common/src/circuit-breaker/**` | circuit-breaker-auditor | platform-kernel-expert |
| Performance / N+1 / EXPLAIN evidence reviews (cross-cutting) | performance-expert | *primary domain expert* |
| Supply-chain CVE / license / SLSA (cross-cutting on package.json, Cargo.toml, Dockerfile) | supply-chain-auditor | infra-expert, security-reviewer |
| Memory-leak pattern reviews (cross-cutting) | memory-leak-auditor | performance-expert |
| `libs/backend-common/src/security/gdpr/**` | compliance-expert | auth-security-expert |
| `apps/auth-service/src/{privacy,modules/gdpr}/**` | compliance-expert | auth-security-expert |
| `apps/admin-api-service/src/security/{controllers,services}/{compliance,audit-trail}*` | compliance-expert | admin-expert |
| `web/shell/src/{hooks/useConsent.ts,pages/ConsentSettingsPage.tsx}`, `web/modules/admin-panel/src/security/**` | compliance-expert | frontend-expert, admin-expert |
| `docs/compliance/**` | compliance-expert | architectural-arbiter |
| `.env*` | security-reviewer | |

## Special dispatch rules

These override or extend the routing-table primary assignment in cross-cutting cases:

- Any security-related file change → always invoke `security-reviewer`.
- `libs/event-contracts/**` change → `data-expert` + ALL agents whose services consume/produce the changed events.
- `web/shared-ui/**` change → `frontend-expert` + flag impact on ALL frontend modules.
- Changes span 3+ domains → `security-reviewer` as cross-cutting quality gate.
- Schema file / migration / `*.entity.ts` change → also `database-reviewer` (parallel to `data-expert`'s delta review).
- Every changed file MUST map to ≥1 primary agent. Unmatched path = PROCESS HIGH ownership gap; invoke `prompt-writer`, keep review open until coverage is defined.
- 3+ expert agents dispatched OR total corpus ~50K+ tokens → Phase 3.5 auto-invokes `context-manager` for compaction + dependency graph.
- Two agents produce contradictory recommendations in the same cycle OR any recommendation breaks another agent's domain invariant → `architectural-arbiter` after Phase 3.5, before Phase 5.
- Tenant-related concern in scope (isolation, lifecycle/provisioning, plan-tier/module gating, per-tenant quota, noisy-neighbor, cross-tenant impersonation, portability/GDPR Art 20, per-tenant observability, onboarding/offboarding) → `multi-tenant-saas-expert` primary for that concern. Domain experts delegate generic tenant findings here rather than duplicating rules.

Routing invariants enforced in CI:
- `tests/invariants/orchestrator-routing-coverage.spec.ts` — every required repo surface has a matching glob here.
- `tests/invariants/agent-ownership-uniqueness.spec.ts` — no two primary-agent cells disagree on the same glob.
