# Edge Rust Audit — 2026-04-W16

**Slice:** Rust edge gateway — Tokio 1.43, axum 0.8, rustls-native-certs 0.8, serde 1.0, serde_yaml 0.9, thiserror 2.0, anyhow 1.0, tracing 0.1, tokio-serial 5.4, tracing-opentelemetry 0.28.
**Scope:** `/var/aqua-saas/sens-api-gateway/` — `suderra-agent` v1.6.0, Rust 2024 edition, rustc 1.85. Single binary shipping to RevPi / RPi CM4+ edge hardware. 66 source files, ~1.36M bytes of Rust.
**Mode:** Read-only grep/glob/Read discovery; no cargo build, no tests executed.
**Owner agent:** edge-expert.

## Prior Work Check

Prior reviews under `docs/reviews/edge-expert/`:

- `2026-04-05-s2-high-findings.md` (S2 HIGH — older findings)
- `2026-04-10-full-repo-audit.md` (3 blocking findings: boot safe-state, PWA CDN precache, failover no-op)

**Status of 2026-04-10 findings (verified in this audit):**

| Prior ID | Status | Evidence |
|---|---|---|
| CRITICAL-001 boot safe-state | RESOLVED | `src/main.rs:1046-1096` — `SafeStateManager::from_config(...)` built after `init_hardware`, `apply()` runs before telemetry / script engine / commands. Boot aborts with `Err` if zero outputs reach safe-state when any are configured. |
| HIGH-002 PWA CDN precache | PARTIAL | `src/scada_server.rs:115-133` precache list is now all-local (vendored under `/libs/`). BUT CSP header still whitelists `https://unpkg.com` and `https://cdn.jsdelivr.net` at `scada_server.rs:776-777` — permits runtime CDN loads the precache no longer relies on. Half-fix; promoted to `EDGE-HIGH-002` below. |
| HIGH-003 failover no-op | BROKEN BUILD | `src/commands.rs:3334,3398` references `state.failover_manager.as_ref()`. `AppState` struct in `src/main.rs:240-282` does **not** declare `failover_manager`. No instantiation of `FailoverManager` exists outside `#[cfg(test)]`. Compile-error; promoted to `EDGE-CRITICAL-001` below. |

Recurring pattern: failover wiring has now been flagged in two consecutive audits without landing — SYSTEMIC finding surfaced to unified-audit.

---

## Table 1 — Pattern usage

| Pattern | Usage count | Version correctness | Example file:line | Modernization opportunity |
|---|---|---|---|---|
| Tokio runtime (explicit `Builder`, no `#[tokio::main]`) | 1 | Tuned for edge (`worker_threads=2`, `max_blocking_threads=8`, `thread_stack_size=128 KiB`) | `main.rs:416-421` | Document `max_blocking_threads=8` rationale vs. SQLite + `spawn_blocking` callsites (48 occurrences). |
| axum `Router::new()` + `.route(...)` | 2 routers, 20 `.route(...)` | axum 0.8 — correct extractor + `State` + `IntoResponse` | `health.rs:680-685` (4 endpoints), `scada_server.rs:1970-1984` (15 endpoints) | Extract shared middleware (CSP + CORS) into `tower::Layer`; unify two routers under `Router::merge`. |
| `thiserror` domain error types | 2 derives (both in `error.rs`) | thiserror 2.0 — correct | `error.rs:25` `ModbusError`, `error.rs:152` `AgentError` | HIGH: only 2 typed enums across 66 files. Most subsystems use `anyhow::Result` in their public API (see EDGE-HIGH-004). |
| `anyhow::Result` in library-module signatures | 40 callsites across 12 files | anyhow 1.0 — correct for binary boundaries; **incorrect** in library modules | `scripting/engine.rs:430,478,564,1015,1116,1988`, `commands.rs` 17 instances | Migrate scripting engine, command handler, telemetry, pwm, spi, i2c, gpio, plc_programming to typed `thiserror` variants. |
| `#[instrument]` / tracing spans | **0 occurrences** | tracing 0.1 — feature unused | — | CRITICAL observability gap. Zero structured spans across 943 public fns / 660 `pub fn|pub async fn`. See EDGE-HIGH-005. |
| `unsafe` blocks | 7 (all in `src/lora/sx1302.rs`) | All have `// SAFETY:` comments; single-threaded invariant documented | `sx1302.rs:168,205,210,291,320,351,378` | Wrap the SX1302 FFI boundary in a sealed `Sx1302Handle` actor — currently safety relies on comment-asserted "gateway event loop is single-threaded". |
| `.unwrap()` / `.expect()` total occurrences | 366 across 40 files | — | — | Majority (≥ 95 %) are in `#[cfg(test)]` blocks. Cargo.toml crate-level `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing))]` present in `main.rs:16`, so this is policy-compliant. Notable production exceptions flagged below. |
| `.unwrap()` / `.expect()` production uses | ~14 (with explicit `#[allow]` + justification) | OK | `scripting/context.rs:24` (static regex), `lora/crypto.rs:52` (CMAC key len), `lora/mac.rs:848` (position-verified VecDeque) | All reviewed carry `// SAFETY:` or `// BUG:` justifications. Pattern is deliberate. |
| MQTT protocol module | 1 (`mqtt.rs`) + 1 failover (`mqtt_failover.rs`) | rumqttc 0.25 — current | `mqtt.rs:229-276` `MqttClient::new` | See Table 2 re: cleartext fallback. |
| Modbus protocol module | 1 (`modbus.rs`) — rodbus 1.4 pinned | rodbus `=1.4.0` pinned for empty-path TLS server-only workaround documented in `Cargo.toml:66-70` | `modbus.rs` | Known upstream dependency risk — already tracked in pin comment. |
| PLC protocol modules | 5 (ADS, Codesys, EthernetIP, OPC UA, S7 comm) | Hand-rolled wire protocols | `plc_programming/opcua.rs` (214 KB — largest file in tree) | Consider opcua crate migration; hand-rolled OPC UA is a security + maintenance burden. Out of W1 scope. |
| TLS setup (rustls via rumqttc) | 1 site (`mqtt.rs:696-787`) | rustls-native-certs 0.8 via `TlsConfiguration::Rustls` + native-CA fallback, also `TlsConfiguration::Simple` when custom CA provided | `mqtt.rs:711-714` installs ring `CryptoProvider` | No `danger_accept_invalid_certs` or custom `ServerCertVerifier` — safe. Dangerous knob `verify_hostname=false` in config is **rejected at startup** with explicit error (`mqtt.rs:703-709`). |
| `tokio::select!` | 12 occurrences across 6 files | Tokio 1.43 — correct | `mqtt.rs:336-344` uses `biased;` to prevent message loss race | All branches reviewed resolve on cancel-safe primitives or wrapped in shutdown broadcast. |
| Structured cancellation (`CancellationToken` / `tokio_util::sync`) | **0 occurrences** | — | — | `shutdown.rs` uses `broadcast::channel::<()>` + `JoinHandle` list instead of `CancellationToken` + `TaskTracker`. See EDGE-MEDIUM-006. |
| `spawn_blocking` | 48 occurrences, 4 files | Tokio 1.43 — correct | `commands.rs:3, offline_queue.rs:32, scripting/persistence.rs:12, engine.rs:1` | Concentrated around SQLCipher calls. `max_blocking_threads=8` is tight for this volume — latency-sensitive hot path concern. |
| `tokio::spawn` | 25 occurrences across 14 files | Tokio 1.43 — correct | `main.rs` 8 instances, `mqtt.rs:282` event loop, `scada_server.rs:1` | Every `JoinHandle` that is tracked passes through `ShutdownCoordinator::register_task`. A few fire-and-forget `tokio::spawn(...)` calls exist — see EDGE-MEDIUM-007. |
| `Arc<Mutex<_>>` / `Arc<RwLock<_>>` | 86 occurrences across 13 files | mixed `std::sync::Mutex` vs `tokio::sync::Mutex` | `modbus.rs:1175`, `plc_programming/opcua.rs:1294-1307` 10+ fields | PLC protocol clients (ADS, Codesys, EthernetIP, OPC UA, S7) all wrap `Option<TcpStream>` in `Arc<tokio::sync::Mutex<>>` — justified (held across `.await`). OPC UA client has 13 separate `Arc<Mutex<_>>` fields (mod.rs:1294-1307) — lock-order auditing risk; see EDGE-MEDIUM-008. |
| `Atomic*` usage | 58 occurrences, 17 files | correct | `resilience/circuit_breaker.rs:10`, `offline_queue.rs:26`, `interning.rs:23` | Circuit breaker is lock-free via atomics (`AtomicU8/U32/U64`) with CAS and shared monotonic clock — matches edge-expert domain brief exactly. |

---

## Table 2 — Anti-pattern spots

| Pattern | Count | Example file:line | Severity | Fix direction |
|---|---|---|---|---|
| `unwrap()` on Result in production code without `// SAFETY:` comment | 2 | `scada_db.rs:71` `machine_uid::get().unwrap_or_else(\|_\| "default-machine-id".to_string())` | **CRITICAL** | Fallback constant key `"default-machine-id"` becomes the SQLCipher key for every device that fails to read `/etc/machine-id`. All such devices share one key. See EDGE-CRITICAL-002. |
| `anyhow::Result` in public library-module signatures | 40 callsites in 12 files | `scripting/engine.rs:430,478,564,1015,1116,1988,1993,1999,2004` 9 methods; `commands.rs` 17 methods | HIGH | Public scripting engine and command handler APIs should expose typed errors (`ScriptEngineError`, `CommandError`) — anyhow erases the error type and forces callers to string-match. See EDGE-HIGH-004. |
| `block_on` inside async context | 1 | `main.rs:435` `runtime.block_on(async_main())` | LOW | This is the runtime bootstrap, not an async-context call — legitimate. No real deadlock risk. |
| `mpsc::unbounded_channel` on external-input paths | 0 | — | — | **CLEAN.** All channels use `mpsc::channel(capacity)` or `broadcast::channel(capacity)`; no unbounded. |
| Missing `.await` on spawned futures (floating tasks) | 4 potential | `main.rs:1110` `tokio::spawn(io_poll::io_poll_loop(...))`, `main.rs:1145` `_scada_handle = ...`, `main.rs:1161` SCADA command executor, `mqtt.rs:282` event loop | MEDIUM | `io_poll_loop` and SCADA command executor are NOT registered with `ShutdownCoordinator`. On shutdown these tasks are aborted by runtime drop rather than graceful; inflight Modbus writes may tear. See EDGE-MEDIUM-007. |
| `Arc<Mutex<_>>` where `RwLock` / `ArcSwap` fits | 6 | `plc_programming/opcua.rs:1296,1297,1298,1299,1301,1307` — `Arc<Mutex<u32>>` for counters | LOW | Monotonic counters (`secure_channel_id`, `token_id`, `sequence_number`) should be `AtomicU32`. Current pattern blocks concurrent reads during an OPC UA request flight. |
| TLS config `danger_accept_invalid_certs(true)` | **0** | — | CLEAN | Hardened. `mqtt.rs:703-709` even rejects the `verify_hostname=false` YAML knob at startup. |
| Missing structured cancellation on long-running tasks | 3 tasks | `io_poll`, SCADA command executor, SCADA server background tasks | MEDIUM | `run_until_shutdown` pattern only works for tasks that `ShutdownCoordinator::register_task(...)` was called for. See EDGE-MEDIUM-006. |
| `panic!()` / `unreachable!()` / `todo!()` / `unimplemented!()` in production | 25 occurrences, 4 files | `st_validator.rs:5`, `scripting/limits.rs:1`, `plc_programming/opcua.rs:18`, `error.rs:1` | LOW | Spot-check of `st_validator.rs` shows parser-internal `unreachable!()` on proven-exhaustive cases. OPC UA file needs a closer look (out of W1 scope). |
| `Box::leak` / `mem::forget` on secret data | 0 | — | CLEAN | No leaks of `Secret<String>`. |
| `EventLoop::poll()` doing work other than polling | 0 | — | CLEAN | `mqtt.rs:282-305` poll task is minimal — only `select!` over `eventloop.poll()` and `message_tx.closed()`. No publish or subscribe inside poll loop. |
| MQTT `set_inflight` explicitly bounded | 0 | `mqtt.rs:229-270` | LOW | `set_keep_alive`, `set_clean_session`, `set_max_packet_size`, `set_last_will`, `set_credentials` all configured. `set_inflight(...)` is NOT set — defaults to rumqttc internal (10) but should be explicit. |
| Per-device X.509 client cert (mTLS) enforced in production | 0 enforcement | `mqtt.rs:730-741` — `client_auth` is Optional | HIGH | mTLS is OPTIONAL. Production path works with username+password + server-CA only. IEC 62443 FR 1 violation if deployed without mTLS. See EDGE-HIGH-003. |
| Health HTTP endpoint auth | 0 (zero auth) | `health.rs:680-685` — 4 anonymous endpoints including `/metrics` and `/diagnostics` | HIGH | `/metrics` and `/diagnostics` on anonymous HTTP is a reconnaissance primitive. See EDGE-HIGH-006. |
| SCADA command write path PIN / RBAC | Present (PIN session + `has_valid_pin_session()`) | `scada_server.rs:1242-1263` | OK | `SecurityLevel::Pin` path is wired. No `rbac.rs` gate module, but single PIN flow is consistent. |

---

## Table 3 — Modernization opportunities (prioritized)

| # | Opportunity | Rationale | Effort | Owner |
|---|---|---|---|---|
| 1 | **Adopt `tokio_util::sync::CancellationToken` + `TaskTracker`** for `ShutdownCoordinator` | Current pattern (broadcast channel + `Vec<JoinHandle>`) is 2019-era. CancellationToken gives O(1) structured cancellation with child-token trees; TaskTracker replaces manual `JoinHandle` bookkeeping. Edge-expert domain brief flags ad-hoc shutdown flags as FORBIDDEN — we have broadcast-based flags today. | M | edge-expert |
| 2 | **Add `#[instrument]` span coverage** across MQTT, Modbus, scripting engine, command handler | Zero structured spans today. With `tracing-opentelemetry 0.28` already in `Cargo.toml:153`, instrumenting ~60 hot-path public fns yields full distributed tracing at the cost of attribute annotation. Matches edge-expert brief on observability. | M | edge-expert |
| 3 | **Migrate public library-module APIs from `anyhow::Result` to typed `thiserror` enums** | 40 callsites in scripting engine, command handler, PLC protocols return `anyhow::Result<T>`. Typed errors enable deterministic retry / fallback / audit-logging per variant. `error.rs` already has `ModbusError` + `AgentError` as the precedent. | L | edge-expert |
| 4 | **Replace `Arc<Mutex<u32>>` counters in OPC UA client with `AtomicU32`** | 6 counter fields in `plc_programming/opcua.rs:1296-1305` are monotonic integers guarded by blocking mutexes. `AtomicU32::fetch_add(1, Ordering::Relaxed)` eliminates lock contention during concurrent OPC UA operations. Zero API change. | S | edge-expert |
| 5 | **Wire `FailoverManager` into `AppState` and runtime startup** | Currently a compile error (see EDGE-CRITICAL-001). Orthogonal fix: once field exists, the `failover_config.health_check_interval_secs` task must be spawned under `ShutdownCoordinator` and the primary/backup `MqttClient` swap must go through the existing offline queue. | M | edge-expert (coordination with sensor-expert on MQTT topic contract) |
| 6 | **Reduce `anyhow` surface to true binary-boundary paths (main.rs / CLI args)** | Paired with #3. `main.rs:448` `async fn async_main() -> Result<()>` with `anyhow::Result` is the idiomatic boundary; interior modules should not re-export `anyhow`. | L | edge-expert |
| 7 | **Consider `axum::middleware::from_fn` for auth layer** | `health.rs` and `scada_server.rs` both build an axum 0.8 router with no middleware stack (0 `.layer(...)` calls for auth). A single `AuthLayer` extracting Bearer-token / mTLS client-cert would enforce EDGE-HIGH-006 and be reusable. | S | edge-expert + auth-security-expert |
| 8 | **Replace `broadcast::channel::<()>` shutdown with watch channel + drop-guard** | Shutdown broadcast capacity is 16 (`shutdown.rs:25`); a tokio watch channel `watch::channel(bool)` + `changed().await` is the canonical single-producer/many-consumer shutdown primitive, with no capacity tuning. | S | edge-expert |

---

## ADR enforcement check

| ADR | Enforcement kind | Gap | Severity |
|---|---|---|---|
| ADR-003 sensor-service-separation | Documentary (edge-expert brief enforces MQTT topic shape + rumqttc usage) | MQTT topic structure resolution lives in `mqtt.rs:219` → `config.mqtt.topics.resolve(tenant_id, &config.device_id)`. No build-time test that a topic produced by `resolve()` matches sensor-service expectations. Cross-contract drift would be runtime-only. | MEDIUM — tracked via cross-domain dependency with sensor-expert |
| CLAUDE.md "Every fix commit carries `Closes: docs/reviews/.../#finding-id`" | PR-review (human) | Prior audit findings HIGH-002 and HIGH-003 show no `Closes:` commit; HIGH-003 is actively broken in the tree. Process-level finding. | HIGH-process |
| Cargo.toml `#![deny(clippy::unwrap_used, expect_used, indexing_slicing, todo, unimplemented, dbg_macro)]` | CI lint gate | Enforced per `Cargo.toml:204-213` — visible as `[lints.clippy] deny` block. CI must run `cargo clippy --all-targets --all-features`. | LOW — verify CI invokes clippy with `--deny warnings`. |
| `unsafe_op_in_unsafe_fn = "deny"` in `Cargo.toml:216` | Rustc lint | Enforced. 7 unsafe blocks in `lora/sx1302.rs` all carry explicit `unsafe { ... }` per rust-2024 edition requirement. | LOW — OK |
| `panic = "abort"` in release profile (`Cargo.toml:196`) | Build config | Enforced. Matches edge-expert brief (abort + systemd Restart). | LOW — OK |
| Edge-expert brief: "mTLS REQUIRED in production; shared fleet credentials FORBIDDEN" | Doc-only | `mqtt.rs:730-741` makes client auth optional. `username+password` path works unguarded. No startup check that rejects username-only config in "production" mode. | HIGH — EDGE-HIGH-003 |
| Edge-expert brief: "Health HTTP endpoint gated by authenticated token or mTLS" | Doc-only | `health.rs` exposes 4 anonymous endpoints. | HIGH — EDGE-HIGH-006 |

---

## Findings

### EDGE-CRITICAL-001 — `state.failover_manager` field does not exist; tree does not compile

**Evidence:** `sens-api-gateway/src/commands.rs:3334` and `:3398` reference `state.failover_manager.as_ref()`. `AppState` struct in `sens-api-gateway/src/main.rs:240-282` declares `config`, `mqtt_client`, `modbus_handle`, `gpio_handle`, `i2c_handle`, `process_image`, `alarm_manager`, `script_storage`, `lora_handle` (feature-gated), `scada_state` (feature-gated), `scada_db` (feature-gated), `is_activated`, `tenant_id`. No `failover_manager` field exists on any cfg. `FailoverManager::new(...)` is invoked only inside `#[cfg(test)] mod tests` in `mqtt_failover.rs:499-593`.

**Problem:** The code as committed cannot build on the default feature set. Either (a) the CI for this crate is not running `cargo build` on this branch, or (b) the crate has not been built since this change landed. This breaks `nx affected --target=build` for the edge gateway and means no one can deploy from HEAD. It also means the "HIGH-003 failover" finding from `2026-04-10-full-repo-audit.md` was superficially patched in `commands.rs` without being wired end-to-end — a pure workaround of the kind CLAUDE.md explicitly bans.

**Root cause:** Incremental fix against a prior review introduced a reference to a not-yet-declared field. No integration smoke test surfaced it. CLAUDE.md "Closes:" convention would have forced the reviewer to verify the field exists.

**Remediation:** Declare `pub failover_manager: Option<Arc<FailoverManager>>` on `AppState`, construct it in `async_main` after MQTT init, register its health-check task with `ShutdownCoordinator`, and ensure `force_failover` / `force_recovery` propagate through the existing offline queue on state transitions. If the full wiring cannot land this cycle, the commands must return an explicit "not implemented" error at compile-time — not reference a non-existent field.

**Cross-domain dependency:** sensor-expert (MQTT broker failover semantics end-to-end), architectural-arbiter (ownership of failover state — AppState vs dedicated FailoverService).

### EDGE-CRITICAL-002 — SCADA SQLCipher key collapses to a shared constant when `machine-id` is missing

**Evidence:** `sens-api-gateway/src/scada_db.rs:71`:

```rust
let machine_id = machine_uid::get().unwrap_or_else(|_| "default-machine-id".to_string());
```

The hashed result becomes the SQLCipher `PRAGMA key` at `scada_db.rs:98-100`. Compare with `offline_queue.rs:41-60`, which correctly **errors** on missing machine-id rather than fall back.

**Problem:** Every edge device that fails to read `/etc/machine-id` (permission issues, fresh dbus install, cross-device image clone before first boot, container without `/etc/machine-id` mounted, etc.) produces an identical SQLCipher key derived from the constant string `"default-machine-id"`. An attacker who extracts one such device's database can decrypt every other fallback-affected device's database. This is a complete IEC 62443 FR 4 (data confidentiality) bypass on the SCADA trend + alarm store.

**Root cause:** `unwrap_or_else(|_| "default-machine-id".to_string())` is a defensive-programming patch — the kind explicitly banned by CLAUDE.md Architectural Approach. The "architectural fix" is identical to what `offline_queue.rs:41` already does: refuse to open the database and fail startup.

**Remediation:** Change `derive_db_key()` to return `Result<String, ScadaDbError>`, error when machine-id retrieval fails, and have `ScadaDb::new` propagate the error so the SCADA feature starts in disabled mode rather than with a shared key. Consider consolidating SCADA DB key derivation with `offline_queue::derive_db_encryption_key()` — both should share the same TPM-sealed / machine-id + per-device secret-file derivation path.

**Cross-domain dependency:** security-reviewer (IEC 62443 FR 4), database-reviewer (SQLCipher key-management SSoT).

### EDGE-HIGH-001 — Two prior-audit findings ship without `Closes:` commit linkage (process finding)

**Evidence:** Prior review `docs/reviews/edge-expert/2026-04-10-full-repo-audit.md` raised CRITICAL-001, HIGH-002, HIGH-003. Current tree shows:

- CRITICAL-001: fixed, no `Closes:` commit visible in recent git log excerpts.
- HIGH-002: half-fixed (precache local, CSP still references CDN).
- HIGH-003: compile-broken (see EDGE-CRITICAL-001).

**Problem:** CLAUDE.md "Review Finding Traceability" section mandates that every fix commit carry `Closes: docs/reviews/…#finding-id`. Without that link, `docs/reviews/` becomes write-only — the exact failure mode CLAUDE.md calls out. Missing `Closes:` on a fix for a CRITICAL life-safety finding is a process HIGH.

**Root cause:** Convention is documented but unenforced by commit-message hook.

**Remediation:** Add a commit-msg hook that rejects commits whose diff touches `sens-api-gateway/**` without a `Closes:` footer OR a tracked exemption. Enforcement is out of edge-expert scope; flag to architectural-arbiter and context-manager.

### EDGE-HIGH-002 — SCADA CSP still whitelists `https://unpkg.com` and `https://cdn.jsdelivr.net`

**Evidence:** `sens-api-gateway/src/scada_server.rs:776-777` inside `format!` macro:

```
script-src 'nonce-{nonce}' 'strict-dynamic' https://unpkg.com https://cdn.jsdelivr.net; \
style-src 'self' 'unsafe-inline' https://unpkg.com; \
```

**Problem:** Prior audit HIGH-002 fixed the service-worker precache list but left the CSP loose. The CSP is the wider attack surface: with `strict-dynamic` plus two CDN origins, any script that the nonce-loader fetches can pull code from those CDNs at runtime. On an air-gapped edge device that call just fails (availability loss); on a NAT'd device it fully bypasses the "vendored assets" hardening the precache was meant to provide. `'unsafe-inline'` in `style-src` is an additional soft finding.

**Root cause:** The prior fix was partial — targeted the service worker but not the HTTP response CSP. Consistent with the EDGE-HIGH-001 process finding: without a finding-id-linked PR checklist, partial fixes ship as complete.

**Remediation:** Tighten CSP to `script-src 'nonce-{nonce}' 'strict-dynamic'; style-src 'self'; connect-src 'self' ws: wss:;` — no external origins. Remove `'unsafe-inline'` by hashing the current inline styles or moving them to same-origin files.

**Cross-domain dependency:** frontend-expert (HMI asset build) — same owner as prior HIGH-002.

### EDGE-HIGH-003 — mTLS is optional on the production MQTT path

**Evidence:** `sens-api-gateway/src/mqtt.rs:730-741`:

```rust
let client_auth = if let (Some(cert_path), Some(key_path)) =
    (&tls_config.client_cert_path, &tls_config.client_key_path)
{
    // ... load cert+key
    Some((cert_bytes, key_bytes))
} else {
    None
};
```

When the YAML config omits `client_cert_path` / `client_key_path`, `client_auth` is `None`, and the MQTT session falls back to username + password authentication alone (`mqtt.rs:237`).

**Problem:** Per edge-expert domain brief and IEC 62443 FR 1: "mTLS (client certificate) REQUIRED in production; username/password alone is insufficient. Per-device X.509 cert from `provisioning.rs`, issued by fleet CA; shared fleet credentials FORBIDDEN." The current code makes mTLS an opt-in; operators deploying a device with a config that omits client_cert get a technically-working MQTT connection that fails this requirement silently.

**Root cause:** No startup-time assertion that rejects username-only config in a "production" mode. The `strict-security` feature flag exists in `Cargo.toml:175` but is unused.

**Remediation:** Wire `strict-security` to fail-fast in `MqttClient::new` if `client_cert_path.is_none() && client_key_path.is_none()` under that feature. Default production systemd unit must enable `strict-security`. Provisioning flow must deposit the per-device cert at the path config points to.

**Cross-domain dependency:** security-reviewer (FR 1 compliance audit), sensor-expert (backend MQTT broker must accept per-device certs, not a shared fleet cert).

### EDGE-HIGH-004 — Scripting engine and command handler return `anyhow::Result` from public APIs

**Evidence:** `sens-api-gateway/src/scripting/engine.rs` — 11 public methods return `anyhow::Result<T>`:

- `configure_from_program() -> anyhow::Result<()>` (line 430)
- `init() -> anyhow::Result<()>` (line 478)
- `save_retain_variables() -> anyhow::Result<()>` (line 564)
- `save_all_state() -> anyhow::Result<()>` (line 1015)
- `execute_script(id) -> anyhow::Result<ExecutionResult>` (line 1116)
- `add_script(def) -> anyhow::Result<()>` (line 1988), `delete_script`, `enable_script`, `disable_script` (1993, 1999, 2004)

`sens-api-gateway/src/commands.rs` — 17 occurrences. `sens-api-gateway/src/io_poll.rs`, `telemetry.rs`, `atlas_ezo.rs`, `gpio.rs`, `pwm.rs`, `spi.rs`, `i2c.rs`, `safe_state.rs` all expose `anyhow::Result` at module boundaries.

**Problem:** `anyhow::Error` erases the source type. Callers of `execute_script` cannot distinguish "script not found" from "scan-cycle overrun" from "FB write conflict" from "SQLite DB locked" — they can only read the string or propagate upward. This blocks deterministic retry (circuit breaker can't classify error as transient vs permanent), blocks tenant-visible error translation (MQTT command response must convey specific codes), and defeats the precedent set by `error.rs` for `ModbusError` + `AgentError`. edge-expert brief: errors must be typed where the reader needs to switch on them.

**Root cause:** Initial scripting engine implementation used anyhow for velocity; later modules followed the same pattern. The banned phrase "for now" is implicit in the decision.

**Remediation:** Add `ScriptEngineError`, `CommandError`, `IoActorError` in `error.rs`, migrate public signatures. Interior `?` propagation can still use `anyhow`; conversion at module boundary is a `From` impl. This is an L-effort refactor; track in a follow-up plan and schedule.

### EDGE-HIGH-005 — Zero `#[instrument]` / tracing-span coverage across 66 source files, 943 public fns

**Evidence:** Grep for `tracing::instrument|#\[instrument` returns 0 across the crate. `tracing 0.1` and `tracing-opentelemetry 0.28` are both compiled in (`Cargo.toml:39,153`). `tracing::info!/warn!/error!/debug!/trace!` macros are used extensively as plain-text log calls.

**Problem:** With no structured spans, distributed traces from backend → gateway → PLC stop at the gateway boundary. A Modbus write that takes 2 s shows up as an unrelated info log; an OPC UA session drop-and-reconnect looks like uncorrelated events. Edge-expert brief calls for per-scan-cycle observability on scripting engine + per-request observability on Modbus — neither is currently possible. `tracing-opentelemetry` is compiled in as dead weight.

**Root cause:** Span coverage was never added to the pre-existing text-log approach.

**Remediation:** Instrument the hot-path public APIs (MQTT publish/subscribe, Modbus read/write, script-engine execute_script, command handler handle_message, scripting-engine scan cycle, offline-queue enqueue/dequeue) with `#[instrument(skip(self), fields(...))]`. Wire OTLP exporter in `main.rs` behind the `telemetry` feature. M-effort; drop-in with no API break.

### EDGE-HIGH-006 — Health HTTP server exposes `/metrics` and `/diagnostics` without authentication

**Evidence:** `sens-api-gateway/src/health.rs:680-685`:

```rust
let app = Router::new()
    .route("/health", get(health_handler))
    .route("/ready", get(ready_handler))
    .route("/metrics", get(metrics_handler))
    .route("/diagnostics", get(diagnostics_handler))
    .with_state(state);
```

No `.layer(...)` call. No auth middleware. Searching `health.rs` for `auth|jwt|Authorization|Bearer` returns 0 matches.

**Problem:** `/metrics` (typically Prometheus-style internal counters) and `/diagnostics` (typically process internals) are reconnaissance primitives on an ICS device. A network-adjacent attacker can map sensor IDs, current alarm states, MQTT queue depths, and device uptime without authentication. Edge-expert brief requires these endpoints be gated by authenticated token or mTLS; anonymous `/metrics` is explicitly called out as forbidden in production.

**Root cause:** Health server was built for "is the agent alive" probes and never hardened as the `/diagnostics` and `/metrics` handlers were added.

**Remediation:** Split `/health` (anonymous liveness) from `/ready`, `/metrics`, `/diagnostics` (authenticated). Bind `/health` to localhost only by default. Require a Bearer token loaded from `/etc/suderra/health.token` (same pattern as `offline_queue.rs` db.key file) on the authenticated paths. If the health server is only ever scraped by a local Prometheus sidecar, bind to 127.0.0.1 exclusively.

**Cross-domain dependency:** auth-security-expert (Bearer token schema), security-reviewer (FR 1 + FR 5 validation).

### EDGE-MEDIUM-001 — MQTT `set_inflight(...)` not explicitly configured

**Evidence:** `sens-api-gateway/src/mqtt.rs:230-270` — `MqttOptions` configured with `set_credentials`, `set_keep_alive`, `set_clean_session`, `set_max_packet_size`, `set_last_will`. `set_inflight(...)` is not called. rumqttc default is 10 — not unreasonable, but unbounded in the reviewer's eye since it is not auditable from the source.

**Problem:** Edge-expert brief requires `set_inflight(≤100)` explicitly. On a constrained device flooded with QoS 1 messages, a 10-ack-window can still cause `Pkid overflow` if the broker reorders heavily. An explicit cap + a telemetry counter on in-flight utilisation is the enterprise pattern.

**Remediation:** `options.set_inflight(50);` with a `// SOURCE: edge-expert brief, IEC 62443 FR 7` comment. Expose as `config.mqtt.inflight_limit` with default 50, max 100.

### EDGE-MEDIUM-002 — `max_blocking_threads=8` may be tight for SQLCipher volume

**Evidence:** `main.rs:418` sets `.max_blocking_threads(8)`. Grep counts 48 `spawn_blocking` callsites across `commands.rs`, `offline_queue.rs`, `scripting/persistence.rs`, `scripting/engine.rs` — predominantly SQLCipher reads/writes.

**Problem:** Under a burst (e.g. scripting engine saving RETAIN variables for 30 scripts while offline queue is flushing) the blocking pool can fully saturate, converting further spawn_blocking calls into head-of-line blocking on the queue. Edge-expert brief: `spawn_blocking` tasks cannot be aborted; saturation forms a DoS-in-depth. The brief recommends pairing callsites with a `Semaphore`.

**Remediation:** Measure actual concurrency with a `tracing::Span::current().enter()` counter for one week; tune to p99 + 2. Add a dedicated `Semaphore::new(6)` around SQLCipher operations so offline-queue flush cannot starve script-engine persistence.

### EDGE-MEDIUM-003 — OPC UA client uses `Arc<Mutex<u32>>` for monotonic counters

**Evidence:** `plc_programming/opcua.rs:1296-1305` — 6 counter fields (`secure_channel_id`, `token_id`, `sequence_number`, `request_id`, `token_lifetime_ms`, `negotiated_pdu`) are `Arc<Mutex<u32>>`.

**Problem:** These are monotonic. Mutex on a counter serializes concurrent OPC UA requests unnecessarily. `AtomicU32::fetch_add(1, Ordering::Relaxed)` is the right primitive. Low severity because OPC UA is a single-connection protocol, but the pattern is a smell and blocks future multi-channel work.

**Remediation:** Replace with `AtomicU32` / `AtomicU16`. Zero behaviour change.

### EDGE-MEDIUM-004 — OPC UA client hand-rolled (214 KB, 1 file)

**Evidence:** `plc_programming/opcua.rs` is 214 KB — the largest file in the repo. It implements OPC UA binary protocol, secure channels, nonces, tokens, sessions, and keepalive by hand.

**Problem:** OPC UA is a spec-bound protocol. Hand-rolled implementations accumulate security debt (nonce reuse, token expiry, secure-channel re-key). Out of W1 scope, but flagging because it exceeds the audit scope of a W1 discovery and is a long-term maintenance risk.

**Remediation:** Scoping review with architectural-arbiter; evaluate `opcua` crate (BSD-3). Out of W1.

### EDGE-MEDIUM-005 — `shutdown.rs` uses broadcast + Vec<JoinHandle> instead of `CancellationToken` + `TaskTracker`

**Evidence:** `sens-api-gateway/src/shutdown.rs:30-33` — `ShutdownCoordinator { notify: broadcast::Sender<()>, tasks: Vec<(&'static str, JoinHandle<()>)> }`. Zero `CancellationToken` usage across the crate.

**Problem:** Edge-expert brief: "`shutdown.rs` uses `tokio_util::sync::CancellationToken` + `tokio_util::task::TaskTracker` (or `JoinSet`); ad-hoc `AtomicBool` shutdown flags FORBIDDEN." Current pattern is not an `AtomicBool`, but it is functionally equivalent — capacity-16 broadcast channel acting as a "has shutdown fired" flag. `CancellationToken::child_token()` gives structured cancellation that propagates down a task tree; the current flat model requires every task to subscribe at creation time.

**Remediation:** Replace `ShutdownCoordinator` internals with `CancellationToken`. Migrate `run_until_shutdown(task, rx)` to `cancellation_token.run_until_cancelled(task)`. Migrate `register_task` to `TaskTracker::spawn`. Public callsite surface is tiny (6 call sites), so the refactor is S-effort.

### EDGE-MEDIUM-006 — Several `tokio::spawn(...)` tasks not registered with `ShutdownCoordinator`

**Evidence:**

- `main.rs:1110` `tokio::spawn(io_poll::io_poll_loop(state.clone()));` — I/O poll loop, not tracked.
- `main.rs:1145` `let _scada_handle = scada_server::start_scada_server(...).await;` — SCADA HTTP/WS server, handle discarded (`_` prefix).
- `main.rs:1161` SCADA command executor task — not tracked.
- `mqtt.rs:282` MQTT event loop — tracked via `event_loop_handle: Some(event_loop_handle)` but not via `ShutdownCoordinator`.

**Problem:** On shutdown these tasks are aborted by runtime drop rather than given time to drain. SCADA command executor mid-write can tear a Modbus write mid-frame (documented edge-expert shutdown-order violation). `io_poll_loop` mid-read can leave a Modbus slave in an undefined state.

**Remediation:** All three should move to `shutdown_coordinator.register_task(...)` pattern (or `TaskTracker::spawn` once EDGE-MEDIUM-005 lands). MQTT event loop shutdown already drains via `handle.abort()` in `MqttClient::disconnect` — acceptable but should also be registered so its `JoinError::is_panic()` is reported centrally.

### EDGE-LOW-001 — `Cargo.toml` lints only cover clippy lints, not rustc warnings

**Evidence:** `Cargo.toml:204-213` deny list is clippy-only. Only `unsafe_op_in_unsafe_fn = "deny"` is in `[lints.rust]`. `unused_variables`, `unused_must_use`, `dead_code` are default (warn).

**Problem:** `dead_code` warnings are silenced per-file with `#![allow(dead_code)]` in several places (`error.rs:5`, `mqtt_failover.rs:1`, `resilience/mod.rs:4`). Legitimate in some cases, but the pattern is the kind that hides real problems. The edge-expert brief lint wall includes more than the current list.

**Remediation:** Add `[lints.rust] missing_docs = "warn"`, `rust_2024_compatibility = "warn"`, `unused_must_use = "deny"` and review every `#![allow(dead_code)]`.

---

## References (file paths, absolute)

- `/var/aqua-saas/sens-api-gateway/Cargo.toml`
- `/var/aqua-saas/sens-api-gateway/src/main.rs` (runtime bootstrap, safe-state apply, shutdown orchestration)
- `/var/aqua-saas/sens-api-gateway/src/commands.rs` (EDGE-CRITICAL-001)
- `/var/aqua-saas/sens-api-gateway/src/scada_db.rs` (EDGE-CRITICAL-002)
- `/var/aqua-saas/sens-api-gateway/src/scada_server.rs` (EDGE-HIGH-002)
- `/var/aqua-saas/sens-api-gateway/src/mqtt.rs` (EDGE-HIGH-003, EDGE-MEDIUM-001)
- `/var/aqua-saas/sens-api-gateway/src/mqtt_failover.rs` (EDGE-CRITICAL-001)
- `/var/aqua-saas/sens-api-gateway/src/health.rs` (EDGE-HIGH-006)
- `/var/aqua-saas/sens-api-gateway/src/shutdown.rs` (EDGE-MEDIUM-005)
- `/var/aqua-saas/sens-api-gateway/src/offline_queue.rs` (SQLCipher key-derivation reference for EDGE-CRITICAL-002 remediation)
- `/var/aqua-saas/sens-api-gateway/src/scripting/engine.rs` (EDGE-HIGH-004)
- `/var/aqua-saas/sens-api-gateway/src/plc_programming/opcua.rs` (EDGE-MEDIUM-003, EDGE-MEDIUM-004)
- `/var/aqua-saas/sens-api-gateway/src/resilience/circuit_breaker.rs`, `mod.rs`, `rate_limiter.rs`, `timeout.rs`
- `/var/aqua-saas/sens-api-gateway/src/lora/sx1302.rs` (unsafe block audit reference)
- `/var/aqua-saas/sens-api-gateway/src/error.rs` (thiserror precedent for EDGE-HIGH-004)
- `/var/aqua-saas/docs/reviews/edge-expert/2026-04-10-full-repo-audit.md` (prior-work check)
- `/var/aqua-saas/docs/reviews/edge-expert/2026-04-05-s2-high-findings.md` (prior-work check)
- `/var/aqua-saas/CLAUDE.md` (Architectural Approach + Review Finding Traceability sections)

## Finding index

| ID | Severity | Area | Status |
|---|---|---|---|
| EDGE-CRITICAL-001 | CRITICAL | Compile-broken failover wiring | OPEN |
| EDGE-CRITICAL-002 | CRITICAL | SCADA SQLCipher key fallback constant | OPEN |
| EDGE-HIGH-001 | HIGH (process) | Prior findings shipped without `Closes:` | OPEN |
| EDGE-HIGH-002 | HIGH | SCADA CSP still whitelists CDNs | OPEN (regression of prior HIGH-002) |
| EDGE-HIGH-003 | HIGH | mTLS optional on production MQTT | OPEN |
| EDGE-HIGH-004 | HIGH | `anyhow::Result` in public library APIs | OPEN |
| EDGE-HIGH-005 | HIGH | Zero `#[instrument]` span coverage | OPEN |
| EDGE-HIGH-006 | HIGH | Health HTTP server anonymous `/metrics` + `/diagnostics` | OPEN |
| EDGE-MEDIUM-001 | MEDIUM | MQTT `set_inflight` not explicit | OPEN |
| EDGE-MEDIUM-002 | MEDIUM | `max_blocking_threads=8` may saturate SQLCipher volume | OPEN |
| EDGE-MEDIUM-003 | MEDIUM | OPC UA counters are `Arc<Mutex<u32>>` not `AtomicU32` | OPEN |
| EDGE-MEDIUM-004 | MEDIUM | Hand-rolled OPC UA (214 KB) | OPEN (out of W1 scope) |
| EDGE-MEDIUM-005 | MEDIUM | `shutdown.rs` uses broadcast, not `CancellationToken` | OPEN |
| EDGE-MEDIUM-006 | MEDIUM | `tokio::spawn` tasks not registered with shutdown | OPEN |
| EDGE-LOW-001 | LOW | `[lints.rust]` coverage thin | OPEN |

## Systemic patterns surfaced to unified-audit

1. **Two consecutive edge-gateway audits raised failover wiring** — first a no-op stub, now a compile error. Without `Closes:` enforcement the same finding recurs in a different form. Matches the CLAUDE.md "review traceability" process finding. Feed to context-manager state machine.
2. **Defensive `unwrap_or_else` fallbacks are shipping on security-critical paths** — `scada_db.rs:71` uses a constant key fallback; `offline_queue.rs:46-50` refuses to fall back. Two modules, one architectural invariant (encryption key derivation), inconsistent enforcement. Candidate for a cross-crate lint or a dedicated `derive_db_key() -> Result<SecretKey, KeyDerivationError>` trait.
3. **Observability is uninstalled** — `tracing-opentelemetry` compiled in, zero `#[instrument]`, zero CancellationToken. These are 2024-era Rust async best practices that the brief calls for but that the codebase has not adopted. Indicates that the dependency floor was raised without the corresponding migration. Plan feed to W2.
