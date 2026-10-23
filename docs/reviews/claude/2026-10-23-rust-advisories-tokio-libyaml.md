# Rust advisories of 2026-10-23: tokio and unsafe-libyaml

**Owner agent:** claude · **Cycle:** 2026-10-23-rust-advisories-tokio-libyaml · **Branch:**
`fix/rustsec-2026-0386-tokio-libyaml`

RustSec published RUSTSEC-2026-0386 against `tokio` (dated 2026-10-13). No Rust manifest or
lockfile changed. The step "Audit gateway lockfile" (`cargo audit --deny warnings` plus the
reviewed ignore list) of the `sens-api-gateway-rust` job in `ci-affected.yml` then failed.
The required `sens-enterprise-summary` check went red with it on every PR that runs the job.
The same gateway audit runs in `sens-api-gateway-ci.yml` and gates `edge-agent-release.yml`.

The report also named RUSTSEC-2024-0449 (`unsafe-libyaml` unmaintained). That advisory is
not part of this red; see the second section.

## Findings

### SUPPLY-LOW-030 — tokio 1.52.1 carries RUSTSEC-2026-0386

- **Advisory:** RUSTSEC-2026-0386, "`AsyncFd::new` and related constructors violate I/O
  safety" (informational `unsound`, category `memory-corruption`; tokio-rs/tokio#8587).
  - The safe constructors `tokio::io::unix::AsyncFd::{new, with_interest, try_new,
try_with_interest}` accept any `T: AsRawFd`, including a bare or borrowed descriptor.
  - If the registered descriptor is duplicated and closed while the `AsyncFd` lives, and the
    OS reuses the number on the same runtime, dropping the first `AsyncFd` frees the driver
    entry while the original file description stays registered in epoll. A later readiness
    event is then a use-after-free.
  - Patched `>= 1.51.6, < 1.52.0` and `>= 1.53.3`. The 1.52 line has no patched release.
    The fixed releases deprecate the safe constructors in favour of `unsafe`
    `AsyncFd::register*`.
- **Where:** `sens-api-gateway/Cargo.lock` and `sens-api-gateway/fuzz/Cargo.lock` hold
  tokio 1.52.1. The root lockfile already holds 1.54.1 (patched). Both WASM lockfiles hold
  no tokio.
- **Reach:**
  - `suderra-agent` and its vendored code (`vendor/sx1302_hal`, `crates/local-rumqttc`) never
    call `AsyncFd`.
  - A scan of the source of all 527 registry crates in the gateway lockfile finds one other
    caller: `tokio-serial` 5.4.5 (`SerialStream::open`, `pair`, `TryFrom<TTYPort>`). Its
    wrapper `mio-serial` only names the type in a doc comment.
  - `tokio-serial` is reached through Modbus RTU (`rodbus::client::spawn_rtu_client_task`,
    `src/modbus.rs:853`) and the direct dependency `tokio-serial = "5.4"`.
  - `tokio-serial` wraps a `mio_serial::SerialStream` that owns its descriptor for the whole
    life of the `AsyncFd`. The misuse the advisory needs (duplicate and close the registered
    descriptor) appears nowhere in the gateway. Its only `libc::close` calls
    (`src/process_hardening.rs`) close its own `memfd_secret` descriptors, which are never
    registered with tokio.
  - The unsound API is present but no misuse is reachable, hence LOW. The merge block is a
    process effect, not the severity.

#### Fix (SUPPLY-LOW-030)

- tokio 1.52.1 → 1.53.3 in `sens-api-gateway/Cargo.lock` and
  `sens-api-gateway/fuzz/Cargo.lock`.
  - 1.53.3 is the first patched release above the 1.52 line. Its `rust-version` is 1.71,
    within the gateway's `rust-version = "1.85"`, the fuzz workspace's 1.88 and the CI
    toolchain 1.88.0.
  - Its dependency requirements equal those of 1.52.1 (`bytes`, `libc`, `mio ^1.2`,
    `parking_lot`, `pin-project-lite`, `signal-hook-registry`, `socket2 ^0.6.3`,
    `tokio-macros ~2.7.0`, `windows-sys ^0.61`). So the lockfile diff is the tokio version and
    checksum only. No manifest changes and no other crate moves.
  - `cargo update -p tokio --precise 1.53.3` with cargo 1.88 also re-pointed the
    Windows-only `windows-sys` edges of unrelated crates (131 lines in the gateway lockfile,
    none built for the Linux targets). The committed lockfiles carry only the tokio entry
    instead. Cargo 1.88 accepts both lockfiles unchanged under `--locked` (`cargo metadata`,
    `cargo test`), and the 1.53.3 checksum was verified on download.
- 1.53.3 rather than 1.54.1, the root's version: it is the smallest move that leaves the
  advisory range. 1.54.x raises tokio's own `rust-version` to 1.85 for no benefit here.
- No audit ignore was added. No test pins Rust dependency floors, so no test changes.

#### Verification (SUPPLY-LOW-030)

- Tools: cargo-audit 0.22.2, advisory database of 2026-10-23 (1351 advisories, including
  RUSTSEC-2026-0386). cargo-deny 0.20.2. Toolchain 1.88.0.
- With the origin/main gateway lockfile, the gateway audit command of `ci-affected.yml`
  fails on exactly RUSTSEC-2026-0386 (exit 1). On the updated lockfile it passes (exit 0).
- Every `cargo audit` command of `ci-affected.yml` exits 0: root, gateway with its ignore
  list, fuzz, alarm-core-wasm and protocol-codec-wasm. So does the root command of
  `rust-ci.yml`. The fuzz lockfile also passes with `--deny warnings`.
- `cargo deny check advisories bans licenses sources` in `sens-api-gateway` passes.
- `cargo test --locked --all-targets --no-fail-fast -- --test-threads=1` in
  `sens-api-gateway`, with the CI feature set minus `tpm`, passes: 46 test binaries, 2741
  passed, 0 failed, 10 ignored. This covers the Modbus, serial and OPC UA server tests.
  `tpm` was left out only because this host has no `tss2-esys` system library. CI installs it
  and runs the full set (`cargo check --locked --release --all-targets`).
- `cargo check --locked` of the fuzz workspace passes.

## RUSTSEC-2024-0449 (unsafe-libyaml unmaintained): no change in this PR

This advisory is not new and does not fail any audit step. It is the reviewed, tracked
exception EDGE-CI-009 / **RUST-MEDIUM-005** (OPEN, deadline 2027-01-13), already in
`.cargo/audit.toml`, `deny.toml` and the three workflow mirrors. The gateway audit on
origin/main reports RUSTSEC-2026-0386 only. The fuzz audit runs without `--deny warnings`,
and the `.cargo/audit.toml` ignore covers it there too. No new finding is registered,
because RUST-MEDIUM-005 already owns this concept.

Moving `suderra-agent` off `serde_yaml` was evaluated and stopped for this PR, for these
reasons:

1. **It cannot remove the advisory.** Every `async-opcua-core` release on the crates.io index
   (0.16.0 to 0.19.0) requires `serde_yaml ^0.9` non-optionally. `async-opcua` is a gateway
   dependency (the `opc-ua-server` feature is in the CI set), so `unsafe-libyaml` stays in
   the gateway lockfile, and the ignore must stay, whatever `suderra-agent` itself uses.
   RUST-MEDIUM-005 already records that both halves are needed: `suderra-agent` migrates,
   and `async-opcua` drops `serde_yaml` upstream or through a vendored `[patch.crates-io]`
   fork.
2. **The maintained replacement does not build on the pinned toolchain.** Candidates
   (crates.io index and advisory database, 2026-10-23):

   | Crate                  | Latest                               | rust-version     | Still on unsafe-libyaml?                        | Status                                      |
   | ---------------------- | ------------------------------------ | ---------------- | ----------------------------------------------- | ------------------------------------------- |
   | `serde-saphyr`         | 2.0.0 (38 releases, last 2026-10-13) | 1.89 since 1.2.0 | no (safe Rust)                                  | maintained; named by the advisory           |
   | `noyalib`              | 0.0.58                               | 1.89             | no                                              | pre-1.0; named by the advisory              |
   | `serde_yaml_ng`        | 0.10.0                               | 1.64             | yes                                             | not a fix                                   |
   | `serde_norway`         | 0.9.42                               | 1.71.1           | fork `unsafe-libyaml-norway` (same c2rust code) | not a fix                                   |
   | `serde_yml`            | 0.0.13                               | 1.85             | no                                              | RUSTSEC-2025-0068, unsound and unmaintained |
   | `yaml-rust2`, `saphyr` | 0.13.0, 0.2.2                        | 1.85             | no                                              | parsers only, no serde                      |

   `serde-saphyr` is the right target. But its current line needs rustc 1.89, and
   `rust-toolchain.toml`, the root `rust-version` and nine workflow files pin 1.88.0.
   Adopting it now means pinning a superseded 1.1.x release, or bumping the platform
   toolchain in a dependency hotfix. Both are separate decisions.

3. **It changes the fielded config contract.** The agent config loader (`config.rs:3257`),
   the config writer (`config.rs:4251`), the I/O config writer (`commands/io_config.rs:799`),
   script storage (`scripting/storage.rs:293`) and the fuzz target all go through
   `serde_yaml`. A parser swap changes accepted syntax (enum tags, duplicate keys, YAML 1.1
   scalars) and the serializer's output on deployed devices. It needs a parity corpus over
   every committed config fixture and its own review, not a merge-unblock PR.

The path stays as RUST-MEDIUM-005 records it. One addition: move to `serde-saphyr` once the
toolchain is 1.89 or later, and fork `async-opcua-core`. Then remove the EDGE-CI-009 ignore
from every audit surface, and add `unsafe-libyaml` to `deny.toml` `[bans]`.
