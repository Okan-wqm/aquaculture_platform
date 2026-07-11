# INFRA-HIGH-003 — event-store/config GDPR erasure cascade — execute-ready blueprint

**Source finding:** `docs/reviews/db-audit/db-audit-ops-infra/2026-07-11-ops-infra-crosscut.md#DB-INFRA-HIGH-003` (Lane-D database E2E audit, 2026-07-11).
**Status:** investigated to the bottom 2026-07-11. Confirmed an **architectural initiative, not a mechanical fix** — two atomic halves, each touching a security-sensitive SSoT. Belongs in its own reviewed PR. This blueprint makes that PR a mechanical execution rather than a fresh investigation.

## Why it is not a patch (proven by code)

The erasure cascade uses `TenantErasureTargetModule.forService(x)` (`libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target.module.ts`). Its handler injects `@Inject('EVENT_BUS')` and `subscribeWildcard('TenantErasureRequested')`, and its executor (`tenant-erasure-target-executor.ts`) requires:
1. a `MODULE_SCHEMAS` entry for the service's module (throws otherwise),
2. an outbox table (`OutboxPublisher.enqueue`),
3. a `tenant_erasure_target_proofs` ledger.

**config-service today:** NOT in `MODULE_SCHEMAS`; NO `EventBusModule`/NATS (no cert in `infrastructure/nats/services.yaml`, zero `subscribeWildcard`/EVENT_BUS in its `src`); NO outbox; only `SchemaDriftModule` + GraphQL. So making it an erasure target = **onboarding config-service to the NATS event backbone** (a cert-CN mint per ADR-015 — a security-SSoT change) + full erasure infrastructure.

**event-store today:** `stored_events.payload`/`metadata` (jsonb) can embed PII in an **immutable, append-only** log — cannot be row-deleted without breaking event-sourcing. GDPR-correct answer = **crypto-shred** (encrypt PII at write with a per-tenant key; destroy the key on erasure). Its `event_streams`/`snapshots`/`projection_checkpoints`/`projection_rebuilds` carry raw `tenantId` and CAN be deleted (same onboarding as config).

The `tests/invariants/tenant-erasure-ssot.spec.ts` invariant cross-locks union ↔ registry ↔ `MODULE_SCHEMAS` ↔ per-service proof-ledger migration — so a half-wired target **fails CI**. It is all-or-nothing.

## Part A — config-service (atomic; ~9 files + 1 invariant + NATS SSoT)

1. **NATS cert (SECURITY SSoT, ADR-015):** add `config-service` to `infrastructure/nats/services.yaml` (subscribe grant for `events.*.TenantErasureRequested`; publish for `TenantDataErased`/`TenantErasureBlocked`/`TenantDataErasureFailed`), mint the cert CN, run `scripts/nats/generate-nats-conf.py`. Gated by `e2e/tests/integration/nats-invariants.spec.ts`. All in ONE commit (the generated `nats.conf` block is shared and must stay consistent).
2. **EventBusModule + Redis** wired into `apps/config-service/src/app.module.ts` (mirror billing's `EventBusModule.forRootAsync` + `RedisModule.forRootAsync`).
3. **ConfigOutbox**: `apps/config-service/src/outbox/config-outbox.entity.ts` (extends `OutboxEntityBase`, `@Entity({schema:'config',name:'config_outbox',synchronize:false})` + poll/tenant/idempotency indexes — mirror `apps/billing-service/src/outbox/billing-outbox.entity.ts`) + `config-outbox.module.ts` (`@Global` + `OutboxModule.forFeature(ConfigOutbox)`).
4. **Migration** `apps/config-service/src/database/migrations/<ts>-CreateConfigOutbox.ts`: `buildTransactionalOutboxUpSql({schema:'config',table:'config_outbox',...})` + `buildTenantErasureTargetProofLedgerUpSql({schema:'config',...})` — mirror `apps/billing-service/src/database/migrations/1800600000000-CreateBillingOutbox.ts`. If the invariant expects a separate `Ensure…ProofLedger` migration path (see step 8), add it too.
5. **MODULE_SCHEMAS entry** (`schema-manager.service.ts`): `{ moduleName:'config', sourceSchema:'config', infrastructureTables:['migrations','config_outbox',...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES], referenceDataTables:[], tables:['configurations','configuration_history'] }`. Platform-level source-schema (NOT tenant-cloned).
6. **Registry** (`tenant-erasure-target-registry.ts`): add `'config-service': { targetService:'config-service', moduleName:'config', sourceSchema:'config', mode:'source-schema-tenant-column', outbox:{schema:'config',table:'config_outbox'}, proofLedger:{schema:'config',table:'tenant_erasure_target_proofs'} }`.
7. **Union** (`libs/event-contracts/src/tenant-erasure-targets.ts`): add `'config-service'` to `TENANT_ERASURE_TARGET_SERVICES` (the count constant auto-updates).
8. **Invariant** (`tests/invariants/tenant-erasure-ssot.spec.ts`): add config's entry to `TARGET_PROOF_LEDGER_FORWARD_MIGRATIONS`.
9. **app.module**: import `ConfigOutboxModule` + `TenantErasureTargetModule.forService('config-service')`.
10. **Reconcile**: `tenant-erasure-ssot`, `nats-invariants`, `schema-invariants`, `tenant-fanout-entity-parity` (config entities ↔ MODULE_SCHEMAS), `adoption-invariants`, `PROTECTED_TABLES` (proof-ledger immutability), and any pinned service-count docs. Integration test: a dry-run erasure deletes config rows for a tenant + writes a proof ledger row + enqueues the `TenantDataErased` proof event.

## Part B — event-store (larger; crypto-shred design)

1. Onboard event-store to NATS + erasure infra exactly as Part A (cert, EventBus, outbox, proof ledger, `MODULE_SCHEMAS {moduleName:'event_store',...}`, registry, union, invariant).
2. Erase the deletable tenant-column tables (`event_streams`, `snapshots`, `projection_checkpoints`, `projection_rebuilds`) via `source-schema-tenant-column` mode.
3. **`stored_events` crypto-shred** (the hard part): envelope-encrypt the PII-bearing payload with a per-tenant data key (DEK) wrapped by a KEK; store ciphertext + key reference only; on `TenantErasureRequested`, destroy the tenant DEK so the ciphertext becomes unrecoverable (the immutable row remains, satisfying event-sourcing AND erasure). Requires: a per-tenant DEK store + lifecycle, write-path encryption in the append pipeline, read-path/upcaster decryption, and a shred step in the erasure executor (a new mode or a service-local handler). Design + STRIDE threat-model review required before implementation.

## PREREQUISITE DISCOVERY — suspected systemic erasure-proof publish-grant gap (verify first)

While scoping the config NATS grants, a likely **latent bug in the EXISTING erasure infrastructure** surfaced and MUST be resolved before (or alongside) config/event-store onboarding, because it dictates the correct grant set:

- The per-service `OutboxWorker` publishes via the **service's own** `IEventBus.publish()` (own mTLS cert). So a `TenantDataErased`/`TenantDataErasureFailed`/`TenantErasureBlocked` proof event enqueued by the shared `TenantErasureTargetExecutor` is published under the **target service's** cert.
- In `infrastructure/nats/services.yaml`, **only `farm_service`** carries `events.*.TenantDataErased` / `…ErasureFailed` / `…ErasureBlocked` publish grants (farm builds those event literals in its own `src`, so the `nats-invariants` publish-coverage scanner flagged it). The other erasure targets — `billing`, `notification`, `ai`, `alert`, `hydroponics` (and presumably `hr`, `messaging`, `sensor`) — have NO such grant, because the event literal lives in `libs/backend-common` (the executor), a **blind spot** in the per-service-src publish-coverage scan.
- Consequence (HIGH-confidence, verify with `infra:up` + a real erasure run): under NATS `verify_and_map`, those services' outbox workers would get a **Permissions Violation** publishing the proof event → the proof never reaches the orchestrator → the tenant-erasure cascade cannot confirm completion for those services. This is the ORPHAN-HIGH-317 failure class, one layer down.

**Implication for this work:** do NOT blindly mirror a template for config's grants — the templates disagree (farm has the grant; the rest do not). The dedicated PR must first (a) confirm the gap end-to-end, (b) fix `nats-invariants` publish-coverage to follow `TenantErasureTargetModule.forService` wiring (not just per-service src literals) + backfill the missing grants for ALL erasure targets, THEN (c) add config/event-store with the correct grants. Recommend logging this as its own finding (ORPHAN-HIGH) since it affects live GDPR-proof completeness independent of config/event-store.

## Environment preconditions

- This checkout has been **shared with another active session** (a concurrent `git checkout` clobbered uncommitted work once during the 2026-07-11 session). Minting a NATS cert regenerates the **shared** `nats.conf` — a half-applied regen risks every service's NATS auth. Execute in a stable/exclusive checkout.
- The originating branch `feat/db-audit-lane` was ~16 commits behind `main` (PR #942). Rebase/merge first; conflicts expected in `docs/reviews/orphan-findings.md` + `docs/reviews/_registry/findings.jsonl` (touched by #942's close ceremony).
