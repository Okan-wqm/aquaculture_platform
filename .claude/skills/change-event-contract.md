---
name: change-event-contract
description: Change an existing event contract — additive vs breaking classification, upcaster chain authoring, consumer enumeration via ripple-tracer, dual-publish protocol
type: skill
version: 1
owners: data-expert, architectural-arbiter, respective-producer-agent
handoff:
  on_complete_invoke: [data-expert]
  on_security_touch: security-reviewer
  on_event_impact: dynamic
  on_multi_tenant_touch: multi-tenant-saas-expert
---

# Skill — Change Event Contract

## When to invoke

Any edit to `libs/event-contracts/src/<svc>-events.ts` that is NOT a pure addition-of-optional-field. Examples:

- Rename or remove a field
- Narrow a field's type (string → `'a'|'b'` enum)
- Repurpose a field's semantic (same name, new meaning)
- Add a REQUIRED field
- Split one event into two, or merge two into one
- Change a sub-object's shape (even if the outer shape is the same — the wire type changed)

For simple optional-additive changes, use `add-entity-field` skill Step 6.

## Prerequisites

- The event interface is declared via the `createBaseEvent<T>()` factory with a branded `EventId` (per ADR-006).
- The producer service is identified (one of `farm-service`, `sensor-service`, `hr-service`, `messaging-service`, `billing-service`, `alert-engine`, `auth-service`, `admin-api-service`, `ai-service`, `hydroponics-service`, `notification-service`).
- Consumers have been enumerated via `tools/ripple-tracer/` — NOT via grep of TypeScript symbols (grep misses wildcard subscriptions like `AQUACULTURE_EVENTS.Sensor.>`; ripple-tracer reads `infrastructure/nats/services.yaml` SSoT per ADR-015).

## Cascade

### Step 1 — Classify change: additive vs breaking

**Affected files:** (analysis only)

**Mechanism:** per data-expert invariant, ADDITIVE = new optional field · new event in `AnyPlatformEvent` · widening `'a' → 'a' | 'b'` · aliased rename (both names present, old marked `@deprecated`). BREAKING = remove · rename without alias · narrow · repurpose · add REQUIRED · split · merge. Everything else is BREAKING by default — when in doubt, assume BREAKING.

**Why:** NATS JetStream is an append-only ledger — historical events live forever. Breaking changes without the 4-stage protocol = CRITICAL stream-replay break.

**Verification:** write a one-line classification in the package body. Ambiguous classifications escalate to `architectural-arbiter`.

**Cross-domain notifications:** `architectural-arbiter` (for ambiguous classifications or when multiple events are coupled).

### Step 2 — Bump event version + author upcaster

**Affected files:** `libs/event-contracts/src/<svc>-events.ts`, `libs/event-contracts/src/upcasters/<event-name>.upcaster.ts` (new file), `libs/event-contracts/src/upcasters/index.ts` (registry), `libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts` (test coverage).

**Mechanism:** bump `version: N → N+1` on the event interface. Create `<eventName>.upcaster.ts` exporting an `EventUpcaster` with `fromVersion: N, toVersion: N+1, upcast(event)` that transforms the v(N) payload into the v(N+1) shape. Register in `upcasters/index.ts` via `createDefaultRegistry().register(...)`. Write ≥3 unit tests in `upcasters.spec.ts` covering (a) v(N) input → v(N+1) output, (b) v(N+1) passthrough (idempotent), (c) edge cases (null / missing fields / type mismatches).

**Why:** data-expert invariant — shipping a version bump without a matching upcaster chain entry = CRITICAL. Stream replay breaks otherwise. Test coverage is W6 `upcaster-chain.spec.ts` invariant enforced.

**Verification:** `npx jest --config tests/invariants/jest.config.ts --testPathPatterns=upcaster-chain` pass. `npx jest libs/event-contracts/src/upcasters/__tests__/upcasters.spec.ts` pass.

**Cross-domain notifications:** `data-expert` primary on event-contract shape.

### Step 3 — Enumerate consumers via ripple-tracer

**Affected files:** (none — analysis + output captured in implementation-planner package).

**Mechanism:** invoke `tools/ripple-tracer/cli.ts --event <EventType>`. Output is a list of (service, subscription-subject, filter-pattern, consumer-file-path) tuples covering EVERY subscriber whose NATS filter matches the event's subject. This list is the authoritative consumer set for the dual-publish protocol.

**Why:** grep of TS symbols misses wildcard subscriptions (`AQUACULTURE_EVENTS.Sensor.>`) and NATS filter patterns. Per ADR-015 + ADR-017-draft, `services.yaml` is the SSoT — the tracer reads it.

**Verification:** package body includes the consumer-file list verbatim.

**Cross-domain notifications:** one dispatch target per consumer service.

### Step 4 — Dual-publish stage (producer emits BOTH versions)

**Affected files:** producer handler emitting the event — typically `apps/<svc>/src/<domain>/handlers/<command>.handler.ts`.

**Mechanism:** producer writes BOTH v(N) AND v(N+1) to the transactional outbox in the same transaction. NATS JetStream receives both subjects; consumers at v(N) continue to work. Duration of dual-publish window: ≥1 full deployment cycle of every consumer service — not a short grace period.

**Why:** consumer-migration safety. Cutting v(N) before consumers migrate = in-flight events lost.

**Verification:** feature flag or config toggle `DUAL_PUBLISH_<EVENT>=true` gates the dual-emit; PR body documents the feature-flag name + planned cutover date.

**Cross-domain notifications:** `infra-expert` (feature flag in config-service) + every consumer service per ripple-tracer output.

### Step 5 — Migrate each consumer to v(N+1)

**Affected files:** per ripple-tracer — typically `apps/<consumer-svc>/src/<domain>/subscribers/<event-name>.subscriber.ts` + `__tests__/*.spec.ts`.

**Mechanism:** each consumer handler subscribes to v(N+1) subject + updates its payload type to the new shape. Consumer keeps handling v(N) subject in parallel (the upcaster chain in the producer-emit doesn't help consumers — they must handle both subjects). When every consumer has landed v(N+1) handling, proceed to Step 6.

**Why:** atomic consumer cutover is impossible across services — the coordination cost is why the upcaster exists. v(N) handler presence until cutover = every deploy order works.

**Verification:** integration tests for each consumer passing against BOTH event versions. Prometheus dashboard monitoring handler-by-version count shows v(N+1) rising + v(N) stable.

**Cross-domain notifications:** orchestrator Phase 4 cross-domain resolution: every consumer's review is a mandatory dispatch in the cycle that lands the migration.

### Step 6 — Upcaster install at consumers (optional, for replay scenarios)

**Affected files:** consumer-side `createDefaultRegistry()` calls.

**Mechanism:** if the consumer replays historical events (e.g. event-store-service rebuilds projections), the upcaster registry is installed consumer-side. Live subscribers typically don't need it — but consumers that replay MUST have the upcaster chain registered or they choke on v(N) events.

**Why:** event-store-service + observability trace-replay both rehydrate from the append-only ledger. Missing upcaster at replay = projection build fails on old events.

**Verification:** event-store-service integration test replaying a v(N) event produces the v(N+1) projection row.

**Cross-domain notifications:** `data-expert` (event-store surface); `observability-expert` if trace replay is affected.

### Step 7 — Producer cleanup: stop emitting v(N)

**Affected files:** producer handler (reverts Step 4 dual-publish to single-emit at v(N+1)).

**Mechanism:** remove the `DUAL_PUBLISH_<EVENT>` feature flag; producer emits ONLY v(N+1). This is the final cutover commit.

**Why:** dual-publish forever = duplicate audit rows + doubled NATS throughput. The flag must be removed once the consumer-migration window closes.

**Verification:** Prometheus dashboard shows 0 emits at v(N) after deploy; producer unit tests updated to single-version.

**Cross-domain notifications:** `data-expert` closure; `context-manager` logs the full 4-stage cascade as a SYSTEMIC-safe operation.

## Validation checklist

- [ ] Step 1 classification PASS (additive / breaking declaration in package body).
- [ ] Step 2 upcaster + tests landed; `upcaster-chain.spec.ts` green.
- [ ] Step 3 ripple-tracer output captured verbatim in package.
- [ ] Step 4 dual-publish feature flag gated + deployed.
- [ ] Step 5 every consumer migrated (one dispatch target per consumer, all RESOLVED).
- [ ] Step 6 upcaster installed at replaying consumers (event-store, trace-replay).
- [ ] Step 7 producer cleanup commit + Prometheus v(N) emits = 0.

## Examples

- `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts` — v1→v2 nested-to-flat readings upcaster. Pattern reference for Step 2.
- `libs/event-contracts/src/upcasters/alert-triggered.upcaster.ts` — v1→v2 nested-to-flat triggeringData upcaster. Same pattern.
- `libs/event-contracts/src/upcasters/timestamp-to-string.upcaster.ts` — factory pattern for parameterised cross-event upcasters (Date → ISO 8601 string).

## Cross-references

- ADR-006 — event contract flat-pattern.
- ADR-015 — NATS cert-is-identity SSoT (services.yaml).
- ADR-017-draft — ripple-tracer services.yaml parser.
- `.claude/agents/data-expert.md` — event-contract-versioning invariants.
- `tests/invariants/upcaster-chain.spec.ts` — 1:1 coverage assertion.
- AUDIT-PACT-001 — Pact/Schemathesis is DEFERRED to post-V1; JSON Schema at NATS trust-boundary is the pre-V1 gating mechanism.

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable.
