# Edge agent Modbus dependency under a non-commercial license

**Owner agent:** claude · **Cycle:** 2026-10-27-edge-modbus-license · **Branch:**
`claude/edge-remove-rodbus`

`sens-api-gateway` (crate `suderra-agent`) used `rodbus` for Modbus TCP, Modbus/TCP Security
and Modbus RTU. rodbus 1.x is published under a license agreement that permits
non-commercial, non-production use only and does not permit distribution. The edge agent is
built into release binaries by `edge-agent-release.yml`, so the dependency cannot ship.

## Findings

### SUPPLY-HIGH-037 — rodbus linked into the edge agent; deny.toml re-labelled its license

- **Where:**
  - `sens-api-gateway/Cargo.toml:102` — `rodbus = "=1.5.0-RC1"` (`"1.4"` from 2026-02-06).
  - `sens-api-gateway/src/modbus.rs:32-33` — rodbus `Channel` for TCP, TLS and RTU.
- **Upstream license:** rodbus 1.4.0 and 1.5.0-RC1 declare `license-file = "LICENSE.txt"`
  (the non-commercial / non-production agreement) and a README headed "Commercial library".
  Only rodbus 0.1.x (2020) was published with `license = "BSD-3-Clause"`.
- **Why the gate passed:** `sens-api-gateway/deny.toml:138-145` carried
  `[[licenses.clarify]] crate = "rodbus", expression = "BSD-3-Clause"`. A clarify entry
  replaces the license cargo-deny detects, so `cargo deny check licenses` (rust-ci, and the
  release gate at `edge-agent-release.yml:207-229`) passed. `docs/commercial/third-party-notices.md`,
  shipped as the release `NOTICE.md`, repeated the BSD-3-Clause label.
- **Rule:** every crate linked into a distributed binary must pass license detection on its
  own published license text; `[[licenses.clarify]]` is reserved for first-party crates.

## Fix

- **Make it impossible:** the Modbus client is rewritten on `tokio-modbus` 0.17
  (MIT OR Apache-2.0). `src/modbus.rs` owns the transport:
  - plain TCP;
  - Modbus/TCP Security over `tokio-rustls` (server-only TLS or mTLS, TLS 1.2 floor, PLC
    certificate verified against the configured CA and `server_name`);
  - RTU over `tokio-serial`.
  rodbus and its graph (`sfio-rustls-config`, `rx509`, `scursor`, `pkcs5`, `scrypt`, …) leave
  both lockfiles.
- **Behaviour kept from the previous client:** doubling reconnect backoff 2 s → 30 s
  (`ReconnectPolicy`, `Link`), per-request 5 s timeout, function-code whitelist, write
  address ranges, read/write rate limits, FC6 readback verification, circuit breaker.
- **Closed in the rewrite:** a request dropped mid-flight by an outer timeout now retires its
  transport (`LiveLink::in_flight`), so a late reply cannot be paired with the next request.
  RTU frames carry no transaction id to reject it.
- **Make it detectable:**
  - `deny.toml` drops the rodbus clarify entry and bans `rodbus` and `dnp3` in `[bans] deny`.
    With the new policy, the previous dependency tree fails with
    `error[banned]: crate 'rodbus = 1.5.0-RC1' is explicitly banned`.
  - `tests/invariants/deny_license_policy.rs` pins that clarify entries are first-party only,
    that the non-commercial crates are banned, and that they are absent from `Cargo.lock` and
    `fuzz/Cargo.lock`.
- **Docs:** third-party notices and OSS attribution list `tokio-modbus` / `tokio-rustls`;
  current-state docs under `sens-api-gateway/docs/` describe the new client.

## Verification

- `cargo test --no-fail-fast` (default features): 2558 passed, 0 failed.
- `src/modbus.rs` tests run against an in-process tokio-modbus server: every register type,
  FC6 readback, device exceptions, reconnect after a server restart, abandoned-request
  retirement, server-only TLS, mTLS, unknown CA, wrong server name, missing client
  certificate and a half-configured mTLS block.
- `cargo deny check licenses bans sources`: ok.
