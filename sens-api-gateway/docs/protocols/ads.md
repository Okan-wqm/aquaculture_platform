# Beckhoff ADS / AMS — Wire Contract Reference

**Protocol role on this device:** ADS client over TCP/AMS router against Beckhoff TwinCAT 2 / TwinCAT 3 / TwinCAT BSD / CX-series embedded controllers.

RFC 2119 keywords apply.

## 1. Standard + version

- **Beckhoff ADS (Automation Device Specification) Protocol Specification** — Beckhoff Infosys documentation (non-public version-anchored PDF; revision current at 2023).
- **AMS** (Automation Message Specification) provides the router layer + addressing (`AmsNetId` + `AmsPort`).
- TCP port **48898** for the AMS router (`src/plc_programming/ads.rs:43`). TCP port 8016 is an alternative when ADS-over-MQTT or secure ADS is in use — NOT IMPLEMENTED.

## 2. Crate + feature flag

- Hand-rolled over `tokio::net::TcpStream` (1 006 LoC, `src/plc_programming/ads.rs`).
- Feature flag: none — always compiled.

## 3. Supported operations

| ADS Command | Hex | Status | Anchor |
|-------------|-----|--------|--------|
| Read Device Info | `0x0001` | COMPILED-CONST — not invoked | `src/plc_programming/ads.rs:57`, `#[allow(dead_code)]` |
| Read | `0x0002` | PRESENT | `src/plc_programming/ads.rs:58` |
| Write | `0x0003` | PRESENT | `src/plc_programming/ads.rs:59` |
| Read State | `0x0004` | PRESENT | `src/plc_programming/ads.rs:60` |
| Write Control | `0x0005` | PRESENT | `src/plc_programming/ads.rs:61` |
| Add Device Notification | `0x0006` | COMPILED-CONST — not invoked | `src/plc_programming/ads.rs:63`, `#[allow(dead_code)]` |
| Delete Device Notification | `0x0007` | COMPILED-CONST — not invoked | `src/plc_programming/ads.rs:65`, `#[allow(dead_code)]` |
| Device Notification (push) | `0x0008` | COMPILED-CONST — not invoked | `src/plc_programming/ads.rs:67`, `#[allow(dead_code)]` |
| Read-Write | `0x0009` | PRESENT | `src/plc_programming/ads.rs:68` |

`#[allow(dead_code)]` on the notification commands marks them as `CODE-COMPILED-NOT-WIRED` — the symbol-subscription / change-push facility is a ROADMAP-Q3 item.

### 3.1 Index Groups used

| Index Group | Hex | Purpose | Anchor |
|-------------|-----|---------|--------|
| `SYM_HNDBYNAME` | `0xF003` | Resolve a symbol name to a handle | `src/plc_programming/ads.rs:71` |
| `SYM_VALBYHND` | `0xF005` | Read/write a value by handle | `src/plc_programming/ads.rs:72` |
| `SYM_RELEASEHND` | `0xF006` | Release a symbol handle | `src/plc_programming/ads.rs:73` |
| `SYM_INFOBYNAME` | `0xF007` | Read symbol metadata — compiled-const, NOT INVOKED | `src/plc_programming/ads.rs:75` |
| `SYM_DOWNLOAD` | `0xF020` | Upload source to PLC | `src/plc_programming/ads.rs:76` |
| `SYM_UPLOAD` | `0xF021` | Download source from PLC | `src/plc_programming/ads.rs:77` |

### 3.2 Well-known ADS ports

| Service | Port | Anchor |
|---------|------|--------|
| Logger | 100 | `src/plc_programming/ads.rs:82` (COMPILED-CONST) |
| EventLog | 110 | `src/plc_programming/ads.rs:84` (COMPILED-CONST) |
| PLC TwinCAT 2 | 801 | `src/plc_programming/ads.rs:88` (COMPILED-CONST) |
| PLC TwinCAT 3.1 | 851 | `src/plc_programming/ads.rs:89` (wired default) |
| NC | 500 | `src/plc_programming/ads.rs:91` (COMPILED-CONST) |
| IO | 300 | `src/plc_programming/ads.rs:93` (COMPILED-CONST) |
| SystemService | 10 000 | `src/plc_programming/ads.rs:86` (COMPILED-CONST) |

### 3.3 ADS State values

Defined at `src/plc_programming/ads.rs:97-125`: `INVALID`, `IDLE`, `RESET`, `INIT`, `START`, `RUN`, `STOP`, `SAVECFG`, `LOADCFG`, `POWERFAILURE`, `POWERGOOD`, `ERROR`, `SHUTDOWN`, `SUSPEND`, `RESUME`, `CONFIG`, `RECONFIG`.

Only `RUN`, `STOP`, `ERROR`, `CONFIG`, `RECONFIG` are actively consumed in control-flow logic; the remainder are compiled-const `#[allow(dead_code)]` placeholders.

## 4. Wire format

### 4.1 ADS-over-TCP framing

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | Reserved | 2 bytes | `0x00 0x00` |
| `0x02` | Length | 4 bytes LE | total bytes after this 6-byte ADS TCP header (= AMS header + data) |

Total TCP header size: **6 bytes** (`ADS_TCP_HEADER_SIZE`, `src/plc_programming/ads.rs:46`).

### 4.2 AMS header (32 bytes)

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | AMS Net ID Target | 6 bytes | e.g. `192.168.1.50.1.1` → `C0 A8 01 32 01 01` |
| `0x06` | AMS Port Target | 2 bytes LE | e.g. `851` (TC3 PLC) |
| `0x08` | AMS Net ID Source | 6 bytes | Client-side AMS Net ID |
| `0x0E` | AMS Port Source | 2 bytes LE | Client port (usually `32905` range) |
| `0x10` | Command ID | 2 bytes LE | § 3 |
| `0x12` | State Flags | 2 bytes LE | Bit 0 = Response, Bit 2 = ADS Command |
| `0x14` | Data Length | 4 bytes LE | Bytes of ADS payload following the AMS header |
| `0x18` | Error Code | 4 bytes LE | AMS-level error — `0x00000000` on request |
| `0x1C` | Invoke ID | 4 bytes LE | Client-chosen; echoed on response |

Total AMS header: **32 bytes** (`AMS_HEADER_SIZE`, `src/plc_programming/ads.rs:49`).

### 4.3 ADS Read request payload

```
Index Group  (4B LE)
Index Offset (4B LE)
Length       (4B LE)   — bytes to read
```

### 4.3a ADS Read response payload

```
Result      (4B LE)    — ADS return code; 0 = success
Data length (4B LE)
Data        (N bytes)
```

### 4.4 Maximum packet size

1 MiB (`MAX_AMS_PACKET_SIZE`, `src/plc_programming/ads.rs:52`) — hard guard against an oversized AMS payload that would exhaust the edge device's heap.

## 5. Error handling

- AMS-level error codes are mapped through `ads_error_message` (`src/plc_programming/ads.rs:127-`). Table highlights:
  - `0x0001` Internal error
  - `0x0006` Target port not found
  - `0x0007` Target machine not found
  - `0x000D` Port not connected
  - `0x000F` Invalid AMS Net ID
  - ADS application-layer codes `0x0700` Error class not valid, `0x0706` Service not supported, etc.
- Per-request timeout via the `timeout` helper.
- No retry / circuit-breaker — a stalled ADS connection is surfaced as a TCP error to the caller.

## 6. Authentication + encryption

- **Legacy ADS (48898) has no authentication and no encryption.** An "ADS route" is added on the target TwinCAT runtime via the System Manager / TwinCAT 3 engineering; the route is identified by Source AMS Net ID only.
- **Secure ADS** (TwinCAT 3.1 build 4024+, TLS-wrapped on port 8016) is NOT IMPLEMENTED — ROADMAP-Q3 under `ORPHAN-EDGE-005` extension.
- Deployment MUST confine ADS traffic to a trusted network segment. See `deployment/dmz-topology.md`.

## 7. Configuration schema

```yaml
ads:
  - name: tc3_runtime
    address: 10.42.3.20
    port: 48898
    target_ams_net_id: 192.168.1.50.1.1
    target_ams_port: 851                 # TwinCAT 3.1 PLC
    source_ams_net_id: 10.42.3.100.1.1   # any value registered in the TwinCAT route list
    source_ams_port: 32905
    timeout_secs: 10
```

## 8. Worked example

Read symbol `MAIN.StateMachine.Step` (DINT):

1. `ADS Read-Write` (Cmd `0x0009`) on `IndexGroup=0xF003` (`SYM_HNDBYNAME`), `IndexOffset=0`, writing the UTF-8 symbol name, reading back a 4-byte handle.
2. `ADS Read` (Cmd `0x0002`) on `IndexGroup=0xF005`, `IndexOffset=<handle>`, `Length=4`, response contains the DINT.
3. `ADS Write` (Cmd `0x0003`) on `IndexGroup=0xF006` with the handle payload releases the handle.

## 9. Test coverage

- 9 `#[test]` / `#[tokio::test]` blocks in `src/plc_programming/ads.rs` cover: AMS header round-trip, TCP framing round-trip, error-code mapping, state-value enum conversion.
- Notification (change-push) code path is not covered — consistent with its `COMPILED-CONST` status.

## 10. Interop certification status

- **Beckhoff Partner Program:** not pursued.
- **TwinCAT 3 compatibility list:** in-house matrix confirms TC3 4024 on a CX5130; TC2 and TC-BSD not tested.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Default port 48898 | `src/plc_programming/ads.rs:43` |
| TCP header 6 bytes, AMS header 32 bytes | `src/plc_programming/ads.rs:46-49` |
| Max AMS packet 1 MiB | `src/plc_programming/ads.rs:52` |
| Command IDs (Read 0x02, Write 0x03, ReadState 0x04, WriteControl 0x05, Read-Write 0x09) | `src/plc_programming/ads.rs:58-68` |
| Notification commands COMPILED-CONST | `src/plc_programming/ads.rs:55, 62-67` (`#[allow(dead_code)]`) |
| Index groups 0xF003/0xF005/0xF006/0xF020/0xF021 | `src/plc_programming/ads.rs:71-77` |
| Ports table | `src/plc_programming/ads.rs:82-93` |
| State enum | `src/plc_programming/ads.rs:97-125` |
| Error-code table | `src/plc_programming/ads.rs:127-` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| A1 | TCP connect to a TC3 runtime, AMS ports set | TCP connection holds; no ADS traffic on the wire until a Read/Write is issued |
| A2 | Request `0x0004 ReadState` | 8-byte payload with `adsState=RUN(5)`, `deviceState` |
| A3 | Request `0x0009 Read-Write` IG `0xF003` with symbol name `MAIN.Step` | 4-byte handle; AMS error code 0 |
| A4 | Request `0x0002 Read` on stale handle after runtime restart | AMS error `0x0005 Wrong receive HMSG` or ADS `0x0702 Symbol not found` → surfaced as `Err` |
| A5 | Target AMS Net ID not on the route list | AMS error `0x0007 Target machine not found` |
| A6 | Target AMS Port not active (e.g. port 801 on a TC3 runtime) | AMS error `0x0006 Target port not found` |
| A7 | 2 MiB response (> max) | Rejected at the framing layer |
| A8 | Add Device Notification request | Not issued — command COMPILED-CONST, ROADMAP-Q3 |
