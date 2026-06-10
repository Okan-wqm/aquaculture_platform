# Apps Enterprise Maintenance End-to-End Implementation Plan

**Date:** 2026-05-30  
**Branch:** `maintanance`  
**Workspace:** `/var/aqua-saas/.codex-worktrees/maintanance`  
**Mode:** four-agent code-validated implementation plan  
**Primary plan:** `docs/plans/2026-05-30-apps-enterprise-maintenance-plan.md`

## Purpose

This document converts the four apps-maintenance reviews into an end-to-end
implementation plan. The standard is enterprise-grade remediation: every
package must identify the SOT owner, boundary contract, authorization model,
data-consistency proof, tests/gates, and rollout evidence before a finding is
called closed.

Patch-only fixes, warning-only handling, silent fallback behavior, disabled
gates, runtime production DDL, unowned cross-schema writes, and untested
contract changes are not accepted.

## Four-Agent Validation

| Agent   | Slice                      | Apps and ownership surface                                                            |
| ------- | -------------------------- | ------------------------------------------------------------------------------------- |
| Agent 1 | Foundation                 | `db-migrate`, `event-store-service`, `config-service`, `observability-service`        |
| Agent 2 | Trust and communication    | `auth-service`, `messaging-service`, `notification-service`                           |
| Agent 3 | Domain                     | `sensor-service`, `farm-service`, `alert-engine`, `hydroponics-service`, `ai-service` |
| Agent 4 | Business and control plane | `billing-service`, `hr-service`, `admin-api-service`, `gateway-api`                   |

## Current Branch State

PR-1 foundation authority has already landed on this branch and is pushed to
PR `#363`. It establishes `db-migrate` as the production schema writer, adds
shared authoritative-mode guards, gates long-running services, moves runtime
hardening into the `db-migrate` registry, and hardens rollback evidence.

During the next-package implementation attempt, the worktree received an
uncommitted event-store candidate:

- `apps/event-store-service/src/event-store/entities/stored-event.entity.ts`
- `apps/event-store-service/src/event-store/services/event-store.service.ts`
- `apps/event-store-service/src/migrations/1800000001000-EventStoreTenantPositionContract.ts`

These files are candidate implementation only. They must be validated by this
plan before commit, and the old baseline migration must not be rewritten.

## Recommended Implementation Order

1. Foundation semantic correctness
   - Event-store sequence, tenant uniqueness, projection identity, config
     system tenant SOT, and migration audit SOT.

2. Trust and identity contracts
   - Auth internal delivery/password verification contracts, `UserDeleted`
     event parity, messaging membership validation, AI egress consent, and
     notification retry claiming.

3. Domain data-plane and durable events
   - Sensor telemetry SOT, production profile fail-closed behavior, sensor
     commit-before-event semantics, alert durable cooldown/outbox, AI token
     reservation, farm notification tenant context, and AI subgraph identity.

4. Business and control-plane ownership
   - Admin-to-owner command delegation, billing CQRS/idempotency/decimal
     boundaries, HR self/team/admin authorization, role taxonomy, throttling,
     RLS bypass audit, and subgraph exposure.

5. Cross-cutting gates and rollout evidence
   - Static ownership gates, event-contract parity, tenant-background-job
     coverage, durable-event gates, PII minimization gates, schema composition,
     and production rollout evidence.

This order is load-bearing. Upper services must not hide lower-layer ownership
or contract defects.

## Package 1: Foundation Semantic Correctness

### Scope

- `apps/event-store-service`
- `apps/config-service`
- `apps/observability-service`
- `apps/db-migrate`
- `libs/backend-common/src/database`

### Confirmed Findings

- Event-store append depends on `event_store.stored_events_global_position_seq`,
  but the committed migration set does not yet establish that sequence.
- Stored event aggregate uniqueness must include `tenantId`; otherwise the same
  aggregate/version cannot exist in two tenants.
- Projection registration stores `tenantId:name`, while start/reset/process
  paths still read by `name`.
- Config uses both UUID system tenant semantics and string `'global'` semantics
  against a UUID column.
- Config cache documentation claims Redis L2 behavior that is not wired by
  `ConfigurationModule`.
- `platform.release_ledger` is the current rollout SOT; observability migration
  audit tables are not complete historical SOT for `db-migrate`.

### SOT And Boundary Contract

- Production DDL SOT: `apps/db-migrate`.
- Rollout evidence SOT: `platform.release_ledger` plus
  `platform.bootstrap_signal`.
- Event persistence SOT: `event-store-service` owns `event_store.*`.
- Config SOT: `config-service` owns `config.*`; global/system rows must use one
  exported UUID constant.

### Authorization Model

- Event-store must not trust `x-tenant-id` alone. Access requires service
  identity or authenticated gateway context plus tenant authorization.
- Config reads/writes must distinguish system rows from tenant rows by UUID,
  not string sentinels.
- Observability migration audit reads are platform-owned and must not become an
  alternate schema-write path.

### Data Consistency

- Add a forward migration for the event-store sequence and tenant-aware unique
  index; do not alter the old baseline as the repair path.
- Add event-store projection identity helper used by register/start/stop/pause/
  resume/reset/process/loop/lock/cache paths.
- Replace every `'global'` config tenant sentinel with the system UUID constant.
- Decide and document whether observability audit is derived from release
  ledger or fed directly by `db-migrate`; until then, release ledger remains
  canonical.

### Tests And Gates

- Event-store unit tests for schema-qualified sequence usage and tenant-aware
  projection registry behavior.
- Migration contract test for sequence existence, sequence ownership, and
  tenant-aware aggregate/version index.
- Config tests for system UUID fallback, tenant override precedence, and cache
  invalidation behavior.
- Observability tests or invariant proving release-ledger-driven gate evidence.
- Static gate blocking baseline migration rewrites for this package.

#### Agent 3 Foundation Static Gates

The Package 1 static gate lives in
`tests/invariants/package-1-foundation-rollout-gates.spec.ts` and is wired into
the `registry` invariant shard.

| Contract                                   | Gate                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No baseline rewrite                        | SHA-256 pins `apps/event-store-service/src/migrations/1800000000000-Baseline.ts`; the repair must stay in a forward migration.                                                                                                                                                                         |
| Event-store sequence and tenant uniqueness | Requires `1800000001000-EventStoreTenantPositionContract.ts` to create and own `event_store.stored_events_global_position_seq`, seed it from `MAX("globalPosition")`, drop the legacy aggregate/version unique index, and create `("tenantId", "aggregateType", "aggregateId", "version")` uniqueness. |
| Projection tenant identity                 | Blocks name-only projection registry lookups, name-only scheduler intervals, hand-rolled lock keys, and tenant lookup by projection name. All lifecycle paths must use the canonical tenant projection key.                                                                                            |
| Config system tenant                       | Parses config-service runtime TypeScript and blocks exact `'global'` string literals. System rows must use the canonical system tenant UUID constant.                                                                                                                                                  |
| Rollout SOT                                | Requires this plan to continue documenting `platform.release_ledger` plus `platform.bootstrap_signal` as rollout evidence SOT until observability audit history is complete.                                                                                                                           |

Run focused gate:

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects registry --runTestsByPath tests/invariants/package-1-foundation-rollout-gates.spec.ts --runInBand
```

Run package shard:

```bash
npx jest --config tests/invariants/jest.config.ts --selectProjects registry --runInBand
```

### Rollout Evidence

- `platform.bootstrap_signal` contains the expected service/schema bootstrap
  rows.
- `platform.release_ledger.expected_heads` equals `applied_heads`.
- Event-store can append same aggregate/version in two tenants while preserving
  global position ordering.
- Projection lifecycle works for the same projection name in two tenants.
- Config system defaults resolve through UUID rows in production-like mode.

## Package 2: Trust And Identity Contracts

### Scope

- `apps/auth-service`
- `apps/messaging-service`
- `apps/notification-service`
- `libs/event-contracts`
- `platform/libs/event-bus`

### Confirmed Findings

- Notification calls auth internal delivery routes for PII/action URL resolution,
  but matching auth routes were not found.
- Messaging calls `request.auth.verifyPassword`, but no shared typed auth subject
  or auth handler was found.
- Auth publishes `UserDeleted` with non-contract shape and missing required
  fields.
- Messaging channel/member writes can accept target user IDs without auth-backed
  tenant membership validation.
- AI chat egress can forward message content even when analysis consent is
  denied.
- Notification retry claim SQL uses a PostgreSQL-invalid direct
  `UPDATE ... ORDER BY ... LIMIT ... RETURNING` shape and is not schema-qualified.
- Subject SOT is `events.{tenantId}.{eventType}`, while legacy docs and one
  messaging handler still use a two-segment event subject.

### SOT And Boundary Contract

- Auth owns identity, password verification, tenant/user membership, password
  reset tokens, invite action URLs, and user deletion events.
- Notification owns delivery attempts and logs, but must resolve PII/action URLs
  through auth-owned contracts.
- Messaging owns channels/memberships, but target user validity and tenant
  membership are auth-owned.
- Subject SOT lives in shared event-bus/event-contract helpers.

### Authorization Model

- Auth internal delivery endpoints or RPC handlers require service identity,
  tenantId, purpose, correlationId, and minimum PII response shape.
- Password verification requires tenantId, userId, password, purpose, rate
  limiting, and no password logging.
- Messaging member changes require actor authorization plus auth-backed target
  membership validation.
- AI egress requires explicit consent before content leaves messaging.

### Data Consistency

- `UserDeleted` publisher and consumers must use the exact shared event shape:
  `deletedUserId`, `hardDelete`, `cascadeRequested`, `initiatedBy`,
  `cryptoShredKeyId`, and tenant context.
- Notification retry workers must claim rows with a CTE and
  `FOR UPDATE SKIP LOCKED`, scoped to the `notification` schema.
- NATS subjects must be generated by helpers, not string literals.

### Tests And Gates

- Auth contract tests for delivery resolution and password verification.
- Event-contract parity tests for `UserDeleted` publisher and consumers.
- Messaging tests for ghost user, inactive user, and cross-tenant member
  rejection.
- AI egress tests proving denied consent sends no NATS or custom HTTP content.
- Notification retry integration test on PostgreSQL.
- Static subject parity gate blocking `events.<EventType>` two-segment handlers.
- PII minimization gate for reset/invite events and logs.

### Rollout Evidence

- Observed `events.<tenantId>.UserDeleted` messages match schema.
- Messaging self-erasure verifies password through auth and produces durable
  anonymization evidence.
- Notification device token cleanup runs from canonical user deletion events.
- Retry rows transition deterministically from failed to retrying to sent.
- Logs mask email, phone, token, and password values.

## Package 3: Domain Data-Plane And Durable Events

### Scope

- `apps/sensor-service`
- `apps/farm-service`
- `apps/alert-engine`
- `apps/hydroponics-service`
- `apps/ai-service`
- `libs/event-contracts`

### Confirmed Findings

- Sensor hot path intends `sensor_metrics`; `sensor_readings` remains a legacy
  compatibility table.
- `SENSOR_SERVICE_PROFILE` defaults or falls back to `legacy`, including
  production-like environments.
- Sensor sidecar ingestion can publish `SensorReading` after enqueueing buffered
  DB work, before durable commit evidence exists.
- Alert cooldown is Redis-only and is written before alert history/incident
  durability.
- Alert critical events are direct NATS publishes; `alert_outbox` appears in
  configuration but not as a durable module/table path.
- Farm has a stronger outbox pattern, but one feeding notification emits
  `tenantId: undefined`.
- AI checks token budget before a model call and records usage after completion,
  but has no atomic reservation.
- AI subgraph lacks `ServiceIdentityGuard` while other domain subgraphs use it.
- `SensorMetricIngested.qualityCode` schema and entity semantics differ.
- Alert event severity contract differs from alert-engine severity vocabulary.

### SOT And Boundary Contract

- Sensor owns raw telemetry after sidecar ingestion and typed `SensorReading`
  publication after enrichment.
- Alert-engine owns rules, cooldown, incidents, alert history, and alert events.
- Farm owns farm operational state and the farm outbox.
- AI owns conversations, tool audit, model usage, and token/rate accounting.
- Cross-service event wire shape is owned by `libs/event-contracts`.

### Authorization Model

- Production sensor profile must be explicit and fail closed when invalid.
- Subgraphs accepting gateway/internal traffic must apply service identity
  before tenant/role/throttle guards.
- Notification command emitters must include tenantId or fail before publish.

### Data Consistency

- Sensor must commit telemetry before emitting a committed `SensorReading`, or
  use a clearly named pending event with consumer semantics.
- Alert cooldown must be part of durable alert state or backed by a database
  idempotency/cooldown table; Redis can remain an acceleration layer.
- Alert triggered/resolved/escalated events must use transactional outbox or an
  equivalent durable event store.
- AI must reserve budget before model invocation, reconcile actual usage after
  completion, and release reservations on failure.
- Farm notification contracts must reject missing tenant context.

### Tests And Gates

- Sensor profile boot tests for production invalid/missing profile rejection.
- Sensor ingestion tests comparing sidecar event, committed metric row, and
  emitted `SensorReading`.
- Alert tests for DB failure after cooldown attempt and concurrent evaluation.
- Alert outbox/idempotent consumer tests.
- Farm notification contract tests for tenantId presence.
- AI concurrent token budget reservation tests.
- SDL composition gate including farm, sensor, alert, hydroponics, and AI.
- Event-contract tests for sensor `qualityCode` and alert severity parity.

### Rollout Evidence

- Sensor canary comparing `SensorMetricIngested`, committed `sensor_metrics`,
  and emitted `SensorReading` counts by tenant.
- Alert durability drill proving cooldown, history, incident, and outbox survive
  process and Redis restarts.
- Zero `notification.send` events with missing tenantId.
- AI concurrent request evidence proving monthly budget cannot be overspent.
- Subgraph artifacts are deterministic, composition succeeds, batching is
  disabled, and service identity is enforced.

## Package 4: Business And Control-Plane Ownership

### Scope

- `apps/admin-api-service`
- `apps/billing-service`
- `apps/hr-service`
- `apps/gateway-api`
- `libs/event-contracts`
- `libs/backend-common`

### Confirmed Findings

- Admin API is platform-admin guarded, and many billing/admin writes already
  delegate to billing over NATS.
- Admin tenant provisioning still writes directly to auth-owned tables for
  tenant status, modules, roles, first admin user, invitations, and compensation.
- Billing admin NATS handler still performs raw SQL updates for cancel,
  reactivate, and extend trial operations instead of CQRS commands.
- Billing DB money handling is mostly decimal-safe, but contract/API surfaces
  still expose `number` and GraphQL `Float`.
- HR self/team/admin boundaries are inconsistent; `MODULE_USER` can reach broad
  employee/performance surfaces.
- Role taxonomy is split across shared roles, HR local lowercase roles, and
  billing-specific roles.
- Admin RLS bypass wraps every request instead of narrowly scoped audited
  operations.

### SOT And Boundary Contract

- Auth-service is sole writer for users, tenants, tenant roles/modules,
  invitations, and session invalidation.
- Billing-service is sole writer for invoices, payments, subscriptions, and
  billing-impacting plans.
- Admin-api-service is a platform-admin facade and may own admin read models,
  analytics, and support tooling.
- Boundary commands must carry actorId, correlationId, tenantId where relevant,
  and idempotencyKey.

### Authorization Model

- Admin API remains `SUPER_ADMIN` only and adds sensitive write throttling and
  idempotency.
- Billing tenant GraphQL roles must come from the shared auth taxonomy.
- HR uses explicit self, team/manager, tenant-admin, and platform-admin policy
  tiers at resolver and handler levels.
- Gateway must not expose platform-admin mutations through tenant subgraphs
  unless explicitly designed and gated.

### Data Consistency

- Tenant provisioning becomes a saga over auth-owned commands with service-owned
  compensation commands.
- Billing admin operations move to CQRS command handlers with transactions,
  audit, events, optimistic locking where needed, and idempotency receipts.
- Monetary boundary values move to decimal strings or a decimal scalar.
- RLS bypass is limited to operations with audit evidence and cannot wrap all
  admin requests by default.

### Tests And Gates

- Static gate blocking admin-api direct writes to `auth.*` and `billing.*`
  outside read-only analytics and owner command clients.
- Billing tests for CQRS cancel/reactivate/extend, command idempotency, decimal
  serialization, duplicate payment retry, and refund races.
- Auth/admin integration tests for tenant provisioning and compensation.
- HR authorization matrix tests for employee, attendance, leave, performance,
  payroll, and direct object ID access.
- Gateway/subgraph schema gate proving platform-admin mutation exposure is
  intentional and service-identity protected.

### Rollout Evidence

- Command receipt metrics for admin-to-auth and admin-to-billing operations.
- NATS timeout/error-rate dashboard for owner-service commands.
- Billing reconciliation sample for invoices, payments, and subscriptions.
- HR negative authorization evidence for cross-employee and cross-team access.
- Admin RLS bypass audit volume decreases and every remaining bypass has an
  operation-level reason.

## Package 5: Cross-Cutting Gates

These gates must land with or before the package they protect:

- Schema authority gate: no production runtime DDL bootstraps.
- Ownership gate: no direct writes to another service-owned schema.
- Event contract gate: publisher and consumer shape parity.
- Subject parity gate: all event subjects through shared helpers.
- Durable event gate: no save-then-direct-publish pattern for critical domains.
- Tenant background-job gate: cron/batch workers must enumerate tenants or use a
  documented source-schema read model.
- PII minimization gate: no PII in events/logs/JWTs outside approved contracts.
- Money gate: no GraphQL Float or number contract for money values.
- HR authorization matrix gate.
- SDL composition and service-identity gate for every subgraph.

## Implementation PR Sequence

1. `foundation-event-store-config-observability`
   - Formalize event-store candidate migration and projection key fix.
   - Normalize config system tenant UUID.
   - Document release-ledger SOT for migration audit.

2. `trust-auth-contracts`
   - Add auth delivery and password verification contracts.
   - Fix `UserDeleted` parity and subject helpers.

3. `trust-messaging-notification-hardening`
   - Add messaging membership validation and AI consent egress blocking.
   - Fix notification retry claiming.

4. `domain-sensor-alert-durability`
   - Fail closed on sensor profile.
   - Align sensor commit/event ordering.
   - Add durable alert cooldown/outbox.

5. `domain-subgraph-ai-farm-hydroponics`
   - AI service identity and token reservation.
   - Farm notification tenant context.
   - Hydroponics ownership/schema validation.

6. `control-admin-owner-commands`
   - Replace admin direct auth writes with auth commands and saga evidence.
   - Add ownership gate.

7. `control-billing-hr-gateway`
   - Move billing admin raw SQL to CQRS.
   - Normalize money contracts.
   - Add HR authorization matrix and gateway exposure gates.

## Definition Of Done

A package is complete only when:

- SOT owner is encoded in code and docs.
- Boundary contracts are typed and tested at both caller and owner.
- Authorization is fail-closed and negative-tested.
- Data consistency is proven with transaction, outbox, idempotency, or ledger
  evidence.
- Static gates prevent the same class of regression.
- Rollout evidence exists for boot, migration, health, audit, and rollback
  behavior.
- No production bypass, warning-only handling, or silent fallback remains in the
  remediated path.
