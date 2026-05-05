# EtherNet/IP (CIP) — Wire Contract Reference

**Protocol role on this device:** CIP client over EtherNet/IP against Rockwell Automation / Allen-Bradley controllers (CompactLogix, ControlLogix, Micro800, and legacy PLC-5 / SLC 500).

RFC 2119 keywords apply.

## 1. Standard + version

- **ODVA Common Industrial Protocol (CIP), Volume 1** (Common Industrial Protocol specification, Edition 3.29 — ODVA, 2022).
- **EtherNet/IP Adaptation of CIP, Volume 2** (Edition 1.29 — ODVA, 2022).
- TCP port **44818** (`src/plc_programming/ethernet_ip.rs:41`) for explicit messaging (`SendRRData`).
- UDP port **2222** for implicit / class-1 I/O messaging — NOT IMPLEMENTED (client does class-3 explicit messaging only).

## 2. Crate + feature flag

- Hand-rolled over `tokio::net::TcpStream` (1 061 LoC, `src/plc_programming/ethernet_ip.rs`).
- Feature flag: none — always compiled.

## 3. Supported operations

### 3.1 EtherNet/IP encapsulation commands

| Command | Hex | Status | Anchor |
|---------|-----|--------|--------|
| RegisterSession | `0x0065` | PRESENT | `src/plc_programming/ethernet_ip.rs:47` |
| UnRegisterSession | `0x0066` | PRESENT | `src/plc_programming/ethernet_ip.rs:48` |
| SendRRData | `0x006F` | PRESENT | `src/plc_programming/ethernet_ip.rs:49` |
| SendUnitData | `0x0070` | PRESENT | `src/plc_programming/ethernet_ip.rs:50` |
| ListServices / ListIdentity / ListInterfaces | `0x0004 / 0x0063 / 0x0064` | NOT-WIRED — ROADMAP-Q3 | Device-discovery helpers |
| NOP | `0x0000` | NOT-PURSUED | |

### 3.2 CIP services

| Service | Hex | Status | Anchor |
|---------|-----|--------|--------|
| Get_Attribute_All | `0x01` | PRESENT | `src/plc_programming/ethernet_ip.rs:53` |
| Get_Attribute_Single | `0x0E` | PRESENT | `src/plc_programming/ethernet_ip.rs:55` |
| Set_Attribute_Single | `0x10` | PRESENT | `src/plc_programming/ethernet_ip.rs:54` |
| Multiple_Service_Packet | `0x0A` | PRESENT | `src/plc_programming/ethernet_ip.rs:60` |
| Read Tag | `0x4C` | PRESENT | `src/plc_programming/ethernet_ip.rs:56` |
| Write Tag | `0x4D` | PRESENT | `src/plc_programming/ethernet_ip.rs:57` |
| Read Tag Fragmented | `0x52` | PRESENT | `src/plc_programming/ethernet_ip.rs:58` |
| Write Tag Fragmented | `0x53` | PRESENT | `src/plc_programming/ethernet_ip.rs:59` |
| Forward_Open | `0x54` | PRESENT | `src/plc_programming/ethernet_ip.rs:61` |
| Forward_Close | `0x4E` | PRESENT | `src/plc_programming/ethernet_ip.rs:62` |
| Large_Forward_Open | `0x5B` | NOT-WIRED — ROADMAP-Q3 | Required for ControlLogix large connection sizes |
| Reset | `0x05` | NOT-PURSUED | |

Reply-bit convention: CIP reply service code = request code with bit 7 set (`CIP_REPLY_FLAG = 0x80`, `src/plc_programming/ethernet_ip.rs:65`). A response to Read Tag is therefore `0xCC`, to Write Tag `0xCD`.

### 3.3 CIP classes referenced

| Class | Hex | Anchor |
|-------|-----|--------|
| Identity | `0x01` | `src/plc_programming/ethernet_ip.rs:75` |
| Message Router | `0x02` | `src/plc_programming/ethernet_ip.rs:76` |
| Connection Manager | `0x06` | `src/plc_programming/ethernet_ip.rs:77` |
| File Object | `0x37` | `src/plc_programming/ethernet_ip.rs:78` (used by program upload) |
| Program | `0x64` | `src/plc_programming/ethernet_ip.rs:79` |

### 3.4 CIP data types

| Type | Hex | Anchor |
|------|-----|--------|
| BOOL | `0x00C1` | `src/plc_programming/ethernet_ip.rs:68` |
| SINT | `0x00C2` | `src/plc_programming/ethernet_ip.rs:69` |
| INT | `0x00C3` | `src/plc_programming/ethernet_ip.rs:70` |
| DINT | `0x00C4` | `src/plc_programming/ethernet_ip.rs:71` |
| REAL | `0x00CA` | `src/plc_programming/ethernet_ip.rs:72` |
| STRING (structured) | — | NOT-PURSUED as a first-class decode — returned as byte buffer |

## 4. Wire format

### 4.1 EtherNet/IP encapsulation header (24 bytes)

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | Command | 2 bytes LE | See § 3.1 |
| `0x02` | Length | 2 bytes LE | Length of data portion (after this header) |
| `0x04` | Session Handle | 4 bytes LE | Returned by RegisterSession; `0` on the RegisterSession request itself |
| `0x08` | Status | 4 bytes LE | `0x00000000` = Success on request |
| `0x0C` | Sender Context | 8 bytes | Opaque echo field |
| `0x14` | Options | 4 bytes LE | `0x00000000` on all current requests |

Maximum encapsulated packet size: 64 KiB (`MAX_ENIP_PACKET_SIZE`, `src/plc_programming/ethernet_ip.rs:44`).

### 4.2 SendRRData (Common Packet Format)

The data portion of a `SendRRData` is:

```
Interface Handle (4B LE)  = 0x00000000 (CIP)
Timeout          (2B LE)
Item count       (2B LE)  = 2
Item[0] — Null Address   : type 0x0000, length 0
Item[1] — Unconnected Data: type 0x00B2, length = N, payload = CIP MR request
```

### 4.3 CIP Message-Router request

```
Service code                (1B)
Request path size in words  (1B)
Request path (EPATH)        (words)
Request payload             (N-bytes)
```

For a **Read Tag** request to tag `Flow_Rate`:

```
4C                              service Read Tag
03                              path size (words)
91 09 'F' 'l' 'o' 'w' '_' 'R' 'a' 't' 'e' 00      EPATH symbolic segment (ANSI 91), len=9, name padded to even
01 00                           element count = 1 (LE)
```

### 4.4 Forward_Open connection path

For a ControlLogix with slot `3`, the port/key segment list is:

```
01                backplane port
03                slot 3
20 02 24 01       class 0x02 (Message Router), instance 1 — the CPU target
```

Non-CPU connections (e.g. a remote 1756-EN2T) use a port `02` + IP segment chain; not covered by this chapter.

## 5. Error handling

- Per-request timeout: `timeout_secs` (`src/plc_programming/ethernet_ip.rs:107`), default 10 s.
- CIP General Status (1 byte) after the service code in the reply header is checked; non-zero surfaces as `Err`. Extended status words (ODVA Vol. 1 Appendix B) are preserved as raw bytes.
- Session loss: surfaced as a TCP error. Client MUST RegisterSession again on reconnect.
- No rate-limiter or circuit-breaker is wired on this path — the Modbus-style resilience primitives do NOT apply to EtherNet/IP.

## 6. Authentication + encryption

- **None.** CIP Security (ODVA Vol. 8) is NOT IMPLEMENTED. Deployment confinement MUST be applied at the network layer (VLAN, firewall, VPN overlay). See `deployment/dmz-topology.md`.
- FactoryTalk Security / RSLogix credential checking is server-side only; this client does not present any identity material.

## 7. Configuration schema

```yaml
ethernet_ip:
  - name: line2_clgx
    address: 10.42.2.30
    port: 44818
    slot: 3                       # ControlLogix CPU slot
    connection_path: "1,3"        # optional — backplane + slot list; derived from `slot` if absent
    timeout_secs: 10
    plc_type: control_logix       # compact_logix | control_logix | micro_800 | plc_5 | slc_500
```

See `src/plc_programming/ethernet_ip.rs:85-113`.

## 8. Worked example

Read tag `Temperature` (REAL) from a CompactLogix at `10.42.2.10`:

1. RegisterSession (Cmd `0x0065`, data = `0x0001 0x0000` protocol version + options).
2. Server responds with Session Handle, e.g. `0x12345678`.
3. SendRRData (Cmd `0x006F`) with a Null-Address + Unconnected-Data item containing the Read Tag request.
4. Response contains the CIP reply service `0xCC`, General Status `0x00`, data type `0x00CA` (REAL), 4-byte IEEE 754 LE value.

Decoded: `raw = 0x41A40000`, `value = 20.5`.

## 9. Test coverage

- 13 `#[test]` / `#[tokio::test]` blocks in `src/plc_programming/ethernet_ip.rs` exercise: encapsulation header round-trip, CPF item parsing, EPATH symbolic segment assembly for tag reads, General-Status decode paths.
- HIL against a 1769-L33ER CompactLogix or 1756-L73 ControlLogix is the RECOMMENDED acceptance path.

## 10. Interop certification status

- **ODVA EtherNet/IP Conformance Test:** not pursued. A conformant product needs the full encapsulation command set + Class 1 implicit messaging.
- **Rockwell Technology Partner / Encompass** program: not pursued.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Default port 44818 | `src/plc_programming/ethernet_ip.rs:41` |
| Encapsulation commands 0x0065/0x0066/0x006F/0x0070 | `src/plc_programming/ethernet_ip.rs:47-50` |
| CIP service set Read/Write/Forward_Open etc. | `src/plc_programming/ethernet_ip.rs:52-62` |
| Reply bit `0x80` | `src/plc_programming/ethernet_ip.rs:65` |
| Data types BOOL/SINT/INT/DINT/REAL | `src/plc_programming/ethernet_ip.rs:68-72` |
| Class IDs Identity/MR/CM/File/Program | `src/plc_programming/ethernet_ip.rs:75-79` |
| Max encapsulation packet 64 KiB | `src/plc_programming/ethernet_ip.rs:44` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| E1 | RegisterSession | Session Handle returned non-zero; Status = 0 |
| E2 | Read Tag `Temperature` (REAL) on a CompactLogix | Service reply `0xCC`, Status `0x00`, data type `0x00CA`, 4 bytes LE |
| E3 | Read Tag on a non-existent tag | Service reply `0xCC`, General Status `0x04` (Path Segment Error) |
| E4 | Write Tag without Forward_Open to a ControlLogix tag requiring a Class-3 connection | Reply General Status `0x01` (Connection failure) |
| E5 | Forward_Open with wrong slot in connection path | Status `0x01` or `0x21` (Invalid connection size); surfaced as `Err` |
| E6 | UnRegisterSession | TCP-level disconnect; no response body required |
| E7 | Oversize encapsulated packet (> 64 KiB) | Rejected before decode |
