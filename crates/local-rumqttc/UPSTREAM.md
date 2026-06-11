# local-rumqttc — vendored fork of rumqttc 0.25.1 (RUST-CVE-001)

## Provenance

| Field | Value |
|---|---|
| Upstream crate | `rumqttc` 0.25.1 (crates.io) |
| Upstream repo | <https://github.com/bytebeamio/rumqtt> |
| License | Apache-2.0 (unchanged; `license` field retained in Cargo.toml) |
| `.crate` archive sha256 | `0feff8d882bff0b2fddaf99355a10336d43dd3ed44204f85ece28cf9626ab519` (matches the `checksum` recorded for rumqttc 0.25.1 in both workspace lockfiles before the fork) |
| Vendored from | local cargo registry cache (`index.crates.io` source of the same checksum) |
| Per-file upstream hashes | `UPSTREAM-MANIFEST.sha256` (sha256 of every vendored file **before** fork edits) |

## Why this fork exists

Tracked finding: **RUST-CVE-001** (`docs/reviews/_registry/findings.jsonl`).

Upstream rumqttc 0.25.1 pins two problem dependencies that cannot be fixed
from the consumer side because the version requirements exclude the fixed
lines:

1. `rustls-webpki = "0.102.8"` → RUSTSEC-2026-0098, RUSTSEC-2026-0099,
   RUSTSEC-2026-0049, RUSTSEC-2026-0104. The fixes live in the 0.103 line;
   `^0.102.8` can never resolve to it. rumqttc's only use of the crate is
   the `WebPki(#[from] webpki::Error)` error variant in `src/tls.rs`, and
   `webpki::Error` is source-compatible across the bump.
2. `rustls-pemfile = "2.2.0"` → RUSTSEC-2025-0134 (unmaintained notice).
   Replaced with `rustls-pki-types`' first-party PEM decoding, which both
   workspaces already resolve (1.14.x) via rustls 0.23.

Upstream master (commit `2167da05a66` at the time of forking) still pinned
`rustls-webpki = "0.102.8"` — there was no merged fix to wait for before the
finding's 2026-06-30 deadline.

## Diff policy (enforced by the fork-hygiene gate)

Only these files may differ from `UPSTREAM-MANIFEST.sha256`:

| File | Change |
|---|---|
| `Cargo.toml` | `publish = false`; `rustls-webpki` `0.102.8` → `0.103`; `rustls-pemfile` dependency replaced by `rustls-pki-types = { version = "1.7", features = ["std"] }`; `use-rustls-no-provider` feature list updated accordingly. |
| `src/tls.rs` | PEM decoding migrated from `rustls_pemfile` to `rustls_pki_types::pem::PemObject` (`CertificateDer::pem_reader_iter`, `PrivateKeyDer::from_pem_reader`); new `Error::Pem` variant; `NoItemsFound` mapped to the pre-existing `NoValidKeyInChain` so error semantics are preserved. |

**Behavioural delta on the CERT path (EDGE-MEDIUM-004, deliberate):**
upstream's `rustls_pemfile::certs` silently skipped malformed PEM blocks in
CA / client-cert bundles; the fork's `pem_reader_iter(...).collect()?`
fails the whole connection on the first malformed block (fail-closed).
For the platform's pinned-internal-PKI posture this is the safer
behaviour, and both production consumers construct
`TlsConfiguration::Rustls(_)` directly — the forked `Simple` path is not
exercised by our deployment. Key-path semantics are exact parity.

The post-fork content of the two divergent files is pinned byte-for-byte
in `FORK-EDITS.sha256`; the fork-hygiene gate fails CI if either file
changes without that manifest (and this document) being updated in the
same reviewed commit. rustls interop note: both workspaces resolve a
single rustls 0.23-series node (root lock 0.23.40, edge lock 0.23.38).

Every deliberate edit carries a `LOCAL FORK (RUST-CVE-001)` marker comment.
Anything else diverging from the manifest is a gate failure — fix the drift
or update this document **and** the manifest in the same reviewed commit.

Dropped at vendoring time (cargo packaging/cache artifacts, never part of
the source tree contract): `Cargo.toml.orig`, `Cargo.lock`, `.cargo-ok`,
`.cargo_vcs_info.json`. Upstream `Cargo.lock` is intentionally absent so
filesystem security scanners do not re-flag the old `rustls-webpki 0.102.8`
pin recorded inside it. Also dropped: `certs/generate.sh` — the repo-level
`.gitignore` blocks every `certs/` path (guard against committing real
certificate material) and the script only regenerates upstream's local
test certificates, which the excluded-from-workspace fork never runs.

## Consumption

Both workspaces consume the fork via `[patch.crates-io]`:

- `/Cargo.toml` → `rumqttc = { path = "crates/local-rumqttc" }`
- `/sens-api-gateway/Cargo.toml` → `rumqttc = { path = "../crates/local-rumqttc" }`

Member manifests keep `rumqttc = "0.25"` untouched. The crate is excluded
from the root workspace so upstream code is not subject to our workspace
lints/tests.

## Exit criteria (when to delete this fork)

Delete `crates/local-rumqttc`, both `[patch.crates-io]` entries, and the
fork-hygiene gate when upstream rumqttc cuts a release whose
`rustls-webpki` requirement resolves to >= 0.103 **and** whose PEM path no
longer depends on unmaintained `rustls-pemfile` (or the ignore set is
re-justified through the advisory-ignore-sync gate). Re-run
`cargo deny check advisories` + `cargo audit --deny warnings` with zero
webpki/pemfile ignores to prove parity before removal.
