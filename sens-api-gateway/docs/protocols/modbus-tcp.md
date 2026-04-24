# Modbus-TCP — Wire Contract Reference

**Protocol role on this device:** client-only. `suderra-agent` initiates connections to Modbus-TCP servers (PLCs, sensor controllers) and polls pre-configured registers.

RFC 2119 keywords apply.

## 1. Standard + version

- Base application specification: **Modbus Application Protocol Specification V1.1b3**, Modbus-IDA, 2012-04-26.
- TCP transport framing: **MODBUS Messaging on TCP/IP Implementation Guide V1.0b**, 2006.
- MBAP (Modbus Application Protocol) header on TCP port **502** (RFC-assigned).
- Secure variant: **Modbus/TCP Security** (Modbus Organization, 2018) — TLS 1.2+ MAY be enabled via `tls.enabled`; see section 6.

## 2. Crate + feature flag

- Crate: `rodbus = "=1.4.0"` — pinned.
- Feature flag: none (default build). The client is compiled unconditionally.
- Pin rationale (Cargo.toml:64-70): rodbus 1.4 treats an empty `Path` as "no client certificate" for the server-only TLS path. Bumping the minor version MUST be gated by re-testing server-only TLS without mTLS.

Evidence: `Cargo.toml:70`, `src/modbus.rs:32-33`.

## 3. Supported operations

| Function code | Name | Status | Notes |
|---------------|------|--------|-------|
| `0x01` | Read Coils | PRESENT | `src/modbus.rs:55`, `src/modbus.rs:948-957` |
| `0x02` | Read Discrete Inputs | PRESENT | `src/modbus.rs:57`, `src/modbus.rs:959-969` |
| `0x03` | Read Holding Registers | PRESENT | `src/modbus.rs:59`, `src/modbus.rs:931-939` |
| `0x04` | Read Input Registers | PRESENT | `src/modbus.rs:61`, `src/modbus.rs:940-947` |
| `0x05` | Write Single Coil | PRESENT | `src/modbus.rs:63`, write path via `write_coil` |
| `0x06` | Write Single Register | PRESENT | `src/modbus.rs:65`, write path via `write_register` |
| `0x0F` | Write Multiple Coils | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | Explicit comment `src/modbus.rs:68` |
| `0x10` | Write Multiple Registers | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | Explicit comment `src/modbus.rs:68` |
| `0x11` | Report Server ID | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | |
| `0x16` | Mask Write Register | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | |
| `0x17` | Read/Write Multiple Registers | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | |
| `0x2B` | Encapsulated Interface Transport (MEI) | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | Device identification (0x2B/0x0E) not exposed. |

A server that advertises only FC 15/16 for writing MUST NOT be paired with this client against write-only registers until ORPHAN-EDGE-010 is closed; the workaround is per-register `FC 0x06` fan-out and the client's write rate-limiter enforces 2 ops/sec burst 4 per device (`src/modbus.rs:390-396`).

## 4. Wire format

### 4.1 MBAP header (7 bytes, sent on every request and response)

| Offset | Field | Size | Value / constraint |
|--------|-------|------|--------------------|
| `0x00` | Transaction Identifier | 2 bytes, big-endian | Echoed in the response; rodbus manages this automatically. |
| `0x02` | Protocol Identifier | 2 bytes, big-endian | MUST be `0x0000` (Modbus). |
| `0x04` | Length | 2 bytes, big-endian | Byte count of Unit ID + PDU that follows. |
| `0x06` | Unit Identifier | 1 byte | Slave ID; configured via `slave_id` (`src/config.rs:1049`). |

### 4.2 PDU — request / response structure

A request PDU MUST be `[Function Code (1) | Data (N)]`. A normal response echoes the function code; an exception response sets bit 7 of the function code (e.g. `0x83` for FC 3).

For **Read Holding Registers (0x03)**:
- Request data: `Starting Address (2, BE) | Quantity of Registers (2, BE)`.
- Response data: `Byte Count (1) | Register Values (2 × N, BE)`.

Multi-register decoding order is configurable per-register via `byte_order` (`src/config.rs:1071-1081`):

| `byte_order` | Layout (reg0 reg1) | Notes |
|--------------|--------------------|-------|
| `big_endian` (default) | `AB CD` | Standard Modbus. |
| `little_endian` | `CD AB` | Word-swapped. |
| `big_endian_byte_swap` | `BA DC` | Byte-swap within each 16-bit word. |
| `little_endian_byte_swap` | `DC BA` | Word-swap and byte-swap. |

### 4.3 Exception responses

The client surfaces rodbus error variants as `anyhow::Error`; it does not currently decode the exception code to a named Modbus code. The Modbus-defined codes `0x01` (illegal function), `0x02` (illegal data address), `0x03` (illegal data value), `0x04` (server device failure), `0x05` (acknowledge), `0x06` (server busy), `0x0A` (gateway path unavailable), `0x0B` (gateway target failed to respond) are preserved in the underlying rodbus error type.

## 5. Error handling

- Per-operation timeout: `5 s` (`MODBUS_TIMEOUT`, `src/modbus.rs:45`).
- Connect timeout: `10 s` (`CONNECT_TIMEOUT`, `src/modbus.rs:47`).
- Circuit breaker: 3 consecutive failures open the breaker for 30 s before a probe retry (`src/modbus.rs:49-51`). When OPEN, `read_all` MUST short-circuit with an error entry and not emit wire traffic.
- Retry strategy at the connect/RTU channel layer: doubling backoff 2 s → 30 s max (`src/modbus.rs:595-598`, `src/modbus.rs:724-727`).
- Read rate limiter (FC 1/2/3/4): tokens configured via `security.rate_limit_ops_per_sec` / `security.rate_limit_burst` (`src/modbus.rs:383-388`).
- Write rate limiter (FC 5/6): hard-coded burst `4`, sustained `2 ops/s` (`src/modbus.rs:390-396`). A runaway write loop is therefore capped to protect physical actuators.
- Error collection per `read_all` cycle is bounded to `MAX_ERRORS_PER_READ = 50` (`src/modbus.rs:67`) to prevent unbounded memory growth; overflow produces a single `"[Additional errors truncated]"` marker.

## 6. Authentication + encryption

### 6.1 Plain Modbus-TCP

Plain Modbus-TCP offers **no authentication and no integrity protection**. Any party with network reach to the PLC MAY read or write registers. Deployment MUST therefore either:

1. Air-gap the PLC network from any untrusted network; or
2. Enable `tls.enabled = true` (section 6.2); or
3. Interpose a firewall / diode; this falls outside the chapter and is covered by `deployment/dmz-topology.md`.

### 6.2 Modbus-TCP with TLS (rodbus `TlsClientConfig::full_pki`)

- Minimum TLS version: **1.2** (`src/modbus.rs:640`, `src/modbus.rs:662`).
- CA certificate validation is MANDATORY when TLS is enabled — `ca_cert_path` is REQUIRED (`src/modbus.rs:611-613`).
- Server-name validation via SNI: configured via `tls.server_name`; if omitted, the client falls back to the IP string of the configured address (`src/modbus.rs:617-622`).
- mTLS (client cert) is OPTIONAL. When `tls.client_cert_path` AND `tls.client_key_path` are both provided, rodbus is handed those paths via `full_pki` (`src/modbus.rs:634-642`). When omitted, the server-only TLS code path passes empty `Path::new("")` (`src/modbus.rs:655-663`) — this relies on the documented rodbus-1.4 behaviour (see Cargo.toml:64-69 BUG-005 comment). A minor-version bump on rodbus therefore MUST be accompanied by a regression test for server-only-TLS.
- Client private-key password: NOT SUPPORTED (`None` passed at `src/modbus.rs:639`, `src/modbus.rs:661`).
- `insecure_skip_verify` is exposed as a boolean (`src/config.rs:1031-1032`). Production deployments MUST leave it `false`.

### 6.3 Access-control policy (application layer)

Two defensive layers sit above the wire:

- Function-code whitelist — `security.allowed_function_codes` (`src/modbus.rs:421-442`). A configured server-side policy can reject e.g. `FC 0x05` even when the PLC would accept it.
- Write-address whitelist — `security.allowed_write_ranges` (`src/modbus.rs:467-489`). A compromised cloud credential cannot target pump relays / VFD setpoints outside this whitelist.

## 7. Configuration schema

YAML (per device) — fields match `ModbusDeviceConfig` in `src/config.rs:1035-1065`:

```yaml
modbus:
  - name: water_quality_plc
    connection_type: tcp          # "tcp" or "rtu"
    address: 10.42.1.50:502
    slave_id: 1                   # MBAP Unit Identifier
    tls:
      enabled: true
      server_name: plc.factory.local
      ca_cert_path: /etc/suderra/ca.pem
      client_cert_path: /etc/suderra/plc-client.pem   # optional (mTLS)
      client_key_path:  /etc/suderra/plc-client.key   # optional (mTLS)
      insecure_skip_verify: false
    security:
      enabled: true
      allowed_function_codes: [1, 2, 3, 4, 5, 6]
      allow_writes: true
      allowed_write_ranges: [[100, 110], [200, 205]]
      max_register_count: 125
      rate_limit_ops_per_sec: 10
      rate_limit_burst: 20
    registers:
      - name: ph_value
        address: 100
        register_type: holding     # holding | input | coil | discrete
        data_type: f32             # u16 | i16 | u32 | i32 | f32
        byte_order: big_endian     # big_endian | little_endian | big_endian_byte_swap | little_endian_byte_swap
        scale: 0.01
        unit: pH
        poll_interval_ms: 5000
```

## 8. Worked example

**Scenario:** read register `100` (holding, `f32`, big-endian) from slave `1`.

Request (MBAP + PDU), hex:

```
00 01 00 00 00 06 01 03 00 64 00 02
 ^^^^^ trans ^^^ proto ^^^ length  ^unit  ^fc  ^addr   ^qty
```

Response (value `0x41A40000` = `20.5` IEEE 754 big-endian):

```
00 01 00 00 00 07 01 03 04 41 A4 00 00
                          ^^^^^^^^^^^ four register bytes (2 registers × 2 bytes)
```

Surfaced as a `RegisterValue` (`src/modbus.rs:349-356`):

```json
{
  "name": "ph_value",
  "address": 100,
  "raw_value": 16804,
  "scaled_value": 0.205,
  "unit": "pH",
  "timestamp": "2026-04-24T12:00:00.000Z"
}
```

(`scaled_value` reflects `raw_float * scale`; `raw_value` surfaces the first 16-bit word for back-compatibility.)

## 9. Test coverage

- Unit tests inside `src/modbus.rs` (11 `#[test]` / `#[tokio::test]` blocks) exercise: byte-order conversion, function-code whitelist, write-range whitelist, rate-limiter behaviour, circuit-breaker transitions. No TLS path unit test; server-only TLS is covered by the BUG-005 regression test.
- Integration stress tests: `sens-api-gateway/tests/stress_test.rs` + `sens-api-gateway/tests/resource_benchmark.rs`.
- HIL coverage against a live Schneider M241 or Siemens SIMATIC ET 200SP MUST be documented in `testing/hil-coverage.md` before any customer deployment declares a given PLC family as Tier-1 supported. Coverage against ORPHAN-EDGE-010 function codes MUST remain negative until that finding closes.

## 10. Interop certification status

- **Modbus Organization Conformance Test Tool (MODTEST):** not pursued at the time of this snapshot. Conformance requires FC 15/16 support; see ORPHAN-EDGE-010 ROADMAP.
- **IEC 62443-4-2 FR3 / FR4 / FR5 mapping:** the function-code whitelist, TLS, and rate limiters map to FR3 (use control), FR4 (data confidentiality), FR5 (restricted data flow). Evidence cross-referenced in `compliance/iec-62443-4-2.md`.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| FC set 1/2/3/4/5/6 wired, 15/16/17/22/23/43 not | `src/modbus.rs:55-68` |
| rodbus crate pin | `Cargo.toml:70` |
| TCP + TLS channel spawn | `src/modbus.rs:671-692` |
| RTU serial channel spawn | `src/modbus.rs:739-748` |
| `full_pki` server-only path | `src/modbus.rs:655-663` |
| Function-code whitelist | `src/modbus.rs:421-442` |
| Write-address range whitelist | `src/modbus.rs:467-489` |
| 5 s op timeout, 10 s connect, 3/30 s breaker | `src/modbus.rs:45-51` |
| Error-vector bound 50 | `src/modbus.rs:67` |
| Write rate-limit 2 ops/s burst 4 | `src/modbus.rs:390-396` |
| Byte-order enum | `src/config.rs:1071-1081` |

## Interop test plan

The following vectors are the minimum acceptance set. Each vector is deterministic against any compliant Modbus-TCP server.

| # | Input | Expected output |
|---|-------|-----------------|
| T1 | Configure one device, one holding register at `100`, `u16`, scale `1.0`; server advertises value `0x1234` | `raw_value = 0x1234`, `scaled_value = 4660.0` |
| T2 | Server returns exception `0x83 / 0x02` (illegal data address) | Operation surfaces as `Err`; circuit-breaker failure counter increments; value absent from `ModbusReadResult.values` |
| T3 | 4 consecutive timeouts on same device | After failure #3 the breaker opens and subsequent `read_all` calls return an error entry without touching the wire for the next 30 s |
| T4 | FC 0x05 request with `security.allow_writes=false` | `write_coil` returns `Err("Write operations not allowed by security policy")`; no PDU sent |
| T5 | FC 0x06 write to register `999` while `allowed_write_ranges = [[100, 110]]` | Rejected before the wire: `Err("Register address 999 is not in the allowed write range")` |
| T6 | TLS enabled, server presents cert signed by a different CA | rodbus TLS handshake fails; `connect_tcp_inner` returns context `"Failed to create TLS config ..."` |
| T7 | Configure `byte_order=big_endian_byte_swap`, server returns `[0x12, 0x34]` in the single register | Decoded raw word `0x3412` |
| T8 | Configure `data_type=f32`, 2-register read, response `41 A4 00 00` (big-endian) | `scaled_value ≈ 20.5 × scale` |
| T9 | Configure an FC that is whitelisted at the PLC but not in `allowed_function_codes` (e.g. `0x04`) | Pre-wire rejection; `"Function code 4 not allowed by security policy"` |
| T10 | Burst of 200 writes within 1 s | After the 4th write, subsequent writes return `"Write rate limit exceeded"` until ~500 ms elapses |
