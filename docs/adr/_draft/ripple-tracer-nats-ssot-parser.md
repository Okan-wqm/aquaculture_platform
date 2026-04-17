# DRAFT — Ripple-Tracer NATS Services.yaml SSoT Parser

**Status:** DRAFT / spec-only, implementation scheduled for W7.5 of the agent+skill+gate initiative.
**Closes:** /root/.claude/plans/declarative-riding-shamir.md BLOCKER-11 (Round 3).
**Depends on:** ADR-015 (NATS cert-is-identity SSoT — establishes services.yaml as authoritative).
**Supersedes:** the `ripple-tracer` grep-only consumer-enumeration strategy in Part D.3 of the plan.

---

## Context

Round-2 data-expert review (D1-CRITICAL) established that `ripple-tracer`'s proposed grep-based consumer enumeration is theater: NATS consumers subscribe to **wildcard subjects** like `AQUACULTURE_EVENTS.Sensor.>` or `events.sensor.*`, not to named TypeScript symbols. Grep over the repo cannot see these subscriptions; the ripple set will be silently incomplete; the entire `ripple-coverage` CI gate becomes false-assurance.

Per ADR-015, `infrastructure/nats/services.yaml` is the **single source of truth** for every NATS service's authorized publish and subscribe subjects. CI already enforces services.yaml ↔ nats.conf ↔ cert CN triple-lockstep via `e2e/tests/integration/nats-invariants.spec.ts`. This means the consumer registry is already authenticated, versioned, and drift-protected — ripple-tracer only needs to **consume** it, not maintain its own parallel registry.

## Proposed mechanism

`ripple-tracer`'s runtime-contract pass (the second of three passes — AST, runtime-contract, tests) SHALL resolve event consumers via the following algorithm:

1. **Load SSoT.** Parse `/var/aqua-saas/infrastructure/nats/services.yaml` into a typed model:
   ```ts
   interface NatsService {
     name: string;              // e.g. 'sensor_service'
     publish: string[];         // subject patterns this service may publish
     subscribe: string[];       // subject patterns this service may consume
   }
   ```
   Use the yaml library already present in the repo (no new dep).

2. **Extract changed event subjects.** For every changed file in the diff that defines or modifies an `AQUACULTURE_EVENTS.*` subject (detected via grep over `libs/event-contracts/src/**` + any inline `subject:` literal), compute the *concrete subject string(s)*.

3. **Match against subscribers.** For each concrete subject `S` from step 2:
   - For each service in the SSoT, evaluate whether any of its `subscribe:` patterns matches `S` using NATS subject-matching rules:
     - `>` matches one or more remaining tokens.
     - `*` matches exactly one token.
     - Literal match is case-sensitive.
   - Collect the matching services into `downstream.services[]`.

4. **Map services to repo paths.** For every matched service, enumerate its owning `apps/<service>/src/**` directory AND any file registering a subscription to `S` in that service (detected via `@EventPattern('S')` decorators or `natsClient.subscribe('S')` calls — AST-level, not grep).

5. **Merge into ripple set.** Add the enumerated paths to `ripple-set.json.downstream`.

## Why this is tier-1 ("make impossible"), not tier-3 ("detectable")

Any event emission change now **structurally** triggers ripple-coverage CI on every subscriber, regardless of how the subscriber is registered (decorator, wildcard pattern, dynamic). The consumer registry IS the SSoT; ripple-tracer cannot diverge from it because both read the same file. Grep-based enumeration fails the "if upstream were correct, would this code need to exist?" test — SSoT-driven does not.

## Determinism requirements (BLOCKER-11b)

- Sort the parsed services.yaml entries by `name` before iteration.
- Use NFC-normalized subject strings throughout (YAML may emit either NFC or NFD).
- Pin the `yaml` lib version in `package.json`; bump via Dependabot only.
- Output ripple-set.json with stable key ordering and lexicographically sorted arrays.
- Emit `Ripple-Hash: sha256:<hex>` in the commit trailer; CI re-runs tracer and asserts the hash matches.
- Determinism test: 10× identical-input invocations MUST produce byte-identical `ripple-set.json`.

## Edge cases

- **Catch-all `>` subscriber**: services with `subscribe: ["AQUACULTURE_EVENTS.>"]` match EVERY event. Ripple-tracer MUST flag this as a soft warning (not error) so domain experts know the catch-all consumer — usually an audit or analytics service — will be impacted.
- **Publisher is also subscriber**: self-subscription is a legitimate pattern for saga handlers. Include the originating service in the ripple set iff its `subscribe:` list contains a matching pattern.
- **Cross-tenant vs per-tenant subjects**: subject patterns are tenant-agnostic in services.yaml (tenancy is enforced by message-level claims, not subject names). Ripple-tracer does not need to distinguish; all matching consumers are in-scope.
- **`$JS.API.>` and `_INBOX.>`** are NATS internals, NOT domain events. Explicitly excluded from the AQUACULTURE_EVENTS matching pass.

## Implementation location

- Spec lives here (DRAFT) until W7.5 implementation.
- Implementation lands at `/var/aqua-saas/tools/gates/ripple-check.ts` (TypeScript, Node 22 type-stripping per BLOCKER-5).
- Promoted from DRAFT to canonical ADR once implementation merges. Target: new `docs/adr/017-ripple-tracer-ssot-consumer-enumeration.md` numbered after 016.

## Verification (W7.5 exit criterion)

1. Unit: sample services.yaml + synthetic diff → expected ripple set exactly.
2. Integration: real diff touching `libs/event-contracts/src/sensor/sensor-events.ts` produces a ripple set containing every service whose services.yaml `subscribe:` list matches `AQUACULTURE_EVENTS.Sensor.*`.
3. Determinism: 10 runs, byte-identical output.
4. Regression: if the parser silently drops a service from its output, the determinism test catches it via hash mismatch.

## Non-goals for W7.5

- Parsing dynamic subject construction (`\`${prefix}.${id}\``) — deferred to post-V1 with a tracked finding. In practice, dynamic subjects are tenant-id interpolation under a static prefix, and the prefix matches statically.
- Cross-repo consumer detection (e.g. a future external service subscribing via federation) — out of scope; services.yaml IS the registry for this repo.
