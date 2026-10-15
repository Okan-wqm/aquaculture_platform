# rustls advisories of 2026-10-15

**Owner agent:** claude · **Cycle:** 2026-10-15-rustls-advisories · **Branch:**
`fix/rustls-0-23-46-advisories`

The `sens-api-gateway-rust` job in `ci-affected.yml` turned red on main 6f205b988. Its step
"Audit root lockfile" (`cargo audit --deny warnings`) reported four advisories against
`rustls` 0.23.45, with no change to any Rust manifest or lockfile. The gateway and fuzz audit
steps never ran because the root step failed first.

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

#### Fix

- `cargo update -p rustls --precise 0.23.46` in each of the three workspaces. Every `rustls`
  requirement is `"0.23"`, so 0.23.46 is in range and no manifest changes. 0.23.46 declares
  the same dependency requirements and features as 0.23.45, so each lockfile diff is the
  `rustls` version and checksum only.
- `cargo tree -i rustls` shows a single `rustls` v0.23.46 in each graph.
- No audit ignore was added.

#### Verification

- cargo-audit 0.22.2 with the advisory database of 2026-10-14 reports the four advisories on the
  origin/main root lockfile and none on the updated one (`cargo audit --deny warnings`, exit 0).
- The gateway and fuzz audit steps, run exactly as `ci-affected.yml` runs them, no longer report
  any `rustls` advisory. They still fail on advisories this change does not touch, added to the
  database on 2026-10-12: five `quinn-proto` 0.11.16 advisories (RUSTSEC-2026-0338 to
  RUSTSEC-2026-0342; `quinn` is reqwest's optional HTTP/3 dependency, locked but not compiled)
  and, in the gateway step only, `unsafe-libyaml` unmaintained (RUSTSEC-2024-0449, through
  `serde_yaml`), which `--deny warnings` makes fatal.
