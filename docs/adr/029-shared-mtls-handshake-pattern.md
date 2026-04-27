# ADR-029 — `NatsRequestReply` ↔ `NatsEventBus` share ONE mTLS handshake

- **Status:** Accepted — 2026-04-23 (documenting pattern that has been live since 2026-04-XX introduction of `NatsRequestReply`)
- **Deciders:** platform-kernel-expert, edge-expert, auth-security-expert
- **Supersedes:** none
- **Tracked finding:** closes AUDIT-MEDIUM-013 (madge false-positive circular-dep report)

## Context

In the 2026-04-22 cold audit, `madge --circular` reported `platform/libs/event-bus/src/nats/nats-event-bus.ts` ↔ `nats.module.ts` as a circular dependency (`AUDIT-MEDIUM-013`). Phase 2 verification surfaced that no actual import cycle exists — `NatsRequestReply` imports `NatsEventBus` (linear, not circular); both are providers in the same `EventBusModule.forRoot()`, which madge's static analysis classified as a cycle. madge's heuristic misfires on NestJS provider fan-in patterns.

**What is actually going on:**

- `NatsEventBus` owns the JetStream connection, upcaster registry, and pub/sub surface.
- `NatsRequestReply` is a sibling service that implements the request-reply NATS pattern (Core NATS, not JetStream) and piggybacks on the existing mTLS connection via `NatsEventBus.getRawConnection()`.
- The result: ONE mTLS handshake per process, serving both pub/sub (JetStream) and request-reply (Core NATS) surfaces.

Per ADR-015 (cert-is-identity SSoT), every TLS handshake is expensive and credential-bearing. Opening TWO handshakes per process would double the per-tenant certificate churn, double NATS server log noise, and double the blast radius of a leaked client cert. The fan-in pattern was introduced deliberately to avoid that.

## Decision

**Pattern — "shared mTLS handshake via fan-in DI":**

1. The `EventBusModule.forRoot()` provides both `NatsEventBus` and `NatsRequestReply` as NestJS providers.
2. `NatsRequestReply.constructor(private readonly eventBus: NatsEventBus)` injects the bus service.
3. `NatsRequestReply` calls `eventBus.getRawConnection()` to obtain the underlying `NatsConnection` (nats.js object) and issues `connection.request()` calls against it — no new handshake.
4. `NatsEventBus` and `NatsRequestReply` have DISTINCT responsibilities (JetStream pub/sub vs. Core NATS request-reply); neither is a wrapper around the other.

**This pattern is explicitly endorsed for any future sibling that needs the raw NATS connection** — e.g. a planned KV-store accessor (`NatsKVStore`) or a JetStream Object Store accessor (`NatsObjectStore`) — provided they follow the same rule: inject `NatsEventBus`, call `getRawConnection()`, never open a new `connect()` themselves.

## Alternatives considered

### A. Extract a connection-holder class and inject it into both services

Create a bare `NatsConnectionFactory` service whose only job is to hold the open `NatsConnection`. Both `NatsEventBus` and `NatsRequestReply` inject the factory instead of each other.

- **Pro:** clear single-responsibility; no inter-service dependency.
- **Con:** introduces a third provider just to break a dependency that ISN'T a problem. `NatsEventBus` is already the connection owner by construction (it runs the reconnection loop, the health probe, the subscription manager). Factory would duplicate that ownership or be a zero-logic passthrough.
- **Verdict:** rejected. The "cycle" reported by madge is a false positive on NestJS DI fan-in; there is nothing to break.

### B. Two separate NATS connections, one per service

Each service runs its own `connect()`. Conceptually clean (zero shared state) but operationally expensive.

- **Con:** doubles mTLS handshakes (ADR-015 cost), doubles cert renewal surface, doubles NATS server visible-connection count for dashboards.
- **Verdict:** rejected. Connection sharing is a load-bearing invariant, not an incidental optimization.

### C. Move `NatsRequestReply` inside `NatsEventBus` as a method

Add `eventBus.request(subject, payload)` directly on `NatsEventBus`, delete `NatsRequestReply`.

- **Pro:** eliminates the fan-in signature entirely.
- **Con:** conflates two bounded responsibilities (durable pub/sub vs. ephemeral request-reply) on one class. Future evolution (e.g. adding request-reply timeout policies, observation hooks, tracing) would bloat `NatsEventBus` indefinitely.
- **Verdict:** rejected. SRP is load-bearing at the service-class boundary.

## Consequences

- **Positive:** ADR documents the intent behind a pattern that previously lived only in inline code comments. Future cold audits + static analyzers will hit this ADR (via the `Refs:` line in `AUDIT-MEDIUM-013`'s closure) and self-filter.
- **Positive:** The fan-in shape becomes a reusable pattern for future NATS-adjacent services (KV store, object store, tracing injector).
- **Negative:** `madge --circular` will continue to emit a noise line for this chain. Mitigated by the invariant below.
- **Negative:** Unit-testing `NatsRequestReply` requires a `NatsEventBus` test double. Accepted — the alternative is duplicating connection logic in tests too.

## Enforcement

- `tests/invariants/madge-false-positives.spec.ts` (follow-up) will load the known-acceptable list of "madge-flags-but-not-really" chains (including this one) and fail if madge's output diverges from that list — so new genuine cycles can't hide behind the noise.
- `AUDIT-MEDIUM-013` is closed as false-positive by the commit landing this ADR (see `Closes:` trailer).

## References

- `platform/libs/event-bus/src/nats/nats-event-bus.ts:300` — `getRawConnection()` docstring explains the shared-handshake intent.
- `platform/libs/event-bus/src/nats/nats.module.ts:76` — inline comment pointing at this pattern ("NatsRequestReply depends on NatsEventBus for the raw connection so ONE mTLS handshake covers every caller.").
- `platform/libs/event-bus/src/nats/nats-request-reply.ts:169` — constructor injection point.
- ADR-015 (NATS cert-is-identity SSoT) — the parent ADR that makes mTLS handshake cost structurally material.
- `docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-MEDIUM-013` — the finding this ADR closes.
