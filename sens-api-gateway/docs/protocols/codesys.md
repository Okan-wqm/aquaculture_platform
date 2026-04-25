# CODESYS Gateway — Wire Contract Reference

**Protocol role on this device:** CODESYS V3 gateway / runtime client over TCP. `suderra-agent` targets CODESYS-based PLCs (WAGO PFC100/200, Festo CPX-E, Schneider M241/M251, Beckhoff CX legacy V2, plus any CODESYS V3.5 runtime).

RFC 2119 keywords apply.

## 1. Standard + version

- CODESYS Gateway V3 is a **vendor-proprietary** binary wire protocol. There is no public IEC / IEEE specification; interoperability is established against the CODESYS GmbH Gateway + Runtime reference implementation.
- Wireshark dissector `codesys` and the public `libcodesyscontrol` SDK documentation are the de-facto references used to implement the client.
- Default Gateway TCP port: **1217** (`src/plc_programming/codesys.rs:43`).
- Default direct-runtime TCP port: **11740** (`src/plc_programming/codesys.rs:46`).

## 2. Crate + feature flag

- Hand-rolled over `tokio::net::TcpStream` (782 LoC, `src/plc_programming/codesys.rs`).
- Feature flag: none — always compiled.

## 3. Supported operations

| Service | Hex | Status |
|---------|-----|--------|
| Login | `0x0001` | PRESENT |
| Logout | `0x0002` | PRESENT |
| GetDeviceInfo | `0x0010` | PRESENT |
| Symbol browse | — | PRESENT (via service range `0x0020`-`0x002F`) |
| Read / Write value | — | PRESENT (via service range `0x0030`-`0x003F`) |
| PLC start / stop | — | PRESENT |
| Online Change | — | ROADMAP-Q3 |
| Source download (application, tasks, symbol file) | — | PRESENT for symbol file; full source download is ROADMAP-Q3 |
| Encrypted channel (CODESYS V3.5 SP17+ TLS) | — | NOT-IMPLEMENTED — ROADMAP under ORPHAN-EDGE-005 |

Evidence: `src/plc_programming/codesys.rs:144-150` (`ServiceId` enum entry points).

## 4. Wire format

### 4.1 Magic + header

Every request frame starts with the 4-byte magic `0xCD 0x55 0x00 0x00` (`CODESYS_MAGIC`, `src/plc_programming/codesys.rs:49`).

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | Magic | 4 bytes | `CD 55 00 00` |
| `0x04` | Service ID | 2 bytes LE | Matches `ServiceId` enum |
| `0x06` | Length | 4 bytes LE | Total frame size including this header |
| `0x0A` | Session Handle | 4 bytes LE | `0` until Login succeeds |
| `0x0E..` | Payload | N bytes | Service-specific body |

Maximum frame size: **64 KiB** (`MAX_PACKET_SIZE`, `src/plc_programming/codesys.rs:52`).

### 4.2 Login payload

```
Username (length-prefixed UTF-8 string)
Password (length-prefixed UTF-8 string)
Device name (length-prefixed UTF-8 string; empty for direct-runtime mode)
Application name (length-prefixed UTF-8 string; default "Application")
```

`username` + `password` are optional in the YAML (`src/plc_programming/codesys.rs:80-85`); if both are absent the Login is sent without credentials and the gateway decides based on its own policy.

### 4.3 Symbol read payload

```
Symbol name (length-prefixed UTF-8 string)
Data type hint (2B LE) — OPTIONAL
```

The response is service-ID-echoed with the read-back value serialised per the CODESYS IEC type (BOOL = 1 byte, INT = 2 bytes LE, DINT = 4 bytes LE, REAL = 4 bytes IEEE 754 LE, STRING = length-prefixed).

## 5. Error handling

- Connect timeout: `timeout_secs` (`src/plc_programming/codesys.rs:93`), default 10 s.
- Service errors: surfaced inside the response payload as a 4-byte LE status followed by the response body. Non-zero status surfaces as `Err`.
- Login failure: `Logout` is not issued (no session). The TCP connection stays open until the agent drops it.

## 6. Authentication + encryption

- Plain TCP transport with optional Gateway-level username + password. Credentials are transmitted in the clear unless `encrypted: true` is set.
- `encrypted: true` corresponds to CODESYS V3.5 SP17+ TLS — the configuration flag is carried in the YAML (`src/plc_programming/codesys.rs:88-89`), but the client **does not yet negotiate TLS** on the wire. This mismatch is an ORPHAN-EDGE-005 roadmap item: setting `encrypted: true` today is advisory and MUST NOT be interpreted as a security guarantee until the TLS handshake is wired.
- Deployment MUST confine CODESYS traffic to a trusted segment (VLAN, VPN). See `deployment/dmz-topology.md`.

## 7. Configuration schema

```yaml
codesys:
  - name: wago_pfc200
    address: 10.42.4.10
    port: 1217                     # 1217 gateway | 11740 direct runtime
    mode: gateway                  # gateway | direct
    device_name: "PFC200_01"       # required in gateway mode, ignored in direct mode
    username: admin                # optional
    password: "********"           # optional — cleartext unless TLS (ROADMAP)
    encrypted: false               # TLS ROADMAP — leave false today
    timeout_secs: 10
    application: Application
```

## 8. Worked example

Login + GetDeviceInfo + read `GVL.Flow`:

1. `0xCD 0x55 0x00 0x00 | 0x0001 | len | session=0 | user/pass/device/app`.
2. Response carries a session handle.
3. `0xCD 0x55 0x00 0x00 | 0x0010 | len | session | empty body` → device info.
4. `0xCD 0x55 0x00 0x00 | 0x0030 | len | session | "GVL.Flow"` → 4-byte REAL response.

## 9. Test coverage

- 3 `#[test]` blocks in `src/plc_programming/codesys.rs`. Coverage is shallow: header magic, ServiceId enum round-trip. HIL against a live WAGO PFC200 / Schneider M241 is RECOMMENDED before any Tier-1 customer commitment.

## 10. Interop certification status

- **CODESYS-ready** vendor listing (CODESYS GmbH) — not pursued; requires CODESYS conformance labs.
- In-house: validated against CODESYS Control for Linux SL 4.6.0 on a Raspberry Pi CM4 test rig.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Gateway port 1217, Runtime port 11740 | `src/plc_programming/codesys.rs:43-46` |
| Magic `0xCD 0x55 0x00 0x00` | `src/plc_programming/codesys.rs:49` |
| Max packet 64 KiB | `src/plc_programming/codesys.rs:52` |
| Service enum (Login 0x0001, Logout 0x0002, GetDeviceInfo 0x0010, …) | `src/plc_programming/codesys.rs:144-150` |
| Connection-mode enum Gateway / Direct | `src/plc_programming/codesys.rs:113-121` |
| `encrypted` flag carried but TLS NOT WIRED | `src/plc_programming/codesys.rs:87-89` (ORPHAN-EDGE-005) |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| C1 | Login with correct credentials against a CODESYS gateway | Session handle non-zero |
| C2 | Login with wrong password | Service reply with non-zero status; session handle = 0 |
| C3 | GetDeviceInfo after Login | Device info struct parsed; PLC model string visible |
| C4 | Read `GVL.Flow` REAL | 4-byte IEEE 754 LE; surfaced as `f64` after cast |
| C5 | Read undefined symbol | Non-zero status; `Err("Symbol not found")` |
| C6 | Set `encrypted: true` | Today's build does not open TLS — treat flag as advisory, tracked as ROADMAP |
| C7 | Frame > 64 KiB | Rejected at framing layer |
