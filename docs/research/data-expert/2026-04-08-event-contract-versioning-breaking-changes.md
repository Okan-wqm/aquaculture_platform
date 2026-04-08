# Research: Event Contract Versioning and Breaking Changes

**Topic:** Additive vs breaking event schema changes, version bumping, consumer migration strategies, deprecation windows, BaseEvent with tenantId pattern
**Date:** 2026-04-08
**Agent:** data-expert

## Sources

- [Event Sourcing Pattern — Microsoft Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing)
- [Schema Registry in Azure Event Hubs — Microsoft Learn](https://learn.microsoft.com/en-us/azure/event-hubs/schema-registry-concepts)
- [Best Practices: Data Contract Versioning (WCF) — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/framework/wcf/best-practices-data-contract-versioning)
- [Event Sourcing — Martin Fowler](https://martinfowler.com/eaaDev/EventSourcing.html) (canonical 2005 reference)
- Platform source: `libs/event-contracts/src/base-event.ts`, `libs/event-contracts/src/upcasters/*`

## Key Findings

### The immutability constraint (why this is not REST/gRPC)

Unlike request/response contracts, an event store is an append-only ledger that is the permanent system of record. Microsoft's Event Sourcing Pattern is explicit: *"the event store is the permanent source of information, so you should never update the event data. The only way to update an entity or undo a change is to add a compensating event."* This means schema evolution cannot be handled by a "deploy producer + consumer together" window — historical events with old shapes continue to exist forever, and every consumer that replays a stream must be able to decode them.

For an event-driven multi-tenant SaaS like aqua-saas, this has four concrete consequences:

1. **Every field change is permanent.** Producers cannot retroactively fix a bad event field; only compensating events work.
2. **Rehydration windows are unbounded.** A consumer that rebuilds a projection from day-1 events must understand every historical shape, not just the current one.
3. **Fan-out amplifies the cost.** With 8 modules and cross-service consumers on NATS, a breaking change in one producer simultaneously breaks N consumers.
4. **Snapshots do not replace compatibility.** Microsoft is explicit: *"Snapshots are an optimization, not a replacement for the event stream. The event stream remains the source of truth, and you can regenerate snapshots from it at any time."* A team that hides a breaking change behind snapshots is only deferring the pain.

### The four compatibility tactics (Microsoft + research literature)

Microsoft's Event Sourcing guide and the aqua-saas existing `upcasters/` directory converge on the same four tactics, in strict preference order:

1. **Tolerant deserialization.** Consumers ignore unknown fields and use defaults for missing fields. This handles all additive, non-breaking changes *without any version bump*. This is the free win — every producer change that only adds optional fields should land this way. Azure's Schema Registry calls this "backward compatibility mode": adding optional fields is permitted, and consumers can read both old and new versions.
2. **Event versioning.** The event envelope carries a `version: number`. Consumers inspect the version and route to the appropriate handler. Azure's Schema Registry supports this as a first-class concept; the aqua-saas `BaseEvent.version: number` field already exists.
3. **Upcasting.** When a breaking change is unavoidable, register transformation functions that convert old event schemas to the current schema *at read time*. Stored events remain unchanged (preserving immutability). Upcasters can be chained — consumer code only handles the latest version. This is the pattern already implemented in `libs/event-contracts/src/upcasters/`.
4. **In-place migration (last resort).** Rewrite historical events to the new schema directly in the event store. Microsoft explicitly labels this a *last resort because it undermines the audit trail*. In an RGPD-aware SaaS this also creates a legal problem: rewritten events are no longer tamper-evident.

### Additive (non-breaking) change catalog

Based on Microsoft's Schema Registry backward-compatibility rules and WCF's versioning best practices, the following are **additive**:

- Adding an **optional** field (never required)
- Adding a new event type to a union (`AnyPlatformEvent`)
- Widening a numeric range (e.g., int32 → int64) where serialization is JSON
- Adding new enum values to an enum that already has an explicit fallback handler
- Renaming via a *backward-compatible alias* (serializer writes both names during the deprecation window)

### Breaking change catalog

- **Removing** any field, even one previously marked optional (Microsoft/WCF rule 9: *"Do not remove data members in later versions, even if `IsRequired` was left at its default"*)
- **Renaming** a field without a backward-compatible alias
- **Narrowing** a field's type (string → UUID, int64 → int32, nullable → non-null)
- **Re-purposing** an existing field with new semantics
- Changing `eventType` casing or name
- Removing an enum value that historical events may carry
- Adding a **required** (non-optional) field (WCF rule 8a: `IsRequired` should always stay `false`)

### Consumer migration strategy (deprecation window)

Microsoft's guidance combined with enterprise practice:

1. **Stage 1 — Dual-publish.** Producer publishes BOTH the old shape and the new shape for the deprecation window. All consumers must support the old shape during this window.
2. **Stage 2 — Consumer migration.** Each consumer is updated to handle the new shape. Until every consumer migrates, producer continues dual-publish.
3. **Stage 3 — Upcaster installation.** Before producer stops publishing the old shape, install an upcaster in the shared `libs/event-contracts/src/upcasters/` module that transforms historical old-shape events into the new shape at read time. This covers replay of old events from durable streams.
4. **Stage 4 — Producer cleanup.** Producer stops publishing the old shape. The upcaster remains permanently.

Deprecation window duration: for aqua-saas NATS JetStream with multi-day retention and long-running consumer groups, the window must be at least **2x the max_age of the longest-retained stream + 1 full consumer redeploy cycle**. For streams with infinite retention (event sourcing mode), the upcaster is permanent and the producer can switch whenever all live consumers have migrated.

### The `tenantId` invariant (aqua-saas specific)

The `BaseEvent` interface mandates `tenantId: string` at the top level, not inside a nested payload. This placement is non-negotiable because:

1. **NATS subject routing.** NATS subjects can encode `tenantId` into the subject hierarchy (e.g., `events.{tenantId}.farm.BatchHarvested`). Subject-level routing is dramatically cheaper than payload-level filtering, and it composes with subject-based authorization (JetStream consumer filters).
2. **RLS context propagation.** The RLS policy `USING (tenantId = current_setting('app.current_tenant')::uuid)` requires the consumer to `SET LOCAL app.current_tenant` *before* executing any query. That setting must come from the event envelope, not from a nested business field.
3. **Cross-service correlation.** Every event that lacks `tenantId` at the top level is unroutable and creates a cross-tenant leak risk. This is why the domain rule `tenantId MANDATORY = CRITICAL` is stated that way — an event without `tenantId` cannot be safely dispatched in a multi-tenant environment without parsing the entire payload.

### The `eventId` + `aggregateId` pair

The extended `BaseEvent` in aqua-saas includes both `eventId` (unique per event) and optional `aggregateId`/`aggregateType`. This is the minimum event-sourcing envelope:

- **`eventId`** enables at-least-once idempotency. Consumers MUST track `eventId` per consumer group and skip duplicates. Microsoft: *"Event handlers must be idempotent so processing a duplicate event doesn't change the outcome."*
- **`aggregateId`** enables per-entity replay. Without it, an audit query of the form "show me every event for batch abc-123" requires scanning the entire stream. The `BaseEvent` doc comment explicitly notes: *"BEFORE this field: events could not be filtered by business entity — only by tenantId. This made event replay and per-aggregate audit trails impossible."*
- **`aggregateType`** makes `aggregateId` namespaced. A `Batch` `abc` and a `Sensor` `abc` are different aggregates; without `aggregateType`, their event streams conflate.

## Security Concerns

- **Tenant leak via missing `tenantId`.** An event without `tenantId` at the top level published to a shared NATS subject can be delivered to a consumer in a different tenant's context. Fail-closed behaviour: consumers MUST reject any inbound event where `tenantId` is missing or does not match their expected tenant context. This should be a shared NATS subscriber base class, not per-handler logic.
- **PII in events is permanent.** Because events are immutable, any PII (name, email, phone) written to an event is in the audit trail *forever*. Microsoft explicitly calls this out: *"The append-only, immutable nature of an event store conflicts with data protection regulations that require deletion of personal data."* The two approved mitigations: (1) store PII outside the event store and reference by ID, or (2) crypto-shred by per-subject key.
- **Version field tampering.** If `version` is a client-set field, a malicious producer can bump `version` to skip upcaster chains. In practice this means consumers should reject unknown versions with a quarantine rather than a silent drop.
- **`correlationId`/`causationId` as side channel.** These are free-form strings and should be length-capped (e.g., 64 chars) and character-class-restricted in the consumer layer to prevent log injection.

## Performance Concerns

- **Upcaster chains are O(n) per read.** Each read of a historical event must walk the upcaster chain from its original version to the current version. For a v1→v2→v3→v4 chain, each replay of a v1 event runs 3 transforms. Chains of 6+ versions begin to show measurable replay latency — at that point consider a point-in-time in-place migration for the oldest version family only.
- **Version dispatch hot path.** If consumers use `switch (event.version)` on the hot path, the check should be inlined and hit the common-case first (latest version). For NATS consumer rates >10k events/sec, this matters.
- **Subject cardinality explosion.** Encoding `tenantId` and `aggregateType` in subjects can explode cardinality. NATS JetStream has practical limits on subject filters per consumer; with thousands of tenants, subject-based filtering should be `events.{tenantId}.*` (not `events.{tenantId}.{aggregateType}.{eventType}`).

## Architectural Implications for data-expert reviews

1. **Every PR that touches `libs/event-contracts/src/*.ts` requires a diff-based analysis.** The reviewer must classify each field change as additive or breaking using the catalogs above. A breaking change without a version bump, upcaster plan, and consumer-migration plan is **CRITICAL**.
2. **The `version` field semantics must be consistent.** `createBaseEvent()` defaults `version: 1`. Any event interface that publishes with a different version must be routed through an upcaster on the consumer side, and the reviewer must confirm the upcaster exists in `libs/event-contracts/src/upcasters/`.
3. **Flat-object invariant is enforced.** Any event with nested `payload`, `metadata`, `data`, or `body` wrapper objects violates the platform contract. The reviewer escalates this to **HIGH** immediately.
4. **`AnyPlatformEvent` union completeness.** A new event type that is not added to `AnyPlatformEvent` creates a silent type-hole where consumers cannot narrow via the discriminated union. This is a **HIGH** finding even though it compiles.
5. **Consumer-side fail-closed guard.** Every NATS consumer must reject events where `tenantId` does not match the expected tenant context of the subscribing consumer. Missing this guard is **CRITICAL** (cross-tenant leak).
6. **Upcaster tests are mandatory.** Every new upcaster requires a fixture of each historical version it supports plus a test asserting the transformation. Reviewer flags untested upcasters as **HIGH**.

## Domain Rule Additions for data-expert

- Field removal or rename on an existing event interface = **CRITICAL**. Requires: version bump, upcaster, deprecation window documentation, consumer migration list.
- Adding a **required** (non-optional) field to an existing event interface = **CRITICAL**. Only optional fields are additive; required fields break every old event in the store.
- Nested `payload`/`metadata`/`data`/`body` object wrapper in any event = **HIGH** (violates flat-object invariant).
- New event type missing from `AnyPlatformEvent` union = **HIGH** (discriminated-union hole).
- Upcaster added without a test fixture for each source version = **HIGH**.
- `eventType` string not matching the interface name in PascalCase = **MEDIUM** (routing mismatch risk).
- Event consumer that does not validate inbound `tenantId` against the consumer's expected tenant context = **CRITICAL** (fail-open tenant leak).
- PII fields (email, phone, full name, national ID) written directly into event payloads without hashing or crypto-shredding = **HIGH** (GDPR/KVKK compliance risk — events are immutable and forever).
- `version` bump without a matching upcaster chain entry in `libs/event-contracts/src/upcasters/` = **CRITICAL** (stream replay breaks).
