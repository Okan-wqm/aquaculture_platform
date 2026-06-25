# Farm Enterprise SSOT Architecture

## Scope

Farm-service remains internal behind `gateway-api`. Public direct access is unsupported except explicitly public probes and metrics.

## Verified Current Slice

This revision implements the first farm-service SSOT slice for identity plus batch writes and preserves it with invariant tests:

- Gateway federation and REST proxy both mint `x-verified-user-assertion`; farm-service parses it before legacy user context.
- Gateway no longer forwards legacy raw `x-user-id`, `x-user-roles`, or `x-user-payload` to farm-service.
- Service identity v2 HMAC now binds method, path, query string, raw body hash, content-type, tenant, and verified assertion hash.
- Batch and tank-operation REST controllers use verified request context (`TenantRequest`) for tenant/actor identity; raw `x-tenant-id` and `x-user-id` are not REST business authority.
- Batch REST mutation endpoints are deprecated compatibility adapters over `CommandBus`; new REST domain mutations are not part of the target posture.
- `GET /batches/:id/metrics` is a `QueryBus` read path and no longer refreshes or persists metrics on read.
- `UpdateBatchStatusCommand` uses the tenant/actor/payload envelope shape so migrated handlers do not grow positional constructor variants.
- Batch lifecycle decisions are centralized in `BatchLifecyclePolicyService`; status and close handlers do not carry local transition tables.
- Mortality/cull quantity checks are centralized in `MortalityCullPolicyService`.
- Migrated status, close, and delete writes execute inside `runInTenantTransaction(dataSource, 'farm', tenantId, ...)`; mortality/cull policy is centralized while their raw transaction migration remains scheduled.
- Test harnesses for migrated handlers use UUID tenant fixtures and `tenantManagerRepo`-compatible repository mocks so tests exercise the production transaction/repository contract.
- Tenant-owned `Batch` access in migrated status and close handlers uses `tenantManagerRepo`.
- Domain events on the migrated paths are enqueued through `OutboxPublisher` inside the transaction.
- Site, PII-free site contact replacement events, department, system, non-tank equipment, sub-equipment, tank-like equipment compatibility, tank, supplier approved-site, and feeder calibration setup writes now use the target tenant transaction/audit/outbox contract for create/update/delete, status, and replacement flows. Their setup events have strict JSON schemas and gateway realtime bridge dispatch. Remaining setup write surfaces are tracked by `docs/plans/sites-setup-remediation/README.md#phase-3---backend-write-path-replacement`.

## Target SSOT Ownership

- Identity: `VerifiedUserAssertion` (the gateway-signed verified-user assertion) is the only farm user/tenant authority. Raw `x-user-*`, raw `x-act-as-tenant`, and unverified `x-tenant-id` are not business authority.
- Service identity: per-caller keyring plus allowed caller/audience/route matrix. Shared-secret production fallback is invalid.
- Commands: command/query envelopes carry tenant, actor, correlation, mobile command metadata, and payload consistently.
- Transactions: tenant writes run through `runInTenantTransaction(dataSource, 'farm', tenantId, fn)` and tenant-owned entity access uses `tenantManagerRepo` or a repository port.
- Events: durable domain events use the transaction-bound outbox path, not direct best-effort publish.
- Metrics and health: one farm registry and explicit live/ready semantics.
- Contracts: OpenAPI, GraphQL SDL, and event catalog gates prevent drift.

## Batch Migration Rule

Each migrated batch write must remove duplicate authority at the same time it introduces the SSOT path. Suppressions, fail-open production behavior, raw header trust, direct domain event publish, and ad hoc query-runner ownership are not completion evidence.

The current batch slice covers status transition, close-reason, mortality/cull quantity policy, plus the status/close/delete transaction boundary. Mortality/cull still use raw QueryRunner transactions but now have explicit tenant-scope guardrails until their transaction migration lands. Remaining batch write handlers should be migrated with the same rule before this guardrail is ratcheted to all farm-service domains.

## Added Claim Follow-Up

The following claims are now explicit plan/guardrail inputs:

- Batch handler tenant lookup claim: migrated handlers may use `tenantManagerRepo(queryRunner.manager, Batch, tenantId)`, but any remaining raw batch-handler `findOne(...)` with a `where` clause must visibly include `tenantId` until that handler is migrated. The delete-batch compatibility handler also carries explicit `tenantId` in its `where` clause even though `tenantManagerRepo` injects the same scope.
- Farm identity middleware order claim: `VerifiedUserAssertionMiddleware` must run before legacy `UserContextMiddleware`; farm GraphQL context must not reconstruct users from raw `x-user-*` headers. This is tracked by `tests/invariants/farm-identity-ssot.spec.ts`.
- REST identity claim: deprecated batch/tank REST adapters must not use `@Headers('x-tenant-id')`, `@Headers('x-user-id')`, or `userId || 'system'`. This is tracked by `tests/invariants/farm-rest-cqrs-ssot.spec.ts`.
- Site/system eventing target: site create/update/delete, contact replacement, department create/update/delete, and system create/update/delete have migrated to tenant transactions, `tenantManagerRepo`, fail-closed audit, and durable outbox enqueue. This slice is tracked by `tests/invariants/farm-site-system-eventing-transaction-ssot.spec.ts`, `docs/plans/sites-setup-remediation/README.md`, and the real Postgres suite `apps/farm-service/src/__tests__/e2e/site-tenant-isolation.postgres.spec.ts`.
- ARIA autonomy smoke claim: the `/tmp/aria-autonomy-smoke-20260530` timeout is not accepted as farm SSOT completion evidence. It belongs to the ARIA/autonomy quality plan, with a bounded timeout, deterministic fixture input, and explicit termination criteria before it can be a CI gate.

## Runtime, API, and Guardrail Slice - 2026-05-31

This slice updates the implementation status to match the current worktree instead of treating target architecture as completed code:

- Gateway REST proxy signs the exact outbound body bytes it sends to downstream services. Empty/no-body requests sign `sha256('')`; JSON requests sign the same `JSON.stringify(...)` value assigned to `fetchOptions.body`.
- `CqrsModule` auto-discovery now registers command and query handlers by the class reference stored in the decorators, with name-based registration retained only as fallback. This protects dispatch from class-name minification drift.
- Deprecated batch/tank REST mutation routes now act as CQRS adapters. They read tenant and actor from canonical `TenantRequest`, not raw `@Headers('x-tenant-id')` or `@Headers('x-user-id')`; retained read routes use `QueryBus` where a query exists.
- `GET /batches/:id/metrics` is a read-only `GetBatchPerformanceQuery` path and does not call `BatchService.updateBatchMetrics()`.
- `UpdateBatchStatusCommand` has moved to the `{ tenantId, actorUserId, payload, correlationId? }` envelope shape, removing the known actor/reason positional transposition risk on that command.
- Farm domain metrics now expose `tenant_partition` labels using a keyed HMAC partition. Raw tenant UUIDs and tenant UUID prefixes are no longer emitted by `FarmDomainMetricsService`; production construction fails if no metrics partition key is configured.
- The farm enterprise guardrail CLI now accepts both `--mode range` and `--mode=range`, matching the current GitHub Actions invocation. A new guardrail blocks raw `tenant` metric labels in farm runtime metrics.
- `tests/invariants/farm-rest-cqrs-ssot.spec.ts` now also locks the CQRS auto-discovery class-reference registration invariant.

Open work remains explicit and blocking for final SSOT completion:

- Service identity now uses the expanded v2 canonical contract for method/path/query/body/content-type/assertion/kid/audience/nonce and rejects v1 by default in the unified verifier. Remaining work is the canonical per-caller keyring lookup, central nonce replay store, and explicit route/audience matrix enforcement.
- Raw transaction ownership remains in several batch/cleaner-fish handlers and other farm domains. These must move to `runInTenantTransaction(dataSource, 'farm', tenantId, fn)` and tenant-scoped repository ports.
- Direct durable `eventBus.publish()` still exists in feed, task, and other setup-adjacent paths and must move to transaction-bound `OutboxPublisher.enqueue()`.
- `farm.outbox_events` migration exists, but consumer inbox APIs and event catalog parity gates are still open.
- Full command/query envelope migration is incomplete; only the migrated batch status command is complete in this slice.
- Transfer, growth metrics, and feed inventory policies are still target SSOT components, not fully implemented source of truth.
- OpenAPI route diff, generated GraphQL SDL diff, event parity, and docs completeness gates are not yet all blocking CI gates.

## Eventing and Transaction Status - 2026-05-31

The canonical target remains unchanged: durable domain events must be enqueued inside the same tenant transaction as the business write, and tenant-owned writes must use the farm tenant transaction helper plus tenant-scoped repositories. The current worktree is not final-all-mode clean.

Verified in this slice:

- `farm-service-enterprise-guardrails --mode=range` and `--mode=range` parse correctly for PR range checks.
- `farm-service-enterprise-guardrails --mode all` currently fails, which is expected until the remaining raw transaction, raw repository-injection, and direct-publish burn-down is complete.
- Batch REST adapter and metrics label hygiene are now covered by focused tests and invariants.

The remaining burn-down must be done by domain, without suppression or fail-open bypass:

- Batch first: create/update/status/close/allocate/transfer/mortality/cull/cleaner-fish handlers must converge on transaction helper + tenant repo ports.
- Then sites setup surfaces, feeding, growth, harvest, equipment, storage, task, water-quality, worker, weather, scheduler.
- Guardrail all-mode should become green only after the migrated domains are actually clean; allowlists are limited to infra/helper/migration/test surfaces.
