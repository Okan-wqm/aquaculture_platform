# Layer-1 Rust — Edge gateway patterns

**Audience:** edge-expert. Occasional reference by sensor-expert when cloud↔edge contract changes.
**Anchor:** Tokio 1.43 + axum 0.8 + rustls-native-certs 0.8 + thiserror 2.0 + anyhow 1.0 + tracing 0.1 + tracing-opentelemetry 0.28 + tokio-serial 5.4, as of 2026-04-16.

Scope: `/var/aqua-saas/sens-api-gateway/` crate. ADR-003 defines the sensor-service separation between this edge binary and the cloud sensor-service.

## Tokio runtime

- **`#[tokio::main]`** with explicit flavor: `multi_thread` for the main agent; `current_thread` only for single-task utilities. Never `#[tokio::main(flavor = "multi_thread", worker_threads = 1)]` — that's a smell indicating unclear runtime intent.
- **Cancellation** — prefer `tokio_util::sync::CancellationToken` over ad-hoc `broadcast::channel<()>` for shutdown signalling. The `shutdown.rs` module currently uses broadcast + `Vec<JoinHandle>` (EDGE-MEDIUM modernization in W1 audit) — W2/W3 migration target.
- **`tokio::select!`** — fair polling by default; use `biased` only when one branch should win (e.g., shutdown over work).
- **Bounded channels** — `mpsc::channel(capacity)` for backpressure. Unbounded channels (`mpsc::unbounded_channel`) are a silent memory leak under protocol bursts (W1 anti-pattern spot).
- **`spawn_blocking`** — for synchronous hardware calls (GPIO, serial). Budget a dedicated thread pool via `Builder::new_multi_thread().max_blocking_threads(N)`.
- **Structured spawn** — every `tokio::spawn` either owns a CancellationToken child OR its JoinHandle is tracked in a `TaskTracker`. Floating spawns break graceful shutdown.

## axum 0.8 routing

- **Extractors** — `State(state)`, `Path(id)`, `Query(params)`, `Json(body)`. Compose as needed; handler return type determines response format.
- **Middleware** — `tower::ServiceBuilder` composition. Prefer middleware for cross-cutting concerns (auth verification, request-id injection, metrics) over per-handler logic.
- **`IntoResponse` / `IntoResponseParts`** — custom response types implement these traits for ergonomic return values. Error types implement `IntoResponse` to map internal errors to HTTP codes.
- **WebSocket upgrade** — via `axum::extract::ws::WebSocketUpgrade`. Used for SCADA display + live-reading streams. Binary frames are legitimate `unsafe`-adjacent boundary (see `.claude/allowlists/boundary-files.yaml`).

## Error discipline

- **`thiserror` 2.0** — typed domain errors. Use for any library-module public signature. Derive `#[derive(Error, Debug)]` and declare variants per failure mode.
- **`anyhow`** — ONLY at binary boundaries (main.rs top-level, CLI commands where the full chain is irrelevant). Library modules returning `anyhow::Result<...>` hide the actual error variants from callers.
- **`?` operator** — propagation over `.unwrap()` / `.expect()`. Crate-level clippy lint wall at `deny(unwrap_used, expect_used, indexing_slicing, todo, unimplemented, dbg_macro)` enforces this.
- **`panic = "abort"`** in `Cargo.toml` release profile — any panic aborts rather than unwinding, because edge device auto-restart is the correct recovery. Side effect: `std::panic::catch_unwind` is non-functional; do not rely on it.
- **Result flattening** — `.and_then` / `.or_else` over nested `match` blocks. Keep error flow readable.

## TLS (rustls-native-certs 0.8)

- **Cert CN identity** — mTLS client cert with CN = `edge-<site-id>-<device-id>` per ADR-015. Never `danger_accept_invalid_certs(true)` — that would break cert-is-identity SSoT.
- **Root store** — `rustls-native-certs::load_native_certs()` for system trust store. Bundled CA roots only as a fallback documented per deployment.
- **TLS config lifecycle** — one `rustls::ClientConfig` per process; clone `Arc<ClientConfig>` for per-connection use.

## Industrial protocols

- **Modbus-TCP** via `tokio-modbus`; prefer `tokio-modbus::client::sync` only in tests. Production uses async `Context`.
- **MQTT** via `rumqttc`; `FailoverManager` (`mqtt_failover.rs`) wraps primary + backup broker with health-check-driven transitions. **EDGE-CRITICAL-001 is active** — caller `commands.rs:3334/3398` references `state.failover_manager` not declared in AppState. Fix W2 Day 1 per `docs/reviews/_audit/2026-04-W16-edge-critical-001-fix-proposal.md`.
- **I2C** via `linux-embedded-hal` actor pattern. Access serialized through a `I2cHandle` actor to avoid bus contention across tasks.
- **Serial (tokio-serial 5.4)** — UART / RS-485 handshaking. Framing per device vendor spec; no cross-device frame assumptions.

## Observability

- **`tracing` 0.1** — span-based structured logging. Every handler decorated with `#[instrument(skip(state))]` for automatic span creation.
- **`tracing-opentelemetry` 0.28** — OTLP export. Currently compiled in but **zero `#[instrument]` spans across 943 public functions** (W1 EDGE-MEDIUM modernization). W7 observability skill adds instrumentation.
- **Metrics** — `prometheus` scrape endpoint on a dedicated port. Labels avoid high-cardinality values (no tenant_id in edge metrics; tenant binding is per-device at cert level).

## SCADA + offline

- **`scada_db.rs`** — SQLCipher-backed local persistence. Key derived from `/etc/machine-id`; EDGE-CRITICAL-002 flagged that a failed read falls back to `"default-machine-id"` constant (IEC 62443 FR 4 bypass). W2/W3 joint fix with `offline_queue.rs` which already errors correctly on missing machine-id.
- **`offline_queue.rs`** — replays captured readings on reconnection. Idempotent via ingestion audit log on the cloud side.

## Clippy wall (crate-level)

Declared at `sens-api-gateway/src/lib.rs` or `main.rs` top:
```rust
#![deny(unwrap_used, expect_used, indexing_slicing, todo, unimplemented, dbg_macro, unsafe_code)]
#![warn(clippy::pedantic)]
```
Exceptions for `unsafe_code` live in narrowly-scoped `#[allow(unsafe_code)]` blocks in FFI shims (SX1302, GPIO mmap) — tracked in `.claude/allowlists/boundary-files.yaml`.

## References

- Slice audit: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-edge-rust.md`
- Fix proposal: `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-edge-critical-001-fix-proposal.md`
- ADR-003 (sensor-service separation), ADR-015 (cert-CN identity)
- `sens-api-gateway/Cargo.toml` — dep pins
