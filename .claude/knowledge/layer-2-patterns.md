# Layer-2 — Architectural patterns

**Audience:** every enterprise-v2 agent (CATCHER, TEACHER, WRITER modes).
**Scope:** architectural patterns that cross tech boundaries. Applied consistently across NestJS services, React frontends, and the Rust edge. Domain-specific elaborations appear in the respective agent file — generic shape is here.

## CQRS discipline (ADR-007)

- **Layering** — Controller → Service → CommandBus / QueryBus → Handler → Repository. No layer skipping. Every PR that skips a layer is a HIGH finding.
- **Command handler** — single responsibility; one handler per command. Mutates via the aggregate, never the repository directly.
- **Query handler** — read-only; separate bus (`QueryBus`). Optimised read-side projections may bypass domain models (e.g., denormalised materialized view).
- **Saga** — multi-step within-service orchestration. For cross-service, use event-driven choreography via NATS.
- **`@nestjs/cqrs` 11 specifics** in `layer-1-nestjs.md`.

## Outbox pattern (ADR-006 + platform/libs/outbox)

- **Motivation** — atomic "persist business change + publish event" guarantee. Without outbox, NATS publish after a DB commit can fail silently leaving consumers out of sync.
- **Shape** — any service that emits domain events inserts an `outbox_event` row in the same transaction as the business-change. A separate `OutboxWorker` polls the table, publishes to NATS, marks published.
- **Current adoption** — 3/12 services (farm, hr, messaging) as of W1 (DATA-HIGH-004). Remaining 9 call `eventBus.publish` directly — at-most-once on transaction rollback.
- **W7 enforcement** — ESLint rule `no-direct-event-publish` bans `eventBus.publish` outside `@platform/outbox` implementation files. Promotes discipline from tier-4 doc to tier-3 detection.

## Event flat pattern (ADR-006)

- **Shape** — events extend `BaseEvent` with typed fields at the top level. NO nested `payload` / `metadata` wrappers.
  ```ts
  interface BatchHarvested extends BaseEvent {
    eventType: 'BatchHarvested';
    batchId: BatchId;
    tenantId: TenantId;
    harvestedAt: string;         // ISO 8601
    totalKg: number;
  }
  ```
- **Branded `EventId`** — `createBaseEvent()` is the only factory permitted to produce `EventId`. Inline event object literals cause a compile-time error because `EventId` is unconstructable by consumer code. 278 event construction sites compile-clean in the current repo (0 escapes).
- **Versioning** — breaking changes require an upcaster in `libs/event-contracts/src/upcasters/`. Consumers read via an upcaster pipeline so historical event replays still deserialize. Adoption-invariant test for upcaster chain integrity is W6 deliverable.

## DDD aggregate root

- **Aggregate root owns invariants** — validation + state transitions inside the root class; external code may only invoke intent-methods (`batch.harvest()`, not `batch.status = HARVESTED`).
- **Boundary** — one aggregate per transaction. Cross-aggregate consistency via events, not cross-aggregate direct references.
- **Persistence mapping** — separate TypeORM entity (persistence) from domain aggregate (behaviour). CLAUDE.md: *"Keep domain entities separate from persistence entities. ORM decorators do not belong in the domain layer."*
- **Repository** — returns aggregate roots, not anaemic rows. Repository adapts TypeORM entities ↔ domain aggregates.

## Tenant isolation (multi-tenant-saas-expert domain)

- **Schema-per-tenant services (7)** — farm, sensor, hr, messaging, hydroponics, alert-engine, ai. Each tenant gets a dedicated schema; queries scope via `search_path` + `TenantScopedRepository`.
- **Shared-schema services (6)** — auth, billing, admin-api, event-store, config, notification. Single schema; tenant scoping at the query layer (filtered by `tenantId` column) + RLS policies.
- **Trust anchor** — JWT claims are authoritative for tenantId on authenticated paths. `x-tenant-id` header is accepted ONLY on explicit pre-auth / cross-tenant admin / edge-device ingestion paths (CLAUDE.md; `TenantContextMiddleware`).
- **Gateway→subgraph HMAC** binds `tenantId` into the signature so a compromised intermediary cannot swap tenants in flight.
- **RLS defense-in-depth** — policies active on 2/7 per-tenant services as of W1 (farm, messaging). MT-HIGH-003 — other 5 rely on search_path alone. W5-W6 closes.

## Saga compensation

- **In-process sagas** (single service) — `@Saga()` method returns `Observable<ICommand>`; compensation via explicit "revert" commands.
- **Cross-service sagas** — event-driven choreography. Each step emits an event; subsequent services react. Compensation = publish a "compensating" event that downstream services handle.
- **Example** — `provision-tenant` skill (BLOCKER-14 in plan v4): auth creates tenant row → emits `TenantProvisioning` → each of 7 schema-per-tenant services creates its tenant schema on event receipt. On partial failure, tenant row stays `PROVISIONING`; compensation via `TenantProvisioningFailed` event triggers `DROP SCHEMA` in services that completed.
- **Advisory locks** — per-tenant migrations use `pg_advisory_xact_lock(hash(tenant_id))` so concurrent provisions across services don't interleave.

## Boundary discipline

- **Defined in** `.claude/allowlists/boundary-files.yaml` — 19 legitimate boundaries where `as any` / `jsonb` / other tier-4 patterns are justified (MQTT payload deserialization, Stripe webhook, event-store polymorphic jsonb, zod/ajv boundary validators, etc.).
- **Everything inside a boundary** is narrowed to typed data before leaving the boundary file. Boundary exit = strict types, internal safety restored.
- **Override protocol** — inline `// auditor-override: AUDIT-NNN | owner:@{user} | deadline:{YYYY-MM-DD}` for case-by-case exceptions. Allowlist entry with `expires: never` requires ADR.

## CI invariant discipline

- **`tests/invariants/*.spec.ts`** — contract-level assertions that run on every PR:
  - schema-invariants: `@Entity` schema ownership per ADR-011.
  - nats-invariants: services.yaml ↔ nats.conf ↔ cert CN triple-lockstep per ADR-014/015.
  - adoption-invariants (W2): `SchemaDriftModule.forRoot` registered in every schema-owning service.
  - knowledge-ssot (W8): agent files don't inline content hashable-duplicate with `.claude/knowledge/*`.
  - upcaster-chain (W6): every event version has a matching upcaster.
- **Invariant failure** blocks merge. Fix the invariant OR fix the code — never weaken the invariant without an ADR.

## References

- Full list of patterns cross-cites:
  - ADR-006 (event flat), ADR-007 (CQRS), ADR-008 (guards), ADR-011 (schema), ADR-012 (drift), ADR-013 (messaging isolation), ADR-014/015 (NATS), ADR-016 (RS256).
- `platform/libs/` — CQRS, event-bus, outbox implementations.
- `libs/backend-common/` — TenantScopedRepository, SchemaDriftValidator, StructuredLoggerService, service-identity util.
- `docs/reviews/_audit/2026-04-W16-unified-audit.md` — systemic patterns SYS-1 through SYS-5 naming the recurrent gaps this layer is meant to close.
