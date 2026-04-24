# Open-Source Attribution — Suderra Edge Agent

> **(LEGAL REVIEW REQUIRED)** — This document records the attribution posture of every open-source component incorporated in the Edge Agent binary. The per-binary NOTICES distribution file is generated mechanically (see `third-party-notices.md`). All classifications below are template-level and must be re-verified against the release `Cargo.lock` on each tag.

**Source-of-truth inputs:**

- `sens-api-gateway/Cargo.toml` (direct dependencies, feature gates)
- `sens-api-gateway/Cargo.lock` (resolved transitive tree)
- `sens-api-gateway/deny.toml` (licence allowlist, clarifications)
- `sens-api-gateway/vendor/**` (vendored C code)

Regeneration command (CI):

```
cargo install cargo-bundle-licenses --locked
cargo bundle-licenses --format yaml --output docs/commercial/third-party-notices.generated.yaml
```

Document date: 2026-04-24

---

## 1. Licence-family summary (direct dependencies)

The table below is derived from `Cargo.toml` and reflects the release-profile dependency set (all features enabled). Counts are direct dependencies only; transitive closure is captured in the CI-generated notices file.

| Crate | Version | SPDX licence | Role |
|-------|---------|--------------|------|
| `tokio` | 1.43 | MIT | Async runtime |
| `futures` | 0.3 | MIT OR Apache-2.0 | Async combinators |
| `serde` | 1.0 | MIT OR Apache-2.0 | Serialisation framework |
| `serde_json` | 1.0 | MIT OR Apache-2.0 | JSON codec |
| `serde_yaml` | 0.9 | MIT OR Apache-2.0 | YAML codec |
| `reqwest` | 0.12 | MIT OR Apache-2.0 | HTTPS client (rustls backend) |
| `rumqttc` | 0.25 | Apache-2.0 OR MIT | MQTT client |
| `rustls-native-certs` | 0.8 | MIT OR Apache-2.0 OR ISC | System CA bridge |
| `tracing` | 0.1 | MIT | Structured logging |
| `tracing-subscriber` | 0.3 | MIT | Logger layer |
| `tracing-journald` | 0.3 | MIT OR Apache-2.0 | journald sink |
| `anyhow` | 1.0 | MIT OR Apache-2.0 | Error handling |
| `thiserror` | 2.0 | MIT OR Apache-2.0 | Derive-macro errors |
| `secrecy` | 0.8 | MIT OR Apache-2.0 | Zeroising wrappers |
| `sysinfo` | 0.33 | MIT | System telemetry |
| `chrono` | 0.4 | MIT OR Apache-2.0 | Date / time |
| `async-trait` | 0.1 | MIT OR Apache-2.0 | Async trait sugar |
| `regex` | 1.10 | MIT OR Apache-2.0 | Regex engine |
| `rodbus` | =1.4.0 | BSD-3-Clause (clarified in `deny.toml:72-78`) | Modbus-TCP / RTU |
| `tokio-serial` | 5.4 | MIT | Serial transport |
| `ctrlc` | 3.4 | MIT OR Apache-2.0 | Signal handling |
| `machine-uid` | 0.5 | MIT | Machine fingerprint |
| `mac_address` | 1.1 | MIT OR Apache-2.0 | MAC enumeration |
| `hostname` | 0.3 | MIT OR Apache-2.0 | Hostname lookup |
| `rusqlite` | 0.34 | MIT | SQLite bindings (bundled SQLCipher) |
| `moka` | 0.12 | MIT OR Apache-2.0 | Bounded cache |
| `sd-notify` | 0.4 | Apache-2.0 OR MIT | systemd integration |
| `lasso` | 0.7 | MIT OR Apache-2.0 | String interner |
| `heapless` | 0.8 | MIT OR Apache-2.0 | Stack-allocated collections |
| `flate2` | 1.0 | MIT OR Apache-2.0 | Gzip compression |
| `getrandom` | 0.2 | MIT OR Apache-2.0 | CSPRNG |
| `hmac` | 0.12 | MIT OR Apache-2.0 | HMAC primitive |
| `rand` | 0.9 | MIT OR Apache-2.0 | RNG façade |
| `uuid` | 1.0 | MIT OR Apache-2.0 | UUID v4 |
| `base64` | 0.22 | MIT OR Apache-2.0 | Base64 codec |
| `x509-parser` | 0.16 | MIT OR Apache-2.0 | X.509 parsing |
| `pem` | 3.0 | MIT OR Apache-2.0 | PEM codec |
| `sha2` | 0.10 | MIT OR Apache-2.0 | SHA-2 primitive |
| `ed25519-dalek` | 2.1 | BSD-3-Clause | Ed25519 signing / verification |
| `hkdf` | 0.12 | MIT OR Apache-2.0 | HKDF |
| `argon2` | 0.5 | MIT OR Apache-2.0 | Password KDF |
| `bincode` | =1.3.3 | MIT | Binary codec |
| `libc` | 0.2 | MIT OR Apache-2.0 | libc FFI |
| `nix` | 0.29 | MIT | POSIX syscalls |
| `jsonwebtoken` | 9 | MIT | JWT verification (feature `license-enforce`) |
| `opcua` | 0.12 | MPL-2.0 | OPC UA server (feature `opc-ua-server`) |
| `tss-esapi` | 8 | Apache-2.0 | TPM 2.0 bindings (feature `tpm`) |
| `aes` | 0.8 | MIT OR Apache-2.0 | AES block cipher (feature `lorawan`) |
| `cmac` | 0.7 | MIT OR Apache-2.0 | CMAC (feature `lorawan`) |
| `lorawan` | 0.9 | MIT | LoRaWAN codec (feature `lorawan`) |
| `subtle` | 2 | BSD-3-Clause | Constant-time comparison |
| `zeroize` | 1 | MIT OR Apache-2.0 | Zero-on-drop |
| `axum` | 0.8 | MIT | HTTP server (feature `health`, `scada-display`) |
| `tower-http` | 0.6 | MIT | HTTP middleware (feature `scada-display`) |
| `opentelemetry` | 0.27 | Apache-2.0 | OTEL core (feature `telemetry`) |
| `opentelemetry-otlp` | 0.27 | Apache-2.0 | OTLP exporter (feature `telemetry`) |
| `opentelemetry_sdk` | 0.27 | Apache-2.0 | OTEL SDK (feature `telemetry`) |
| `tracing-opentelemetry` | 0.28 | MIT | OTEL bridge (feature `telemetry`) |
| `metrics` | 0.24 | MIT | Metrics façade (feature `metrics`) |
| `metrics-exporter-prometheus` | 0.16 | MIT OR Apache-2.0 | Prometheus exporter (feature `metrics`) |
| `rppal` | 0.17 | MIT OR Apache-2.0 | Raspberry Pi GPIO (feature `gpio`) |

**Total direct dependencies inventoried:** 58 (across all feature gates).

Build-only: `cc` 1.0 (MIT OR Apache-2.0), `bindgen` 0.70 (BSD-3-Clause), `glob` 0.3 (MIT OR Apache-2.0).
Dev-only (never shipped): `tempfile` 3.10, `criterion` 0.5, `proptest` 1.5 — excluded from redistributable notices.

---

## 2. Licence-family obligations

### 2.1 MIT / BSD-2 / BSD-3 / ISC / Zlib / Unlicense / CC0-1.0 / BSL-1.0 (permissive)

**Obligation:** Preserve copyright notice and licence text in redistributed binaries.
**Compliance:** Satisfied by the mechanically generated `third-party-notices.md` file shipped alongside the binary and referenced by `/opt/suderra/NOTICES` on target devices.
**Scope:** Vast majority of the dependency tree.

### 2.2 Apache-2.0 / Apache-2.0 WITH LLVM-exception

**Obligation:** Preserve copyright notice, licence text, NOTICE file (if supplied by upstream), and a statement of any modifications.
**Compliance:** Same mechanism as §2.1; upstream NOTICE files are aggregated by `cargo bundle-licenses`. Suderra does not modify upstream source trees; modifications (if any) are carried as crate-local patches and called out in `CHANGELOG.md` for the affected release.

### 2.3 MPL-2.0 (weak copyleft — file-level)

**Obligation:** If a file covered by MPL-2.0 is modified, the modified file must be redistributed under MPL-2.0 with source available.
**Applicable crate:** `opcua` 0.12 (feature `opc-ua-server`).
**Compliance posture:** Suderra uses the upstream crate **unmodified**. No MPL-2.0-covered file is patched, forked, or vendored in-tree. Redistribution is binary-only under the aggregate work exception; source of the unmodified crate remains available from crates.io. If the crate is ever forked, the forked files must be published under MPL-2.0 and linked from this document.

**(LEGAL REVIEW REQUIRED)** — confirm the "aggregate work" characterisation under MPL-2.0 §1.10 for the linked-binary case.

### 2.4 BSD-3-Clause (attribution + no-endorsement)

**Applicable crates:** `rodbus` (clarified in `deny.toml:72-78`), `ed25519-dalek`, `subtle`, `bindgen` (build-only).
**Obligation:** Preserve copyright notice, list of conditions, and the "neither the name … nor the names of its contributors may be used to endorse or promote" clause.
**Compliance:** Satisfied by the generated NOTICES file.

### 2.5 OpenSSL licence (permissive, grandfathered)

**Applicable crate:** transitively via `ring` (see `deny.toml:56-59` exception clause) and via the `bundled-sqlcipher-vendored-openssl` feature of `rusqlite` 0.34 (`Cargo.toml:94`).
**Compliance:** OpenSSL attribution text is included in the generated NOTICES file. The `cargo-deny` configuration explicitly allows the `OpenSSL` SPDX expression (`deny.toml:45`).

### 2.6 Unicode-3.0 / CDLA-Permissive-2.0

Transitively pulled by Unicode-related crates (ICU / idna) and by `webpki-roots`; both are permissive.

---

## 3. Vendored C code

### 3.1 Semtech SX1302 HAL — licence status: **FILE NOT PRESENT IN TREE**

Path: `sens-api-gateway/vendor/sx1302_hal/`
Present artefacts: `README.md`, `libloragw/` (header stubs for bindgen).
Missing artefacts: `LICENSE`, `COPYING`, `NOTICE`.

The vendored directory contains only a Turkish-language `README.md` that instructs the operator to clone the Semtech upstream repository (`https://github.com/Lora-net/sx1302_hal`) into the directory at build time. The upstream repository is published by Semtech Corporation; its licence terms must be read directly from the upstream `LICENSE.TXT` and applied to any binary that links the compiled HAL (enabled by the `lorawan` feature, `Cargo.toml:341`).

**(LEGAL REVIEW URGENT)** — before any commercial redistribution of a binary built with `--features lorawan`:

1. Pin the Semtech HAL commit / tag used for the release build and mirror the upstream `LICENSE.TXT` into `vendor/sx1302_hal/LICENSE`.
2. Verify that the upstream terms permit redistribution in compiled form as part of a proprietary product. The upstream licence has historically been a variant of BSD-3-Clause-Clear with a Semtech-specific clause; the precise text varies by commit and must be read at the pinned commit.
3. If redistribution in the bundled form is not permitted, adopt one of: (a) dynamic loading of the HAL at runtime on the target device with the operator supplying the library; (b) a separately negotiated Semtech redistribution agreement; (c) exclusion of the `lorawan` feature from commercial binaries.
4. Record the outcome in this file and in `third-party-notices.md` §4.

This gap blocks commercial distribution of the `lorawan`-enabled build. Redistribution of the binary without resolving the gap is not permitted.

Scope clarification: the Semtech redistribution question is handled separately under a dedicated licensing work item (LEGAL REVIEW URGENT tracked as a blocking finding); the present document catalogues the dependency and its status without purporting to resolve the upstream-licence question. It is referenced here for completeness.

### 3.2 Bundled OpenSSL (inside `rusqlite` / SQLCipher)

Path: vendored by the Cargo feature `bundled-sqlcipher-vendored-openssl`; not present as source in the Suderra tree.
**Licence:** OpenSSL (historic) / Apache-2.0 (newer series). Exact version determined by the locked SQLCipher build pinned in `Cargo.lock`.
**Compliance:** Obligation discharged via the generated NOTICES file and the `deny.toml:45` allow-entry for the OpenSSL SPDX.

---

## 4. `cargo-deny` allowlist cross-check

The permitted SPDX expressions are enumerated in `deny.toml:37-53`. Any new crate whose licence is not in the allowlist fails the CI `cargo deny check licenses` gate. The gate is the primary mechanism by which a non-compliant dependency is prevented from landing; the present document is the secondary human-readable record.

Banned upstream toolchains:

- `openssl` and `openssl-sys` (see `deny.toml:87-90`) — denied for cross-platform reasons; not a licence issue.

---

## 5. Regeneration procedure (CI)

1. On every release tag, the CI pipeline runs `cargo bundle-licenses --format yaml --output docs/commercial/third-party-notices.generated.yaml`.
2. A second step renders `third-party-notices.md` from the YAML using a template (stored alongside the CI scripts).
3. A third step diffs the new notices file against the committed version and fails the build if the diff is non-empty and the commit did not include the update.
4. The present human-authored `oss-attribution.md` is reviewed manually on every minor release for licence-family changes (e.g. a crate switching from MIT to AGPL); automation flags but does not silently accept.

---

## 6. Dual-licensed crates

Many Rust crates declare dual licences (`MIT OR Apache-2.0` or similar). Suderra elects Apache-2.0 for dual-licensed crates where available (consistent patent-grant posture); the NOTICES file carries the Apache-2.0 licence text. Where only MIT is offered, MIT applies.

**(LEGAL REVIEW REQUIRED)** — the election of Apache-2.0 over MIT for dual-licensed crates is a policy choice with downstream patent-defence implications; counsel to confirm.

---

## 7. Changes since previous release

Tracked as a CI-generated diff in `docs/commercial/oss-attribution.changelog.md` (created by the regeneration pipeline). Material changes (new copyleft family, new vendored binary, a crate moving to AGPL, etc.) escalate to legal review.

---

Export-control reference date: 2026-04-24
