# Security Testing — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

Security testing has four arms: static analysis, supply-chain scanning, dynamic fuzzing, and third-party penetration testing. This chapter documents the present posture for each and the remediation plan for gaps.

## 1. Static analysis

### 1.1 Clippy wall (deny-level)

`Cargo.toml:433–442` declares a deny-wall for safety-critical clippy lints:

```
[lints.clippy]
unwrap_used = "deny"         # SECURITY: panic on malformed input crashes the agent
expect_used = "deny"         # SECURITY: same as unwrap — use map_err + ? instead
indexing_slicing = "deny"    # SECURITY: OOB panic — use .get() for bounds safety
large_stack_arrays = "deny"  # Prevent stack overflow on embedded
todo = "deny"                # No incomplete code in production
unimplemented = "deny"       # No unimplemented panics in production
dbg_macro = "deny"           # No debug macros in release
print_stdout = "deny"        # Use tracing instead
print_stderr = "deny"        # Use tracing instead
```

And `Cargo.toml:444–445`:

```
[lints.rust]
unsafe_op_in_unsafe_fn = "deny"  # SECURITY: require unsafe block inside unsafe fn
```

`.github/workflows/rust-ci.yml:57–73` runs `cargo clippy --workspace --all-targets --all-features -- -D warnings` at workspace scope. This catches the crate by transitive workspace membership even though the `paths:` filter doesn't list `sens-api-gateway/**` directly — but the trigger filter means the job does not run on PRs that touch only `sens-api-gateway/**`. Tracked as `ORPHAN-EDGE-006` (CI path-filter gap).

### 1.2 Unsafe audit

The crate has `unsafe_op_in_unsafe_fn = "deny"` at the `[lints.rust]` level. Every `unsafe fn` must wrap its operations in an explicit `unsafe { }` block, making each unsafe operation individually reviewable. No per-function `#[allow(unsafe_code)]` is permitted without a matching justification.

### 1.3 `cargo check --all-features`

Workspace job runs `cargo check` implicitly via the clippy and test jobs (both of which compile). No standalone check job; the compile error surface is identical to clippy.

## 2. Supply-chain scanning

### 2.1 `cargo audit` (RustSec advisory DB)

- `cargo audit` is the Rust-native CVE scanner.
- `.github/workflows/rust-ci.yml` runs supply-chain checks at workspace level, but the `paths:` trigger filter (`crates/**`, `apps/sensor-ingestion/**`) does **not** include `sens-api-gateway/**`. Changes to this crate's `Cargo.toml` do not retrigger the audit.
- Tracked as `ORPHAN-EDGE-006` — CI path-filter inclusion of `sens-api-gateway/**` + dedicated audit job. Planned remediation Q2 2026.

### 2.2 `cargo deny` (license + advisory + source policy)

- `deny.toml` exists at `sens-api-gateway/deny.toml`. It carries license carve-outs including the `rodbus = BSD-3-Clause` exception (`deny.toml:70–73`).
- The same path-filter gap applies: `cargo deny check` at workspace level runs but isn't retriggered by changes to `sens-api-gateway/**`.
- Tracked as `ORPHAN-EDGE-006`.

### 2.3 SBOM

- SBOM generation (`cargo cyclonedx` or similar) is documented in the security-architecture chapter (`docs/security/sbom.md`). The test-evidence role here is to confirm the SBOM is generated on every release — remediation tracked with the CI path-filter fix.

## 3. Dynamic analysis

### 3.1 Fuzz corpora

`fuzz/fuzz_targets/` carries 3 targets (see [property-fuzz.md](./property-fuzz.md)):

- `config_parse.rs` — YAML config fuzz, panic / crash oracle.
- `mqtt_payload.rs` — MQTT JSON fuzz, 256 KB cap.
- `modbus_response.rs` — Modbus response decoder fuzz; cites FrostyGoop as the threat-model anchor.

Plan Q3: add fuzz targets for S7, EtherNet/IP CIP, Atlas EZO, LoRa MAC, signed command envelope, signed updater manifest, signed authz manifest.

### 3.2 Property tests (`proptest`)

Dev-dep declared at `Cargo.toml:419`; no `proptest!` invocation in the crate today. Plan Q3 — see [property-fuzz.md](./property-fuzz.md) §1.

### 3.3 Runtime hardening

Runtime-level defensive tests that live in `src/` and contribute to dynamic security posture:

- **JTI replay protection:** `src/command_envelope/jti.rs` (11 unit tests).
- **Canonical-form serialisation:** `src/command_envelope/canonical.rs` (13 unit tests). Guards against signature-stripping / reordering attacks.
- **HMAC verification:** `src/command_envelope/envelope.rs` (28 unit tests), `src/audit/chain.rs` (14 unit tests), `src/audit/entry.rs` (25 unit tests).
- **mTLS verify:** `src/mtls/verify.rs` (19 unit tests), `src/mtls/pinning.rs` (10 unit tests), `src/mtls/mode.rs` (6 unit tests), `src/mtls/cipher.rs` (5 unit tests), `src/mtls/error.rs` (2 unit tests).
- **Authz (RBAC manifest):** `src/authz/manifest.rs` (14 unit tests), `src/authz/verify.rs` (15 unit tests), `src/authz/permission.rs` (15 unit tests), `src/authz/policy.rs` (7 unit tests), `src/authz/context.rs` (7 unit tests).
- **Signed OTA manifest:** `src/updater/manifest.rs` (20 unit tests), `src/updater/verify.rs` (14 unit tests).
- **Signed config integrity:** `src/config_integrity/manifest.rs` (9 unit tests), `src/config_integrity/verify.rs` (10 unit tests).
- **Keystore:** `src/keystore/secret.rs` (5), `src/keystore/purpose.rs` (5), `src/keystore/acceptance.rs` (12), `src/keystore/error.rs` (4), `src/keystore/mod.rs` (3).
- **Scripting sandbox limits:** `src/scripting/limits.rs` (10 unit tests), `src/scripting/conflict.rs` (7).
- **Resilience (rate limiter, circuit breaker):** `src/resilience/rate_limiter.rs` (7), `src/resilience/circuit_breaker.rs` (5).

The security-critical surface has **281 unit tests** across these files (hand-summed from [unit-tests.md](./unit-tests.md)).

## 4. Penetration testing

### 4.1 Status: NOT EXECUTED — plan Q2–Q3 2026

- **No external penetration test has been commissioned.** The IEC 62443 SL2 certification track requires an independent pentest of the end-to-end attack surface (MQTT ingress, mTLS termination, signed envelope, RBAC, actuator write path).
- **Owner:** security program lead.
- **Deadline:** Q2 scope definition and vendor selection; Q3 test execution and remediation.
- **Tracked as:** ORPHAN-EDGE-PENTEST-001 ROADMAP.

### 4.2 Scope definition (planned)

The pentest scope is derived from the STRIDE threat model in `docs/security/threat-model.md`. Minimum test matrix:

| STRIDE category | Test item |
|---|---|
| **S**poofing | MQTT TLS client-auth bypass; peer-cert pinning bypass; JWT / signed-envelope key substitution |
| **T**ampering | Command envelope canonical-form bypass; OTA manifest tampering; audit chain splicing |
| **R**epudiation | JTI replay; audit chain deletion by privileged local attacker |
| **I**nformation disclosure | SQLCipher keystore extraction; memory-dump of HMAC secret; log-line secret exfiltration |
| **D**enial of service | MQTT flood; offline-queue exhaustion; Modbus packet-storm; scripting runtime exhaustion |
| **E**levation of privilege | RBAC manifest injection; authz decision tampering; scripting sandbox escape |

Each line maps to a code path already covered by unit tests — pentest adds the adversarial-execution dimension.

### 4.3 STRIDE → test derivation

Every finding from the threat model carries a `Test:` field that names a unit test or a fuzz target. Missing tests are tracked as orphan findings. A complete matrix lives in the compliance chapter (`docs/compliance/iec62443-4-2-frN-coverage.md`), generated at release time.

## 5. Evidence links

- `Cargo.toml:433–445` — clippy + rustc deny-walls.
- `.github/workflows/rust-ci.yml:23–25, 48–74, 77–88, 91–95` — fmt / clippy / test / deny jobs.
- `.github/workflows/rust-ci.yml:5–28` — `paths:` filter showing `sens-api-gateway/**` exclusion (ORPHAN-EDGE-006).
- `deny.toml` — license + advisory configuration.
- `fuzz/fuzz_targets/*.rs` — 3 fuzz targets.
- `src/command_envelope/*.rs` — signed-envelope stack (58 unit tests across envelope, canonical, jti, mutating).
- `src/mtls/*.rs` — mTLS stack (42 unit tests).
- `src/authz/*.rs` — RBAC stack (58 unit tests).
- `src/audit/*.rs` — audit chain (39 unit tests).
- `src/updater/*.rs` — OTA signature stack (46 unit tests).
