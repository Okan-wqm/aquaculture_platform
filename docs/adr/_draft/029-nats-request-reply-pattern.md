# ADR-029: NATS Request-Reply Pattern Adoption (`@platform/event-bus` Extension)

**Status:** Proposed
**Date:** 2026-04-22
**Deciders:** platform team, admin-api-service owner, sensor-ingestion owner
**Related:** ADR-014/015 (NATS cert-is-identity SSoT), ADR-006 (event flat pattern), Rust plan `snappy-sniffing-pine.md` Kör Nokta 6, PLATFORM-HIGH-001 orphan finding

## Context

The Rust sensor-ingestion sidecar needs an **authoritative policy snapshot** at boot: which tenants use the Rust backend and which stay on the Node backend (per ADR-014/015 cert-only identity). The plan (`snappy-sniffing-pine.md` Kör Nokta 6) prescribes NATS request-reply — sidecar requests `policy.ingest_backend.snapshot`, a responder returns the current global + per-tenant override state, the sidecar holds it in `ArcSwap` for lock-free hot-path reads.

Audit finding (PLATFORM-HIGH-001): `@platform/event-bus` (`platform/libs/event-bus/src/nats/nats-event-bus.ts`) exposes only `publish` / `subscribe` / `subscribeTo`. No `request` / `respond` primitives. The Rust side can call `async-nats::request()` directly, but there is no symmetric TS responder abstraction — every service wanting to reply would hand-roll its own NATS handler, losing subject-policy consistency, retry semantics, and telemetry wiring.

The decision is whether to extend the platform lib, hand-roll the Rust side only, or route the bootstrap through HTTP/gRPC instead.

## Decision

Extend `@platform/event-bus` with a request-reply primitive. Adopt it platform-wide; the sensor-ingestion sidecar + its admin-api responder are the first users.

### API surface

```typescript
// platform/libs/event-bus/src/nats/nats-request-reply.ts (new)
interface NatsRequestReply {
  request<TReq, TRes>(
    subject: string,
    payload: TReq,
    opts: { timeoutMs: number; correlationId?: string },
  ): Promise<TRes>;

  respond<TReq, TRes>(
    subject: string,
    handler: (req: TReq, meta: RequestMeta) => Promise<TRes>,
  ): Subscription;
}

interface RequestMeta {
  subject: string;
  replyTo: string;
  correlationId: string;
  untrustedAuthenticatedIdentityHeader?: string; // diagnostics only; never an auth source
}
```

### Rust side

`crates/nats-client/src/request_reply.rs`:

```rust
pub async fn request<Req, Res>(
    conn: &Client,
    subject: &str,
    payload: &Req,
    timeout: Duration,
) -> Result<Res, RequestError>
where
    Req: Serialize,
    Res: DeserializeOwned,
{ /* async-nats request() wrapped with typed serde + timeout */ }
```

Responders on the Rust side follow the same pattern using `Client::queue_subscribe` + send-to-reply-subject loop.

### Identity + authorization

- The NATS server authenticates the client certificate and authorizes subjects from the cert-CN
  policy generated under ADR-015. Core NATS messages do not carry the TLS peer identity to the
  responder.
- An `authenticated-identity` header is exposed only under the explicitly untrusted
  `untrustedAuthenticatedIdentityHeader` name and MUST NOT authorize a request. Narrower caller
  policy must use exact subjects/CN ACLs and authoritative application state.
- `nats.conf` `authorization.users[]` block lists `allow_publish`/`allow_subscribe` subjects per CN; the generate script (`scripts/nats/generate-nats-conf.py`) is extended to emit request-reply subjects per service declaration in `services.yaml`.

### Correlation + tracing

- `correlationId` defaults to `uuid::Uuid::new_v4()` if absent. Propagated through `RequestMeta`.
- W3C `traceparent` header (cf. ADR-030 / Rust plan Kör Nokta 3) piggybacks on the NATS message header — request-reply pairs appear as a single distributed trace.

### First adoption

1. **`admin-api-service`** registers a responder for `policy.ingest_backend.snapshot` — returns `{ global: 'rust' | 'node', overrides: Record<TenantId, 'rust' | 'node'> }` by reading `tenant_settings.ingest_backend_override`.
2. **`sensor-ingestion`** calls this responder at boot; holds snapshot in `ArcSwap<IngestBackendPolicy>`; subsequent `policy.ingest_backend.>` publishes (pub-sub) keep the ArcSwap in sync.

## Consequences

**Positive:**

- Policy snapshot, capability discovery, health probes — any request-reply pattern — has a single sanctioned primitive with telemetry, tracing, timeout, and broker-policy alignment built in.
- Rust ↔ TS symmetry; the Rust sidecar is not a second-class citizen.
- No new transport (HTTP/gRPC) added — NATS stays the single-plane identity SSoT.

**Negative:**

- Platform-wide API extension needs CODEOWNERS review from every service team that currently uses `@platform/event-bus` (14 services). Coordination cost.
- Responders are long-lived subscriptions; careful lifecycle management needed (stop on module shutdown, unsubscribe on DI teardown). The TS wrapper must wire into NestJS lifecycle hooks.

**Neutral:**

- `request()` with timeout + retry can re-trigger a responder (at-most-once is not guaranteed). Responders should be idempotent for the same `correlationId`. This is documented in the ADR but not enforced at the API layer.

## Alternatives Considered

1. **HTTP call from Rust → admin-api-service REST endpoint** — rejected. Introduces second auth surface (service-identity HMAC), breaks ADR-014/015 "NATS is the identity SSoT" principle, adds HTTP client + cert management to the Rust sidecar.
2. **gRPC** — rejected. Same two-plane concern + protobuf tooling overhead for a single endpoint today.
3. **Rust calls `async-nats::request()` directly, no TS abstraction** — rejected. The responder side (admin-api-service) would hand-roll NATS handling, losing subject-policy checks + telemetry + timeout uniformity. Every new responder re-implements the same code.
4. **Polling pub-sub (`policy.ingest_backend.announce` periodic broadcast)** — rejected. Either the broadcast is too frequent (bandwidth waste) or the sidecar's startup window may miss an announce (cold-start race).

## Cold-start failure mode (critical)

`sensor-ingestion` boot policy:

1. Call `request('policy.ingest_backend.snapshot', {}, { timeoutMs: 5_000 })`.
2. If timeout: retry 3× with exponential backoff (total wait ≤ 30s).
3. Throughout this window, `boot_mode = true`; the MQTT subscription does NOT start — no ingestion until policy is authoritative.
4. If all retries fail: load `/var/lib/sensor-ingestion/last-known-policy.json` (persisted on every `IngestBackendPolicyChangedEvent`); alert-raise `sensor_ingestion_boot_policy_fallback_total` counter; continue in degraded mode.
5. Once NATS is reachable again, the pub-sub subscriber catches up via normal `policy.ingest_backend.>` events.

This prevents the race where a NATS outage at sidecar boot causes wrong routing.

## Verification

- `nx test event-bus --testPathPattern=nats-request-reply`
- `cargo test -p sensor-ingestion --test cold_start_policy_snapshot`
  - `sidecar_blocks_ingestion_until_policy_snapshot_received`
  - `sidecar_uses_last_known_policy_after_nats_timeout`
  - `policy_request_reply_round_trip_under_100ms_p99`
- E2E: `e2e/tests/integration/nats-request-reply-invariants.spec.ts` — responder registered; request returns authoritative state; broker ACL rejects an unauthorized CN.
- `scripts/nats/generate-nats-conf.py` emits the request-reply subjects in `authorization.users[]`; `nats-invariants.spec.ts` asserts their presence.
