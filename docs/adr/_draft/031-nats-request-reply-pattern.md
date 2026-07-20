# ADR-031: NATS Request-Reply Pattern Adoption (`@platform/event-bus` Extension)

**Status:** Accepted — Rust + TS sides landed across commits `f555cec2` (typed `request_reply` primitive in nats-client crate) → `d37e6231` (Rust `DynamicBackendPolicy` + cold-start bootstrap + NATS subscriber + disk fallback) → `189bcaf5` (TS `NatsRequestReply` typed primitive + error taxonomy) → `4254a6b1` (`@platform/event-contracts` `IngestBackendPolicyChangedEvent` wire contract) → `3c987bdc` (admin-api-service policy-snapshot responder + `IngestBackendPolicyChanged` publisher + V1787300000000 migration). The end-to-end `policy.ingest_backend.snapshot` round trip + `policy.ingest_backend.changed` hot-swap chain is live; live testcontainers integration test lands in PR-C #9 without breaking the invariant.
**Date:** 2026-04-22
**Deciders:** platform team, admin-api-service owner, sensor-ingestion owner
**Owner:** Okan
**Related ADRs:** ADR-006 (event flat pattern), ADR-014/015 (NATS cert-is-identity SSoT), ADR-025 (Rust sidecar architecture), ADR-027 (per-tenant IngestBackend toggle)
**Related orphan findings:** `docs/reviews/orphan-findings.md#ORPHAN-019` (RESOLVED by this ADR's implementation commits)
**Related plans:** `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 6 + 11 (cold-start disk persistence merged into this ADR per the delta plan)

---

## Context (WHY)

The Rust sensor-ingestion sidecar needs an **authoritative policy snapshot** at boot: which tenants use the Rust backend and which stay on the Node backend (per ADR-027 the toggle is per-tenant). The plan (`snappy-sniffing-pine.md` Kör Nokta 6) prescribes NATS request-reply — sidecar requests `policy.ingest_backend.snapshot`, a responder returns the current global + per-tenant override state, the sidecar holds it in `ArcSwap` for lock-free hot-path reads.

Audit finding: `@platform/event-bus` (`platform/libs/event-bus/src/nats/nats-event-bus.ts`) exposes only `publish` / `subscribe` / `subscribeTo`. No `request` / `respond` primitives. The Rust side can call `async-nats::request()` directly, but there is no symmetric TS responder abstraction — every service wanting to reply would hand-roll its own NATS handler, losing subject-policy consistency, retry semantics, and telemetry wiring.

The decision is whether to extend the platform lib, hand-roll the Rust side only, or route the bootstrap through HTTP/gRPC instead.

---

## Decision (WHAT)

Extend `@platform/event-bus` with a request-reply primitive. Adopt it platform-wide; the sensor-ingestion sidecar + its admin-api responder are the first users.

### API surface (as landed)

```typescript
// platform/libs/event-bus/src/nats/nats-request-reply.ts
@Injectable()
class NatsRequestReply implements IRequestReply {
  requestTyped<Req, Res>(
    subject: string,
    request: Req,
    options: { timeoutMs: number },
  ): Promise<Res>;

  respond<Req, Res>(
    subject: string,
    handler: RequestReplyHandler<Req, Res>,
  ): Promise<RequestReplyResponderHandle>;
}

type RequestReplyHandler<Req, Res> = (request: Req, context: RequestReplyContext) => Promise<Res>;

interface RequestReplyContext {
  subject: string;
  replySubject?: string;
  untrustedAuthenticatedIdentityHeader?: string; // diagnostics only; never an auth source
}

interface RequestReplyResponderHandle {
  drain(): Promise<void>;
  readonly subject: string;
}
```

Error taxonomy — one class per operator-alarm shelf:

- `RequestReplyTimeoutError` — responder did not answer within budget
- `RequestReplyTransportError` — NoResponders, broker disconnect, connection-null
- `RequestReplyEncodeError` — request body could not be JSON-encoded
- `RequestReplyDecodeError` — reply bytes could not be JSON-decoded
- `RequestReplyRemoteError` — responder surfaced a structured error envelope `{__error:true, code, message}`

Variance from original proposal:

- Method renamed from `request` → `requestTyped` for callsite clarity (there is already a `NatsConnection.request`; the typed variant communicates intent).
- `correlationId` dropped from the per-call options — the transport already surfaces it via NATS headers; the caller-owned field added complexity without a concrete consumer in the first adopter.
- `RequestMeta` → `RequestReplyContext` rename — matches the `Handler(request, context)` callback shape that feels natural to TS developers.
- `respond()` returns a handle with `drain()` (vs raw `Subscription`) so the lifecycle is explicit at shutdown.

### Rust side (as landed)

`crates/nats-client/src/request_reply.rs`:

```rust
pub async fn request_typed<Req, Res>(
    client: &NatsClient,
    subject: &str,
    request: &Req,
    budget: Duration,
) -> Result<Res, RequestError>
where
    Req: Serialize + Sync + ?Sized,
    Res: DeserializeOwned,
```

`RequestError` enumerates Timeout / Transport / Encode / Decode — same shelves as the TS side, different naming conventions per the language idiom (thiserror-based enum).

The Rust sidecar uses `request_typed` at cold-start in `apps/sensor-ingestion/src/policy.rs::bootstrap_policy` with a 3-retry × 5s-timeout budget; the `policy.ingest_backend.>` subscriber task calls `policy.apply_change()` on every decoded event + persists the resulting snapshot to disk so the next cold boot has durable fallback even if the broker is down.

### Identity + authorization

- The NATS server authenticates the client certificate and authorizes publish/subscribe subjects
  from the cert-CN policy generated under ADR-015. A responder does not receive the peer certificate
  identity through a Core NATS message.
- An `authenticated-identity` header is exposed only under the explicitly untrusted
  `untrustedAuthenticatedIdentityHeader` name. Applications MUST NOT use it for authorization.
  Narrower caller policy must be represented by exact broker subjects/CN ACLs and authoritative
  application state.
- `nats.conf` `authorization.users[]` block lists `allow_publish`/`allow_subscribe` subjects per CN; the generate script (`scripts/nats/generate-nats-conf.py`) is extended to emit request-reply subjects per service declaration in `services.yaml`.

### Correlation + tracing

- An `authenticated-identity` NATS header is publisher-controlled metadata. The request/reply
  primitive ignores it; it cannot surface the TLS peer identity or authorize a request.
- W3C `traceparent` header (ADR-032 Kör Nokta 3 — implemented by `crates/observability::trace_propagation`) piggybacks on the NATS message header; request-reply pairs appear as a single distributed trace.

### First adoption (as landed)

1. **`admin-api-service`** registers a responder for `policy.ingest_backend.snapshot` via `PolicySnapshotResponder.onModuleInit` (`apps/admin-api-service/src/policy/services/policy-snapshot.responder.ts`). Reply is the `IngestBackendSnapshot` projected from the `admin.ingest_backend_policy_state` singleton row.
2. **`sensor-ingestion`** calls this responder at boot via `policy::bootstrap_policy` in `apps/sensor-ingestion/src/policy.rs`; holds the snapshot in `ArcSwap<IngestBackendSnapshot>` (DynamicBackendPolicy) for lock-free hot-path reads; subsequent `policy.ingest_backend.>` publishes (pub-sub) keep the ArcSwap in sync.
3. **`admin-api-service`** publishes `IngestBackendPolicyChangedEvent` on `policy.ingest_backend.changed` via `IngestBackendPolicyService.applyChange` whenever an operator mutates the rollout decision; the Rust sidecar's subscriber applies the incremental change + persists the resulting snapshot to disk.

### Cold-start failure mode (as landed)

`sensor-ingestion` boot policy (see `apps/sensor-ingestion/src/policy.rs::bootstrap_policy`):

1. Call `request_typed::<(), IngestBackendSnapshot>('policy.ingest_backend.snapshot', &empty, 5s)`.
2. If timeout / transport error: retry per `IngestBackendConfig.snapshot_request_retries` (default 3). Worst-case cold-start wall-clock is ≤ 15s before the fallback engages.
3. If all retries fail: load `/var/lib/sensor-ingestion/last-known-policy.json` (the disk file that `spawn_policy_subscriber` refreshes on every successful `apply_change`). Returns `PolicySource::Disk`.
4. If the disk file is missing / corrupt: fall back to the operator-signed TOML config (`[ingest_backend]` section). Returns `PolicySource::Config`. Default is `defaultBackend = "node"` (fail-closed — no Rust-side processing).
5. `sensor_ingestion_policy_bootstrap_source_{nats,disk,config}_total` counters expose which step of the chain won, so operators see the fallback hit ratio on a dashboard.
6. Once NATS is reachable again, the pub-sub subscriber catches up via normal `policy.ingest_backend.>` events.

This prevents the race where a NATS outage at sidecar boot causes wrong routing, AND preserves operator intent across broker outages.

---

## Consequences

**Positive:**

- Policy snapshot, capability discovery, health probes — any request-reply pattern — has a single sanctioned primitive with telemetry, tracing, timeout, and broker-policy alignment built in.
- Rust ↔ TS symmetry; the Rust sidecar is not a second-class citizen.
- No new transport (HTTP/gRPC) added — NATS stays the single-plane identity SSoT.

**Negative:**

- Platform-wide API extension needs CODEOWNERS review from every service team that currently uses `@platform/event-bus` (14 services). Coordination cost.
- Responders are long-lived subscriptions; careful lifecycle management needed (stop on module shutdown, unsubscribe on DI teardown). The TS wrapper must wire into NestJS lifecycle hooks.

**Neutral:**

- `request()` with timeout + retry can re-trigger a responder (at-most-once is not guaranteed). Responders should be idempotent for the same `correlationId`. Documented in the ADR, not enforced at the API layer.

---

## Alternatives Considered

1. **HTTP call from Rust → admin-api-service REST endpoint** — rejected. Introduces second auth surface (service-identity HMAC), breaks ADR-014/015 "NATS is the identity SSoT" principle, adds HTTP client + cert management to the Rust sidecar.
2. **gRPC** — rejected. Same two-plane concern + protobuf tooling overhead for a single endpoint today.
3. **Rust calls `async-nats::request()` directly, no TS abstraction** — rejected. The responder side (admin-api-service) would hand-roll NATS handling, losing subject-policy checks + telemetry + timeout uniformity. Every new responder re-implements the same code.
4. **Polling pub-sub (`policy.ingest_backend.announce` periodic broadcast)** — rejected. Either the broadcast is too frequent (bandwidth waste) or the sidecar's startup window may miss an announce (cold-start race).

---

## Verification

- `nx test event-bus --testPathPattern=nats-request-reply`
- `cargo test -p sensor-ingestion --test cold_start_policy_snapshot`
  - `sidecar_blocks_ingestion_until_policy_snapshot_received`
  - `sidecar_uses_last_known_policy_after_nats_timeout`
  - `policy_request_reply_round_trip_under_100ms_p99`
- E2E: `e2e/tests/integration/nats-request-reply-invariants.spec.ts` — responder registered; request returns authoritative state; broker ACL rejects an unauthorized CN.
- `scripts/nats/generate-nats-conf.py` emits the request-reply subjects in `authorization.users[]`; `nats-invariants.spec.ts` asserts their presence.
