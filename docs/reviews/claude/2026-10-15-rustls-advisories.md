# Rust advisories of 2026-10-15

**Owner agent:** claude · **Cycle:** 2026-10-15-rustls-advisories · **Branch:**
`fix/rustls-0-23-46-advisories`

The `sens-api-gateway-rust` job in `ci-affected.yml` turned red on main 6f205b988. Its step
"Audit root lockfile" (`cargo audit --deny warnings`) reported four advisories against
`rustls` 0.23.45, with no change to any Rust manifest or lockfile. The gateway and fuzz audit
steps never ran because the root step failed first; run here, they fail on further advisories
added to the database on 2026-10-12. This document covers every finding that keeps that job red.

## Findings

### SUPPLY-HIGH-022 — rustls 0.23.45 carries four advisories

- **Advisories:** all four are fixed in `rustls` 0.23.46.
  - RUSTSEC-2026-0346: the `Debug` impls for client session values expose TLS secrets.
  - RUSTSEC-2026-0347: buffered application data is sent to the outer server after an ECH
    rejection.
  - RUSTSEC-2026-0348: Brotli certificate decompression can allocate up to 1 GiB before
    authentication.
  - RUSTSEC-2026-0349: an unauthenticated ServerHello can downgrade later connections to
    classical key exchange.
- **Where:** three lockfiles hold `rustls` 0.23.45: the root workspace (`Cargo.lock`, reached
  by `sensor-ingestion` directly and through `tokio-rustls`, `hyper-rustls`, `async-nats` and
  `tokio-postgres-rustls`), the edge agent (`sens-api-gateway/Cargo.lock`) and its fuzz
  workspace (`sens-api-gateway/fuzz/Cargo.lock`). CI audits all three, and the gateway step's
  ignore list does not cover these IDs. The two WASM lockfiles hold no `rustls`.
- **Reach:** no lockfile enables the `rustls` `brotli` feature and no Rust code configures ECH,
  so RUSTSEC-2026-0348 and RUSTSEC-2026-0347 are not reachable as configured. RUSTSEC-2026-0346
  and RUSTSEC-2026-0349 concern `rustls` clients in general and are not ruled out for the MQTT,
  Postgres and HTTPS clients of `sensor-ingestion` and the edge agent, hence HIGH.

#### Fix (SUPPLY-HIGH-022)

- `cargo update -p rustls --precise 0.23.46` in each of the three workspaces. Every `rustls`
  requirement is `"0.23"`, so 0.23.46 is in range and no manifest changes. 0.23.46 declares
  the same dependency requirements and features as 0.23.45, so each lockfile diff is the
  `rustls` version and checksum only.
- `cargo tree -i rustls` shows a single `rustls` v0.23.46 in each graph.
- No audit ignore was added.

#### Verification (SUPPLY-HIGH-022)

- cargo-audit 0.22.2 with the advisory database of 2026-10-14 reports the four advisories on the
  origin/main root lockfile and none on the updated one (`cargo audit --deny warnings`, exit 0).
- The gateway and fuzz audit steps, run exactly as `ci-affected.yml` runs them, no longer report
  any `rustls` advisory. They still fail on advisories this change does not touch, added to the
  database on 2026-10-12: five `quinn-proto` 0.11.16 advisories (RUSTSEC-2026-0338 to
  RUSTSEC-2026-0342; `quinn` is reqwest's optional HTTP/3 dependency, locked but not compiled)
  and, in the gateway step only, `unsafe-libyaml` unmaintained (RUSTSEC-2024-0449, through
  `serde_yaml`), which `--deny warnings` makes fatal. SUPPLY-HIGH-023 below covers the first.

### SUPPLY-HIGH-023 — quinn-proto 0.11.16 carries five advisories

- **Advisories:** RUSTSEC-2026-0339, RUSTSEC-2026-0341 and RUSTSEC-2026-0342 are fixed in
  0.11.17; RUSTSEC-2026-0338 and RUSTSEC-2026-0340 in 0.11.18. RUSTSEC-2026-0343 affects 0.11.17
  only, so 0.11.18 is the smallest release that clears all of them.
- **Where:** `sens-api-gateway/Cargo.lock` and `sens-api-gateway/fuzz/Cargo.lock`, under `quinn`
  0.11.9, reqwest's optional HTTP/3 dependency. The gateway enables no `http3` feature, and
  `cargo tree -i quinn-proto --all-features --target all` prints nothing: the crate is locked,
  not compiled. cargo-audit scans the lockfile, so both audit steps fail, and an `http3` feature
  would ship the vulnerable code. The root and WASM lockfiles hold no `quinn-proto`.
- **Related:** ORPHAN-MEDIUM-142 (`docs/reviews/orphan-findings.md`) tracked RUSTSEC-2026-0185 in
  `quinn-proto`, fixed in 0.11.15. The lockfile was already at 0.11.16, so that advisory no
  longer fires, but the orphan entry still reads OPEN.

#### Fix (SUPPLY-HIGH-023)

- `cargo update -p quinn-proto --precise 0.11.18` in the gateway and fuzz workspaces. 0.11.18
  declares the same dependency requirements and features as 0.11.16, so each lockfile diff is
  the `quinn-proto` version and checksum only. No manifest changes and no audit ignore.
- After the change both audit steps report no vulnerability. The gateway step still fails on
  the `unsafe-libyaml` warning alone (RUST-MEDIUM-005 below).

### RUST-MEDIUM-005 — unmaintained unsafe-libyaml ships in the edge agent

- **Advisory:** RUSTSEC-2024-0449, informational `unmaintained`, no patched release. The
  `unsafe-libyaml` repository was archived on 2024-03-25; 0.2.11 is the last release. RustSec
  lists no open vulnerability for it (RUSTSEC-2023-0075 is fixed in 0.2.10). The gateway audit
  runs with `--deny warnings`, which makes the warning fatal.
- **Where:** `serde_yaml` 0.9.34+deprecated is its only dependent. `suderra-agent` uses
  `serde_yaml` directly (the agent config loader and seven other modules), so the crate is in
  the default binary; `async-opcua-core` requires `serde_yaml ^0.9` non-optionally in 0.17.1,
  0.18.0 and 0.19.0. No dependency update removes it, and `serde_yaml_ng` still depends on
  `unsafe-libyaml`.
- **Real fix (tracked, deadline 2027-01-13):** move `suderra-agent` to a YAML parser without
  `unsafe-libyaml` (the advisory names safe-Rust parsers such as `serde-saphyr`), with tests
  that every committed config fixture parses unchanged; get `async-opcua-core` off `serde_yaml`
  upstream or through a vendored `[patch.crates-io]` fork, as `crates/local-rumqttc` did for
  rumqttc. Then remove the ignore everywhere and ban the crate in `deny.toml`.

#### Ignore (RUST-MEDIUM-005)

- Entry EDGE-CI-009 in `sens-api-gateway/.cargo/audit.toml`, with reason, finding, owner and a
  review-by deadline equal to the finding's. `check-advisory-ignore-sync.ts` fails CI once that
  date passes. Only this unmaintained advisory is ignored; no vulnerability advisory is.
- cargo-audit reads that file from its working directory, so it alone covers every gateway and
  fuzz audit step. The sync gate also requires the same set in `sens-api-gateway/deny.toml`
  (read by `cargo deny`) and in the `--ignore` flags of `ci-affected.yml`,
  `sens-api-gateway-ci.yml` and `edge-agent-release.yml`, so the entry is mirrored there.
- Verified: every `cargo audit` command of the four Rust workflows exits 0 (cargo-audit 0.22.2,
  database of 2026-10-14); `cargo deny check advisories bans licenses sources` (0.20.2) passes in
  the gateway and at the root, and fails on RUSTSEC-2024-0449 without the `deny.toml` entry.

### RUST-LOW-006 — the gateway audit exception list has five owners

- **Problem:** `sens-api-gateway/.cargo/audit.toml` is the list cargo-audit applies. Run in
  `sens-api-gateway` with no flags, `cargo audit --deny warnings` does not report the four
  existing ignores although all four crates are locked. The three workflow steps still repeat
  the list as `--ignore` flags, and `check-advisory-ignore-sync.ts` requires those copies to
  match instead of rejecting them, so each exception is a five-place edit. `deny.toml` is a
  real second reader (cargo-deny reads only it); the workflow flags have none.
- **Fix (tracked, deadline 2027-04-13):** delete the flags, make the gate reject any `--ignore`
  in a workflow audit step, and keep `deny.toml` held equal to `audit.toml`. The workflows are
  left unchanged in this branch apart from the mirrored flag above.
