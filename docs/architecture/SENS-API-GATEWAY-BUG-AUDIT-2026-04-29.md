# sens-api-gateway Bug Audit Report

**Date**: 2026-04-29
**Auditor**: Codex
**Scope**: `sens-api-gateway` command lifecycle, MQTT envelope/legacy path, RBAC dispatch, replay protection, audit/offline reliability, OPC UA/Modbus notes.

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 2 |
| HIGH | 5 |
| MEDIUM | 16 |
| LOW | 1 |
| **Total** | **24** |

| Category | Count |
|----------|-------|
| Security | 9 |
| Bug | 5 |
| Performance | 1 |
| Reliability | 2 |
| Tooling | 7 |

---

## CRITICAL Issues

### #1 - RBAC Permission Was Computed but Not Enforced Before Dispatch (CRITICAL/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29 for the central MQTT command dispatch path.
- **Files**:
  - `sens-api-gateway/src/commands/dispatch_lifecycle.rs`
  - `sens-api-gateway/src/commands/mqtt_dispatch.rs`
  - `sens-api-gateway/src/commands/envelope_adapter.rs`
  - `sens-api-gateway/src/mqtt.rs`
- **Issue**: The command lifecycle computed `required_perm` and logged RBAC preview, but then dispatched directly to handlers. That made the permission table advisory instead of an enforcement boundary.
- **Cause**: Verified envelope actor and signed policy version were dropped when projecting `CommandEnvelope` into legacy `CommandMessage`; `execute_command` therefore had no actor evidence to pass into `PolicyEngine`.
- **Impact**: Mutating commands such as Modbus write, deploy, firmware, force, policy update, and master rotation could reach handlers without a final actor/permission decision in non-Disabled rollout modes.
- **Fix Applied**:
  - Preserved verified primary actor, claimed policy version, and co-approver evidence on `CommandMessage`.
  - Added dispatch-time `InMemoryPolicyEngine::authorize` gate before the handler table.
  - Allowed unsigned mutating legacy commands only when `signature_mode=Disabled`.

### #2 - Legacy MQTT Fallback Could Bypass Signature Enforcement for Mutating Commands (CRITICAL/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29 for mutating commands in `Permissive`/`Enforcing` modes.
- **Files**:
  - `sens-api-gateway/src/commands/mqtt_dispatch.rs`
- **Issue**: When payload was not a `CommandEnvelope`, code fell back to legacy `CommandMessage`. In signature-enforced modes, that legacy shape has no signed actor.
- **Cause**: Backward compatibility fallback was unconditional and did not distinguish read-only compatibility from mutating command risk.
- **Impact**: A non-envelope mutating payload could enter the command lifecycle without the identity material needed for RBAC authorization.
- **Fix Applied**:
  - Computed required permission immediately after parse.
  - Rejected unsigned permissioned commands before dispatch when `signature_mode != Disabled`.
  - Left anonymous legacy compatibility only for commands that require no permission.

---

## HIGH Issues

### #3 - Malformed Command Timestamp Skipped Freshness Check (HIGH/Security+Bug)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/commands/mqtt_dispatch.rs`
- **Issue**: Freshness validation ran only when RFC3339 timestamp parsing succeeded.
- **Cause**: The old code used `if let Ok(cmd_time)` and had no `else` rejection.
- **Impact**: Malformed timestamps bypassed stale/future command rejection.
- **Fix Applied**: Malformed timestamps now reject before dedup or dispatch.

### #4 - Invalid JTI Fell Back to Weak VecDeque Dedup in Signature-Enforced Modes (HIGH/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/commands/mqtt_dispatch.rs`
- **Issue**: Invalid command IDs rejected by typed JTI validation fell back to legacy VecDeque dedup.
- **Cause**: Compatibility fallback did not check signature mode.
- **Impact**: Replay-defense canonicality was weakened for signed command paths.
- **Fix Applied**: Invalid JTI now rejects in signature-enforced modes; VecDeque fallback remains only for explicit `signature_mode=Disabled`.

### #5 - Offline Queue Shutdown Flush Is a Placeholder (HIGH/Reliability)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **Files**:
  - `sens-api-gateway/src/main.rs`
  - `sens-api-gateway/src/outbound_publisher.rs`
  - `sens-api-gateway/src/offline_queue.rs`
- **Issue**: Runtime has a reconnect drain task, but shutdown flush/checkpoint code is a no-op placeholder.
- **Cause**: `OfflineQueue` is not available from the shutdown path as a first-class AppState dependency.
- **Impact**: Docs can imply WAL checkpoint + fsync durability that code does not currently guarantee.
- **Fix Applied**:
  - Stored the outbound drain task handle in `AppState`.
  - Shutdown now sends the drain stop signal and awaits the task with the configured drain budget.
  - `OfflineQueue::checkpoint_and_fsync` runs `PRAGMA wal_checkpoint(FULL)` and fsyncs DB/WAL/SHM/parent paths.

### #6 - Critical Publish Failures Are Warn-Logged and Swallowed (HIGH/Reliability)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/publish_helpers.rs`
- **Issue**: `OutboundPublisher::publish` returns structured failures, but helper functions discard them.
- **Cause**: Helper API returns `()` for all publish classes.
- **Impact**: Command responses, alarms, and other critical publishes can fail without caller-visible state.
- **Fix Applied**:
  - Added `PublishRouteError`.
  - Added checked publish variants for alarms, telemetry, status, response, io_data, task_stats, LoRa events, and raw dynamic topics.
  - Updated command response, firmware progress/failure response, alarm publish, telemetry/status publish, LoRa event/io_data publish, task stats publish, and boot Online status publish call sites to use checked variants or command-correlated checked handling.

### #7 - OPC UA Audit Append Failure Does Not Stop Mutating Write (HIGH/Security+Forensics)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/opc_ua_server.rs`
- **Issue**: OPC UA write audit append failure is logged as a forensic gap, but write still succeeds.
- **Cause**: Audit failure policy is warn-only for this path.
- **Impact**: A regulated deployment can mutate state without durable audit evidence.
- **Fix Applied**:
  - Added typed `OpcUaAuditError`, `OpcUaAuditStage`, and `RejectedAuditUnavailable`.
  - Added durable audit intent before ProcessImage mutation.
  - Outcome audit failures now return command failure instead of warn-only success.
  - Existing reject paths still emit audit outcomes; audit sink outage is caller-visible.

---

## MEDIUM Issues

### #8 - MQTT TLS Disabled in Release Is Warn-Only (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/config.rs`
- **Issue**: Release build with MQTT TLS disabled logs warning rather than failing configuration validation.
- **Cause**: Config validation supports backward-compatible plaintext deployments.
- **Impact**: Production misconfiguration can ship plaintext command/control traffic.
- **Fix Applied**: Release builds now fail config validation when `mqtt.tls.enabled=false`. Debug builds keep local-development flexibility.

### #8A - Audit Disabled Was Production-Compatible (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/config.rs`
- **Issue**: `audit.mode=Disabled` could be used by a release build.
- **Cause**: Audit Disabled existed for rollout compatibility and was not gated by build profile.
- **Impact**: Mutating commands could execute without an HMAC-chained audit sink.
- **Fix Applied**: Release builds now fail config validation when `audit.mode=disabled`.

### #9 - Config Integrity Permissive/Disabled Modes Can Remain in Production (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **Files**:
  - `sens-api-gateway/src/main.rs`
  - `sens-api-gateway/src/config_integrity/verify_runtime.rs`
  - `sens-api-gateway/src/config.rs`
- **Issue**: Permissive integrity failure continues boot; Disabled skips verification.
- **Cause**: Rollout modes are not tied to production profile.
- **Impact**: Config tamper/rollback can become log-only in production.
- **Fix Applied**: Release builds now fail config validation unless `config_integrity.mode=enforcing`.

### #9A - RBAC Manifest Disabled/Permissive Could Remain in Production (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/config.rs`
- **Issue**: The command dispatch RBAC gate depends on a verified manifest, but release config allowed disabled/permissive RBAC manifest modes.
- **Cause**: Rollout modes were not production-gated.
- **Impact**: Production command authorization could degrade to compatibility behavior.
- **Fix Applied**: Release builds now fail config validation unless `rbac_manifest.mode=enforcing`.

### #10 - Keystore Auto Falls Back to FileBacked Until TPM/systemd-creds Land (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-29 for release production hardening.
- **Files**:
  - `sens-api-gateway/src/main.rs`
  - `sens-api-gateway/src/config.rs`
  - `docs/runbooks/edge-keystore-operations.md`
- **Issue**: `keystore.mode=Auto` currently falls through to FileBacked.
- **Cause**: TPM and systemd-creds runtime probes are documented pending work.
- **Impact**: Operator may assume hardware-backed keys while running software-backed keys.
- **Fix Applied**: Release builds now reject `keystore.mode=Auto`; production must explicitly choose FileBacked with its acceptance-token discipline until TPM/systemd-creds become first-class production modes.

### #11 - OPC UA X.509 Authentication Is Still Rejected (MEDIUM/Security)
- **Status**: OPEN.
- **File**: `sens-api-gateway/src/opc_ua_sens_auth_manager.rs`
- **Issue**: X.509 auth path returns `BadIdentityTokenRejected`.
- **Cause**: Username/password path landed first; cert validation is still pending.
- **Impact**: Operator certificate model is not available for OPC UA sessions.
- **Required Fix**: Wire certificate validation, issuer policy, subject mapping, and revocation/rotation behavior.

### #12 - I/O Poll Holds AppState Read Lock Across Fieldbus Awaits (MEDIUM/Performance)
- **Status**: FIXED-IN-CODE on 2026-04-29.
- **File**: `sens-api-gateway/src/io_poll.rs`
- **Issue**: Poll cycle holds `state.read().await` while awaiting Modbus/I2C operations.
- **Cause**: Handles/config are borrowed directly from AppState instead of snapshotted.
- **Impact**: Slow fieldbus calls can block config reload, shutdown, or state writers.
- **Fix Applied**: Poll cycle snapshots process image, force registry, bus handles, alarm manager and health state under the lock, then drops the guard before GPIO/Modbus/I2C awaits.

### #13 - Documentation References Stale or Missing Gap Ledger Paths (MEDIUM/Architecture)
- **Status**: FIXED-IN-DOCS on 2026-04-29.
- **Files**:
  - `sens-api-gateway/docs/product/feature-matrix.md`
  - `sens-api-gateway/docs/architecture/data-flow.md`
- **Issue**: Some docs point to `docs/reviews/orphan-findings.md` while the local path is missing, and some feature matrix rows describe old Modbus behavior.
- **Cause**: Implementation moved faster than documentation ledger updates.
- **Impact**: Reviewers can prioritize already-fixed bugs or miss still-open reliability issues.
- **Fix Applied**: Added `sens-api-gateway/docs/reviews/orphan-findings.md` as the current dated ledger and updated Modbus/OPC UA rows to distinguish fixed runtime behavior from still-open follow-up work.

### #13A - sensor-service OPC UA Hardware Mutation Audit Is Best-Effort (MEDIUM/Security+Forensics)
- **Status**: OPEN / SEPARATE-SERVICE-FINDING.
- **Files**:
  - `apps/sensor-service/src/protocol/adapters/industrial/opcua.adapter.ts`
  - `apps/sensor-service/src/plc-control/services/plc-connection.service.ts`
  - `apps/sensor-service/src/plc-control/services/feeding-parameter.service.ts`
  - `apps/sensor-service/src/infrastructure/audit/audit.subscriber.ts`
- **Issue**: A separate NestJS service has direct OPC UA hardware mutation paths whose current audit subscriber catches and swallows audit write failures.
- **Cause**: Entity-change audit and PLC hardware mutation audit are coupled through a best-effort subscriber instead of a fail-closed mutation audit boundary.
- **Impact**: A PLC write in `sensor-service` can be physically applied without durable mutation intent/outcome audit evidence.
- **Required Fix**: Implement a dedicated PLC mutation audit table/service with durable intent before hardware mutation and outcome after mutation. Do not rely on the best-effort entity subscriber for hardware writes.

### #13B - Gateway Warning Debt Blocks Full Warnings-as-Errors Gate (MEDIUM/Tooling)
- **Status**: OPEN.
- **Files**:
  - `sens-api-gateway/src/commands/program/*`
  - `sens-api-gateway/src/plc_programming/*`
  - `sens-api-gateway/src/process_hardening.rs`
  - `.github/workflows/sens-api-gateway-ci.yml`
- **Issue**: `cargo check --locked` succeeds, but emits historical unused/dead-code warnings. Enabling full `RUSTFLAGS=-D warnings` or `cargo clippy -- -D warnings` now would knowingly create a red CI gate unrelated to the current remediation.
- **Cause**: Feature-gated protocol/security modules accumulated code paths that are compiled but not always exercised by the default binary or tests.
- **Impact**: New warning debt can be hidden among old warning debt until a cleanup pass removes the baseline.
- **Fix Applied**:
  - Added a dedicated `sens-api-gateway` GitHub Actions workflow with format, default check, release all-feature check, all-target tests, all-feature tests, cargo-deny, cargo-audit, and rustdoc warnings-as-errors.
  - Clippy currently denies high-signal correctness/suspicious/perf groups instead of pretending the crate is ready for full `-D warnings`.
- **Required Fix**: Run a dedicated warning-cleanup pass that classifies each warning as dead code, public feature-gated API, or missing test usage; then raise gateway CI to full rustc/clippy `-D warnings`.

### #13C - LoRaWAN Protocol Feature Was Coupled to SX1302 Vendor HAL Sources (MEDIUM/Tooling+Architecture)
- **Status**: FIXED-IN-CODE on 2026-04-30.
- **Files**:
  - `sens-api-gateway/Cargo.toml`
  - `sens-api-gateway/build.rs`
  - `sens-api-gateway/src/lora/sx1302.rs`
  - `.github/workflows/sens-api-gateway-ci.yml`
- **Issue**: `--all-features` enabled `lorawan`, and `lorawan` also enabled the Semtech SX1302 C HAL build. CI had protocol source code and headers but not `vendor/sx1302_hal/libloragw/src/*.c`, so `build.rs` returned without generating `sx1302_bindings.rs` and the Rust module failed on `include!(OUT_DIR/sx1302_bindings.rs)`.
- **Cause**: One feature flag represented two different architectural concerns: LoRaWAN protocol/crypto support and physical SX1302 concentrator HAL integration.
- **Impact**: Gateway PR CI could not validate optional software modules because a hardware-vendor source tree was missing. A stub would have hidden release/HIL risk; a broad skip would have left the feature untested.
- **Fix Applied**:
  - Split `sx1302-vendor-hal` from `lorawan`.
  - Kept `lorawan` as a protocol/software feature.
  - Made `sx1302-vendor-hal` fail closed when Semtech C sources are absent.
  - Updated CI to compile the full software feature set while excluding the hardware HAL from PR checks.

### #13D - Supply-Chain Policy Drift Between RustSec and SQLCipher Reality (MEDIUM/Tooling+Security)
- **Status**: FIXED-IN-POLICY on 2026-04-30.
- **Files**:
  - `sens-api-gateway/.cargo/audit.toml`
  - `sens-api-gateway/deny.toml`
  - `.github/workflows/sens-api-gateway-ci.yml`
- **Issue**: New `RUSTSEC-2026-0104` failed `cargo audit` and `cargo deny`, while `deny.toml` globally banned `openssl-sys` even though `rusqlite` intentionally uses `bundled-sqlcipher-vendored-openssl` for encrypted offline storage.
- **Cause**: The policy files lagged behind both a new RustSec advisory and the explicit SQLCipher at-rest encryption dependency shape.
- **Impact**: CI failed with a mix of real advisory risk and policy/architecture mismatch, making it unclear which failures require dependency replacement versus accepted, documented operational risk.
- **Fix Applied**:
  - Verified on 2026-04-30 that crates.io still reports `rumqttc 0.25.1` as the latest upstream release, so the `rustls-webpki` fix is upstream-blocked.
  - Added `RUSTSEC-2026-0104` with owner, deadline, mitigation, and fork/replace path.
  - Kept the high-level `openssl` TLS crate banned while removing the invalid `openssl-sys` ban; the FFI crate is required by SQLCipher at-rest encryption and cannot be safely skipped via cargo-deny duplicate traversal policy.

### #13E - Performance Benchmark Workflow Mixed Frontend Lighthouse With Unbacked API Benchmark (MEDIUM/Tooling+Performance)
- **Status**: FIXED-IN-CI on 2026-04-30.
- **Files**:
  - `.github/workflows/performance-benchmark.yml`
  - `tests/performance/api-smoke.js`
- **Issue**: The benchmark workflow could hang on broad frontend/app triggers and did not have a real backend API target/script contract for k6.
- **Cause**: Lighthouse and backend API performance were modeled as one PR workflow even though only Lighthouse has a self-contained local target. Backend performance requires a live API base URL.
- **Impact**: CI slot contention and false performance evidence: a backend benchmark could appear operational without exercising a real backend endpoint.
- **Fix Applied**:
  - Scoped PR benchmark triggers to `web/**`.
  - Added a real k6 smoke script that requires `API_BASE_URL`.
  - Moved API benchmark execution to `workflow_dispatch` with explicit `api_base_url`.
  - Kept the benchmark fail-closed when no live API target is supplied.

### #13F - Curated Optional Feature Gate Exposed Stale Compile Contracts (MEDIUM/Bug+Tooling)
- **Status**: FIXED-IN-CODE on 2026-04-30.
- **Files**:
  - `sens-api-gateway/src/main.rs`
  - `sens-api-gateway/src/opc_ua_sens_node_manager.rs`
  - `sens-api-gateway/src/lora/crypto.rs`
  - `sens-api-gateway/src/lora/mac.rs`
  - `sens-api-gateway/src/lora/mod.rs`
- **Issue**: The enterprise software feature set compiled by CI exposed stale optional-feature contracts: the OpenTelemetry exporter used a removed API, LoRa init tried to use `?` inside a unit-returning async function, LoRa MAC event handling held overlapping mutable borrows, optional telemetry data missed the `simulated` field, and OPC UA write outcome handling was non-exhaustive after audit-fail-closed was added.
- **Cause**: Optional modules were previously validated indirectly or behind an `--all-features` gate that was already blocked by the SX1302 vendor HAL source issue. That allowed API drift and enum-contract drift to accumulate outside the default build.
- **Impact**: Release builds enabling telemetry, LoRaWAN, TPM, ST bytecode, scheduler, OPC UA server, and license enforcement could fail to compile even though default `cargo check` passed.
- **Fix Applied**:
  - Updated OpenTelemetry initialization to the current `SpanExporter::builder().with_tonic()` pipeline.
  - Reworked LoRa config validation to fail explicitly and return from the hardware init path instead of using `?` in a unit-returning function.
  - Preserved MAC actor ownership boundaries so event handling no longer overlaps mutable borrows.
  - Propagated the `simulated` data-quality field through LoRa I/O emission.
  - Added exhaustive fail-closed handling for `RejectedAuditUnavailable` in OPC UA write mapping.

### #13G - Rustdoc Warnings Were Not Clean Under Documentation CI (MEDIUM/Tooling+Docs)
- **Status**: FIXED-IN-DOCS on 2026-04-30.
- **Files**:
  - `sens-api-gateway/src/atlas_ezo.rs`
  - `sens-api-gateway/src/authz/verify.rs`
  - `sens-api-gateway/src/authz/manifest_common.rs`
  - `sens-api-gateway/src/plc_programming/codesys.rs`
  - `sens-api-gateway/src/scripting/task_stats_publisher.rs`
  - `sens-api-gateway/src/safe_state_v2.rs`
  - `sens-api-gateway/src/keystore/purpose.rs`
  - `sens-api-gateway/src/keystore/tpm_backed.rs`
  - `sens-api-gateway/src/command_envelope/dispatcher.rs`
  - `sens-api-gateway/src/command_envelope/handler.rs`
  - `sens-api-gateway/src/updater/tryboot.rs`
  - `sens-api-gateway/src/opc_ua_server_user_token_validator.rs`
  - `sens-api-gateway/src/config.rs`
- **Issue**: `RUSTDOCFLAGS='-D warnings' cargo doc --locked --no-deps --document-private-items` failed on unresolved intra-doc links and HTML parsing warnings in comments.
- **Cause**: Documentation used bracketed protocol notation such as `byte[0]`, `PCR[7]`, `[all]`, and links to non-imported or non-associated symbols. Rustdoc interprets those as links under intra-doc link checking.
- **Impact**: Documentation CI could fail independently of runtime correctness, and real API documentation regressions could be mixed with notation-only warnings.
- **Fix Applied**:
  - Converted protocol indices, config block names, and non-link symbol references to code spans.
  - Kept real intra-doc links where the referenced item is resolvable and useful.
  - Verified the full private-item documentation build with warnings denied.

### #13H - OPC UA Typed Authz Could Not Carry Two-Person Evidence (MEDIUM/Security)
- **Status**: FIXED-IN-CODE on 2026-04-30.
- **Files**:
  - `sens-api-gateway/src/opc_ua_server_typed_authz.rs`
  - `sens-api-gateway/src/opc_ua_sens_node_manager.rs`
  - `sens-api-gateway/src/opc_ua_server_runtime.rs`
- **Issue**: `Permission::OpcUaWrite` requires two-person integrity, but `TypedAuthzPort::authorize_write` had no parameter for `CoApproverEvidence`. Tests expected an allow path that the policy engine correctly rejected with `TwoPersonIntegrityMissing`.
- **Cause**: The typed OPC UA authz adapter was designed before the enterprise two-person gate became mandatory for high-risk write permissions, so its method contract lagged behind the policy engine contract.
- **Impact**: OPC UA writes were fail-closed, but the interface had no architectural way to represent a future valid co-approved write. That would force downstream code either to remain permanently denied or to bypass the policy engine.
- **Fix Applied**:
  - Extended `TypedAuthzPort::authorize_write` with optional `CoApproverEvidence`.
  - Updated `ManifestBackedTypedAuthz` to attach co-approver evidence to `AuthorizationRequest`.
  - Left current `SensNodeManager` write calls passing `None` with a dated fail-closed comment until a signed OPC UA co-approval channel is wired.
  - Updated tests to prove the allow path with a distinct enrolled co-approver and to keep missing/effective permission denies explicit.

### #13I - Migration Registration Invariant Treated Destructive Manual Migrations as Normal Auto-Run Migrations (MEDIUM/Tooling)
- **Status**: FIXED-IN-INVARIANT on 2026-04-30.
- **Files**:
  - `tests/invariants/migration-registration-completeness.spec.ts`
  - `apps/messaging-service/src/migrations/1782500000000-ConsolidateTenantSchemaData.ts`
  - `apps/messaging-service/src/app.module.ts`
- **Issue**: `migration-registration-completeness.spec.ts` required every migration class to appear in `AppModule` even when a migration explicitly declares itself destructive, production-irreversible, and manual-gated.
- **Cause**: The invariant modeled only two valid migration-loading modes: glob-loaded and explicit auto-registration. It had no contract for code-shipped manual migrations that must not execute automatically before a backup and maintenance window.
- **Impact**: The green-test path would have been to auto-register `ConsolidateTenantSchemaData1782500000000`, which could consolidate tenant schemas without the required operator ceremony.
- **Fix Applied**:
  - Kept the destructive migration out of `messaging-service` auto-registration.
  - Added a strict gated-manual migration contract to the invariant: `GATED - NOT auto-registered`, destructive warning, production-irreversible warning, `pg_dump snapshot`, and explicit register-before-rollout operator step.
  - The invariant still fails every unregistered normal migration.

### #13J - Banned-Phrase Gate Flagged Removed-Code Quotes in Historical PR Commit Bodies (MEDIUM/Tooling)
- **Status**: FIXED-IN-GATE on 2026-04-30.
- **File**: `tools/gates/banned-phrase.ts`
- **Issue**: CI range mode scanned every commit body in the PR and flagged an older commit message that quoted a removed legacy comment inside a Markdown code span.
- **Cause**: The gate recognized double-quoted meta discussion but not Markdown inline-code spans. A commit that documented removal of a banned phrase could therefore be treated as introducing that phrase.
- **Impact**: Long-lived PRs could be blocked by historical cure documentation even when file scans and new commit messages were clean.
- **Fix Applied**:
  - Generalized quoted-region detection to literal-region detection.
  - Markdown backtick spans now receive the same meta-discussion treatment as double quotes.
  - The gate still scans non-literal commit prose and added file lines for banned architectural hedge language.

---

## LOW Issues

### #14 - Rust Toolchain Is Not on Default PATH in Some Agent Shells (LOW/Tooling)
- **Status**: ENVIRONMENT-NOTE on 2026-04-29.
- **Command**: `/root/.cargo/bin/cargo fmt -- --check`
- **Issue**: Plain `cargo` may be unavailable in the workspace shell even though `/root/.cargo/bin/cargo` exists.
- **Cause**: Agent runtime PATH does not consistently include the Rust toolchain directory.
- **Impact**: Local verification can falsely look blocked unless the absolute cargo path is used.
- **Fix Applied**: This remediation used `/root/.cargo/bin/cargo` for local verification and added GitHub Actions as the authoritative gateway CI path.
