# Modbus-RTU — Wire Contract Reference

**Protocol role on this device:** client-only master. `suderra-agent` is a Modbus-RTU master on a local serial interface (typically `/dev/ttyUSB0` or `/dev/ttyAMA0`) polling downstream RTU slaves.

RFC 2119 keywords apply.

## 1. Standard + version

- Base: **Modbus over Serial Line Specification and Implementation Guide V1.02**, Modbus-IDA, 2006-12-20.
- Character framing: RTU mode, 11-bit serial character (start bit + 8 data bits + parity + stop bit, or start bit + 8 data bits + 2 stop bits when parity is `None`).
- Application PDU: same as Modbus-TCP PDU; section 3 of this chapter lists the function-code coverage — identical to `modbus-tcp.md`.
- Error check: 16-bit CRC (polynomial `0xA001`) appended little-endian at the end of each frame.

## 2. Crate + feature flag

- Application layer: `rodbus = "=1.4.0"` (`Cargo.toml:70`).
- Serial transport: `tokio-serial = "5.4"` (`Cargo.toml:72`).
- Feature flag: none (default build), but wrapped in `#[cfg(target_os = "linux")]` (`src/modbus.rs:714-758`). Non-Linux hosts surface `Err("Modbus RTU not supported on this platform")`.

## 3. Supported operations

| Function code | Name | Status |
|---------------|------|--------|
| `0x01` Read Coils | PRESENT | |
| `0x02` Read Discrete Inputs | PRESENT | |
| `0x03` Read Holding Registers | PRESENT | |
| `0x04` Read Input Registers | PRESENT | |
| `0x05` Write Single Coil | PRESENT | |
| `0x06` Write Single Register | PRESENT | |
| `0x0F` Write Multiple Coils | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | |
| `0x10` Write Multiple Registers | NOT-IMPLEMENTED — ORPHAN-EDGE-010 ROADMAP | |
| Broadcast (Unit ID `0`) | NOT-IMPLEMENTED | Unicast-only; broadcast semantics `MUST NOT` be assumed. |

Function-code whitelist and write-range whitelist in `src/modbus.rs:421-489` apply identically to RTU devices.

## 4. Wire format

### 4.1 RTU frame layout (master → slave)

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | Slave address | 1 byte | `slave_id` at `src/config.rs:1049`. `0x00` broadcast is NOT ISSUED by this client. |
| `0x01` | Function code | 1 byte | See section 3. |
| `0x02..0x02+N` | Request data | N bytes | Identical payload to the TCP PDU, little-end-aligned where the spec calls for it. |
| `0x02+N` | CRC-16 | 2 bytes, **little-endian on the wire** | Polynomial `0xA001`, init `0xFFFF`. |

### 4.2 Inter-frame gap

Per the Modbus Serial spec § 2.5.1, frames are delimited by a silent interval of at least **3.5 character times** (`t3.5`) and a character gap of at most **1.5 character times** (`t1.5`). Enforcement is delegated to the `rodbus` + `tokio-serial` transport stack; this client does NOT re-implement it.

### 4.3 Serial line parameters

Defaults hard-coded at `src/modbus.rs:731-737`:

| Field | Default | Configurable? |
|-------|---------|---------------|
| Baud rate | `9600` | YES via `baud_rate` (`src/config.rs:1052`). |
| Data bits | 8 | NO (pinned `DataBits::Eight`). |
| Stop bits | 1 | NO (pinned `StopBits::One`). |
| Parity | None | NO (pinned `Parity::None`). |
| Flow control | None | NO (pinned `FlowControl::None`). |

Operators who need `E, 8, 1` or `7-bit` framing MUST raise an ORPHAN finding and expose the knob; the current configuration surface does not expose parity. This is a documented gap, not a silent restriction.

## 5. Error handling

- Connect retry: doubling backoff 2 s → 30 s (`src/modbus.rs:724-727`).
- Per-operation timeout: 5 s (`MODBUS_TIMEOUT`).
- Circuit breaker: identical to TCP (3 failures / 30 s recovery).
- CRC validation: performed by the rodbus serial channel; a CRC mismatch surfaces as a rodbus `FrameParse` error mapped to `anyhow::Error`.
- Losing an intermediate frame (the master times out before the slave completes): treated as a per-operation failure; the circuit breaker records it and the next poll cycle retries.

## 6. Authentication + encryption

- **None.** Modbus-RTU over serial has no authentication, no integrity protection beyond CRC-16, and no encryption. CRC is a link-layer error-detection code, not a security primitive.
- Defence-in-depth MUST be physical: enclosure access control, RS-485 bus isolation, optical isolators on safety-critical loops. This is `HARDWARE-VENDOR RESPONSIBILITY` and is out of the device firmware scope.
- Function-code + write-range whitelists (section 6.3 of `modbus-tcp.md`) apply to RTU devices identically and are the sole programmatic defence.

## 7. Configuration schema

```yaml
modbus:
  - name: flow_meter_rs485
    connection_type: rtu
    address: /dev/ttyUSB0         # serial port path
    baud_rate: 19200               # 9600 (default) | 19200 | 38400 | 57600 | 115200
    slave_id: 7
    security:
      enabled: true
      allowed_function_codes: [3, 4, 6]
      allow_writes: false
      max_register_count: 64
      rate_limit_ops_per_sec: 5
      rate_limit_burst: 10
    registers:
      - name: flow_rate
        address: 10
        register_type: holding
        data_type: f32
        byte_order: big_endian
        scale: 0.1
        unit: "L/min"
        poll_interval_ms: 2000
```

## 8. Worked example

Read 2 holding registers starting at `0x000A` from slave `7`:

```
Slave  FC   Address  Quantity   CRC-lo CRC-hi
07    03   00 0A    00 02      E4 90
```

Successful response (4 data bytes for 2 registers, values `0x01F4 0x0000` = `500.0` big-endian `f32` pre-scale, post-scale `50.0 L/min`):

```
Slave  FC   BC   Data                    CRC-lo CRC-hi
07    03   04   01 F4 00 00              BA 51
```

Exception response (illegal data address):

```
Slave  FC+0x80   ExCode   CRC-lo CRC-hi
07    83         02        C0 F1
```

## 9. Test coverage

- RTU-specific behaviour (serial settings, `#[cfg(target_os="linux")]`) is not covered by unit tests — it requires either HIL or a loopback COM emulator (e.g. `socat pty,raw,link=/dev/ttyX` + a Modbus RTU slave simulator such as `diagslave`).
- The shared Modbus helpers (byte order, whitelist, rate-limit) are covered by the 11 test blocks inside `src/modbus.rs`.
- Vendor-HIL loops MUST validate: (a) 19200-8-N-1 round-trip at 1 Hz for 24 h without CRC errors; (b) cable-pull ⇒ circuit-breaker OPEN within 15 s; (c) cable-restore ⇒ breaker RECOVERS within 60 s.

## 10. Interop certification status

- **Modbus-IDA Conformance Test** for RTU masters: not pursued. Multi-write absence (ORPHAN-EDGE-010) blocks full certification.
- **Vendor interoperability matrix:** practical operation confirmed against `diagslave` RTU simulator and basic WAGO 750 RTU gateways; no formal third-party test-house PASS on file.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| RTU path gated by `target_os="linux"` | `src/modbus.rs:714` |
| Hard-coded 8-N-1, no flow control | `src/modbus.rs:731-737` |
| Default baud 9600 | `src/modbus.rs:716` |
| Retry strategy 2 s → 30 s | `src/modbus.rs:724-727` |
| Whitelist + rate-limit shared with TCP path | `src/modbus.rs:421-489`, `src/modbus.rs:390-396` |
| FC set = FC 1/2/3/4/5/6 | `src/modbus.rs:55-68` |
| Crate pins | `Cargo.toml:70-72` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| R1 | Loopback pty at 9600-8-N-1; slave simulator answers FC 3 at addr 0x000A with `0x01F4` | `raw_value = 0x01F4`, `scaled_value = 500.0` pre-scale |
| R2 | Inject a 1-bit CRC error into the response | Operation fails with a parse error; breaker failure counter increments; no entry in `values` |
| R3 | Disconnect cable mid-transaction | Timeout after 5 s; third consecutive failure opens the breaker |
| R4 | Non-Linux target (macOS / Windows) | `Err("Modbus RTU not supported on this platform")` surfaced by `connect` |
| R5 | Configure a parity the code does not expose (e.g. `E`) | Not possible via the YAML surface; this is a known configuration gap (not a silent override). |
| R6 | Unit ID `0` (broadcast) | Not issued by this client; no regression test. Broadcast semantics MUST NOT be relied upon. |
| R7 | Sustained 100 reads/s with `rate_limit_ops_per_sec=5`, `rate_limit_burst=10` | First ~10 requests pass, subsequent requests return `"Rate limit exceeded"` |
