# Rust advisory of 2026-10-23: ctutils

**Owner agent:** claude · **Cycle:** 2026-10-23-ctutils-advisory · **Branch:**
`fix/rustsec-2026-0385-ctutils`

RustSec published RUSTSEC-2026-0385 against `ctutils` on 2026-10-23. No Rust manifest or
lockfile changed. The step "Audit root lockfile" (`cargo audit --deny warnings`) of the
`sens-api-gateway-rust` job in `ci-affected.yml` then failed, and the required
`sens-enterprise-summary` check went red with it on every PR that runs the job (CI run
39923595892).

## Findings

### SUPPLY-LOW-029 — ctutils 0.4.2 carries RUSTSEC-2026-0385

- **Advisory:** RUSTSEC-2026-0385, "Non-constant-time mask generation and `u128`
  comparisons" (category `crypto-failure`; upstream fix RustCrypto/utils#1569).
  - The `const fn` mask generators of `ctutils::Choice` could compile to a branch on common
    platforms.
  - `u128` comparisons branched on 32-bit targets.
  - Patched `>= 0.4.4`.
- **Where:** only the root `Cargo.lock` holds `ctutils` (0.4.2). The gateway, gateway-fuzz
  and both WASM lockfiles do not.
  - Its only dependent is `digest` 0.11.2. `digest` uses it in one file, `mac.rs`: the
    `Mac::verify*` tag comparisons and `CtOutput` equality.
  - `cargo tree -i ctutils` reaches it through `hmac` 0.13.0, `md-5` and `sha2` under
    `postgres-protocol` 0.6.12. From there it goes through `tokio-postgres` and
    `deadpool-postgres` into `sensor-ingestion` and `outbox-rs`. `router-coprocessor` also
    reaches it through `hmac` and `sha2`.
- **Reach:** the only call in this graph that runs a secret-dependent `ctutils` comparison
  is the SCRAM-SHA-256 client in `postgres-protocol` (`authentication/sasl.rs:300`,
  `hmac.verify_slice`). It checks the server's ServerSignature against the value the client
  computed. Only the Postgres server, or an attacker already terminating the TLS connection,
  could measure that branch. The leaked value is bound to one handshake's nonces, and the
  client aborts on the first mismatch. `router-coprocessor` only signs with HMAC; it never
  verifies. No 32-bit target is built. The defect is real but has no practical exploit path
  here, hence LOW. The merge block it caused is a process effect, not the severity.

#### Fix (SUPPLY-LOW-029)

- `cargo update -p ctutils --precise 0.4.4` in the root workspace.
  - 0.4.4 is the first patched release. Its `rust-version` is 1.87, within the workspace
    `rust-version = "1.88"` and the CI toolchain 1.88.0.
  - Its dependency requirements match 0.4.2 except `subtle ^2.6`, which is optional and
    not enabled here.
  - The lockfile diff is the `ctutils` version and checksum only. No manifest changes and no
    other crate moves.
- No audit ignore was added. No test pins Rust dependency floors, so none changes.

#### Verification (SUPPLY-LOW-029)

- Tools: cargo-audit 0.22.2, advisory database of 2026-10-23 (1350 advisories, including
  RUSTSEC-2026-0385).
- The origin/main root lockfile fails `cargo audit --deny warnings` on exactly this advisory
  (exit 1). The updated one passes (exit 0).
- Every other `cargo audit` command of `ci-affected.yml` (gateway with its ignore list,
  fuzz, both WASM lockfiles) and the root command of `rust-ci.yml` exit 0.
- On toolchain 1.88.0, `cargo check --locked` passes for `sensor-ingestion`, `outbox-rs` and
  `router-coprocessor`.
