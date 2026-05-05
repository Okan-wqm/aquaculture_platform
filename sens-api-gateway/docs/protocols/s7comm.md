# Siemens S7comm — Wire Contract Reference

**Protocol role on this device:** S7comm client over ISO-on-TCP (RFC 1006). `suderra-agent` opens a single COTP+S7 connection to a Siemens S7-300 / S7-400 / S7-1200 / S7-1500 PLC and issues Read/Write Var, PLC Control, and Block Upload/Download requests.

RFC 2119 keywords apply.

## 1. Standard + version

- Transport: **ISO 8073 / ITU-T X.224 Class 0** (COTP) over **RFC 1006 TPKT**, on TCP port **102** (`src/plc_programming/s7comm.rs:41`).
- Application protocol: Siemens S7 Communication (vendor proprietary, aka S7comm; S7-1200/1500 also offer S7comm-plus with additional integrity checks).
- Public references: Wireshark `s7comm` dissector (Thomas Wiens), libnodave, snap7.
- S7-1500 requires "PUT/GET access allowed" to be ticked in the TIA Portal **protection properties** — without it the PLC rejects `S7 Job` Read/Write Var (`src/plc_programming/s7comm.rs:17-18`).

## 2. Crate + feature flag

- Hand-rolled over `tokio::net::TcpStream`. No external S7 crate is consumed. Buffer handling and TPKT framing are implemented directly in `src/plc_programming/s7comm.rs` (1 624 LoC).
- Feature flag: none — always compiled.

## 3. Supported operations

| S7 function | Hex | Status | Anchor |
|-------------|-----|--------|--------|
| Setup Communication | `0xF0` | PRESENT | `src/plc_programming/s7comm.rs:73` |
| Read Var | `0x04` | PRESENT | `src/plc_programming/s7comm.rs:71` |
| Write Var | `0x05` | PRESENT | `src/plc_programming/s7comm.rs:72` |
| Start Upload | `0x1D` | PRESENT | `src/plc_programming/s7comm.rs:74` |
| Upload | `0x1E` | PRESENT | `src/plc_programming/s7comm.rs:75` |
| End Upload | `0x1F` | PRESENT | `src/plc_programming/s7comm.rs:76` |
| Start Download | `0x1A` | PRESENT | `src/plc_programming/s7comm.rs:77` |
| Download | `0x1B` | PRESENT | `src/plc_programming/s7comm.rs:78` |
| End Download | `0x1C` | PRESENT | `src/plc_programming/s7comm.rs:79` |
| PLC Control (warm/cold restart, run) | `0x28` | PRESENT | `src/plc_programming/s7comm.rs:80` |
| PLC Stop | `0x29` | PRESENT | `src/plc_programming/s7comm.rs:81` |
| Userdata functions (SZL reads, cyclic data, diagnostics) | — | NOT-WIRED — ROADMAP-Q3 | Protocol ID byte `S7_USERDATA = 0x07` defined at `src/plc_programming/s7comm.rs:68` but no send path |
| S7comm-plus (S7-1500 secured) | — | NOT-WIRED — ROADMAP | Comment at `src/plc_programming/s7comm.rs:9` |

## 4. Wire format

### 4.1 TPKT + COTP envelope

Every S7 frame is wrapped as:

| Offset | Field | Size | Value |
|--------|-------|------|-------|
| `0x00` | TPKT version | 1 byte | `0x03` |
| `0x01` | reserved | 1 byte | `0x00` |
| `0x02` | TPKT length | 2 bytes BE | total length including TPKT header |
| `0x04` | COTP length indicator | 1 byte | length of COTP header following this byte |
| `0x05` | COTP PDU type | 1 byte | `0xE0` CR (connect), `0xD0` CC, `0xF0` DT (`src/plc_programming/s7comm.rs:47-53`) |
| `0x06..` | COTP fields | variable | For DT: destination reference + TPDU number; for CR: class + options + parameters |

### 4.2 S7 Protocol Data Unit

Following the COTP-DT header, the S7 PDU is:

| Offset | Field | Size | Notes |
|--------|-------|------|-------|
| `0x00` | Protocol ID | 1 byte | `0x32` (`src/plc_programming/s7comm.rs:56`) |
| `0x01` | ROSCTR | 1 byte | `0x01` Job, `0x02` Ack, `0x03` Ack-Data, `0x07` Userdata (`src/plc_programming/s7comm.rs:59-68`) |
| `0x02..0x03` | Redundancy ID | 2 bytes | `0x00 0x00` (unused) |
| `0x04..0x05` | PDU Reference | 2 bytes BE | echoed in the Ack-Data |
| `0x06..0x07` | Parameter Length | 2 bytes BE | |
| `0x08..0x09` | Data Length | 2 bytes BE | |
| `0x0A..0x0B` | Error Class / Error Code | 2 bytes (Ack-Data only) | decoded at `src/plc_programming/s7comm.rs:110-164` |
| parameter region | — | N bytes | function code at offset 0 |
| data region | — | M bytes | per-request payload (values for Write, response for Read) |

### 4.3 Memory area codes (for ReadVar / WriteVar Item)

| Area | Hex | Meaning |
|------|-----|---------|
| `PE` — Process Inputs | `0x81` | Input image table (`src/plc_programming/s7comm.rs:84`) |
| `PA` — Process Outputs | `0x82` | Output image table |
| `MK` — Merkers (bit memory, M area) | `0x83` | |
| `DB` — Data Blocks | `0x84` | The DB number is in the item header |
| `CT` — Counters | `0x1C` | |
| `TM` — Timers | `0x1D` | |

### 4.4 Transport sizes (request) / data transport sizes (response)

Request parameter transport sizes (`src/plc_programming/s7comm.rs:92-98`):

| Token | Hex | Meaning |
|-------|-----|---------|
| `BIT` | `0x01` | single bit |
| `BYTE` | `0x02` | 8-bit |
| `WORD` | `0x04` | 16-bit |
| `INT` | `0x05` | signed 16-bit |
| `DWORD` | `0x06` | 32-bit |
| `DINT` | `0x07` | signed 32-bit |
| `REAL` | `0x08` | IEEE 754 32-bit |

Response data transport sizes (`src/plc_programming/s7comm.rs:101-103`):

| Token | Hex |
|-------|-----|
| `DATA_BIT` | `0x03` |
| `DATA_BYTE_WORD_DWORD` | `0x04` |
| `DATA_REAL` | `0x08` |

### 4.5 PDU size negotiation

The client sends a Setup Communication Job (`0xF0`) with a requested PDU size; default **480 bytes** (`src/plc_programming/s7comm.rs:200`). The PLC responds with the negotiated size, which is the maximum payload per Read/Write Var request for the lifetime of the connection. Requests larger than the negotiated PDU MUST be split into multiple items or multiple requests.

## 5. Error handling

- Connect timeout: per `timeout_secs` (`src/plc_programming/s7comm.rs:197`), default 10 s.
- Max S7 packet size: 64 KiB (`MAX_S7_PACKET_SIZE`, `src/plc_programming/s7comm.rs:44`) — framed guard against oversized TPKT payload.
- Error-class / error-code decoding is performed by `parse_s7_error` (`src/plc_programming/s7comm.rs:110-164`). Surfaced strings include:
  - `0x81 0x01` Invalid syntax ID
  - `0x82 0x01` Invalid address
  - `0x82 0x04` Object does not exist
  - `0x83 0x01` CPU already in RUN
  - `0x83 0x02` CPU already in STOP
  - `0x84 0x01` PDU size error
  - `0x87 0x01` Read access not allowed
  - `0x87 0x02` Write access not allowed
  - `0xD6 0x01` CPU protection level
  - `0xD6 0x02` Insufficient privileges
  - `0xDC/0xDD/0xDE` Block download / upload / delete errors
  - `0xDF` Password error

An unknown `(class, code)` pair is preserved verbatim as `class=0xNN, code=0xNN`.

## 6. Authentication + encryption

- **None at the S7comm (classic) layer.** S7-300/400 and S7-1200/1500 in legacy PUT/GET mode carry no authentication beyond a PLC-configured "access password" (which the PLC validates via a separate Userdata channel — NOT WIRED here, see `ORPHAN-EDGE-005 / S7-plus`).
- **S7comm-plus** (Siemens-proprietary signed variant on S7-1200/1500) is NOT IMPLEMENTED — ROADMAP. Deployments against S7-1500 that enforce "Full protection" or "Communication only via TLS" MUST remain on an isolated cell network until S7comm-plus is wired.
- Network-level confinement MUST compensate: this agent SHOULD be deployed on a dedicated VLAN or VPN overlay (IPsec / WireGuard) with the PLC. See `deployment/dmz-topology.md`.

## 7. Configuration schema

```yaml
s7:
  - name: line1_s7_1500
    address: 10.42.1.40
    port: 102                  # ISO-on-TCP
    rack: 0
    slot: 1                    # 0 for S7-1200/1500, 1 default
    plc_type: s7_1500          # s7_300 | s7_400 | s7_1200 | s7_1500
    timeout_secs: 10
    pdu_size: 480              # negotiated — PLC may lower
```

## 8. Worked example

COTP Connection Request (CR) — client to PLC:

```
03 00 00 16                                TPKT v3, length 22
11 E0 00 00 00 01 00                       COTP CR, dst ref, src ref
C0 01 0A                                   parameter 0xC0: TPDU size 2^10=1024
C1 02 01 00                                parameter 0xC1: src TSAP 01 00 (rack=0 slot=0? — per Siemens convention)
C2 02 01 02                                parameter 0xC2: dst TSAP 01 02 (rack 0, slot 2) for S7-300 CPU
```

S7 Setup Communication Job:

```
03 00 00 19                                TPKT
02 F0 80                                   COTP DT
32 01 00 00 04 00 00 08 00 00 F0 00 00 01 00 01 01 E0   S7 PDU
                             ^^ func 0xF0 setup-comm
                                                ^^ ^^  requested PDU size 0x01E0 = 480
```

Read Var Job — read 2 bytes from `DB10.DBB0`:

```
... S7 PDU:
32 01 0000 0001 000E 0000          header (job, pduref=1, paramlen=14)
04 01                              function 0x04, item count 1
12 0A 10 02 0002 000A 84 000000   item: length 10, syntax-ID 0x10 ANY, type BYTE 0x02, count 2, DB=10, area 0x84, byte-offset 0
```

Ack-Data response (2 bytes `01 F4` = 500):

```
... S7 PDU:
32 03 0000 0001 0002 0005 0000     header (ack-data, errclass=0, errcode=0)
00 01                              function 0x04, item count 1
FF 04 0010 01 F4                   data item: success 0xFF, transport BYTE_WORD_DWORD, 16 bits, bytes 01 F4
```

## 9. Test coverage

- 11 `#[test]` / `#[tokio::test]` blocks in `src/plc_programming/s7comm.rs` cover: error-code decoding (`parse_s7_error`), COTP envelope, Job/Ack-Data header round-trips, ReadVar item construction, PLC Control parameter assembly.
- HIL against Siemens SIM-1500 or a real S7-1500 in the bench is the RECOMMENDED acceptance path before shipping to a Siemens-line customer.

## 10. Interop certification status

- **TIA Portal Openness + S7-1500 certified partner:** not pursued. Certification requires S7comm-plus support.
- **Wireshark `s7comm` dissector** traces confirm field-level equivalence with libnodave on S7-300 / S7-400.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| Port 102, hand-rolled | `src/plc_programming/s7comm.rs:41` |
| COTP CR/CC/DT tokens | `src/plc_programming/s7comm.rs:47-53` |
| S7 Protocol ID 0x32 | `src/plc_programming/s7comm.rs:56` |
| ROSCTR values | `src/plc_programming/s7comm.rs:59-68` |
| Function codes | `src/plc_programming/s7comm.rs:71-81` |
| Area codes PE/PA/MK/DB/CT/TM | `src/plc_programming/s7comm.rs:84-89` |
| Transport sizes | `src/plc_programming/s7comm.rs:92-103` |
| Error decode table | `src/plc_programming/s7comm.rs:110-164` |
| Default PDU size 480 | `src/plc_programming/s7comm.rs:200` |
| S7-1500 PUT/GET prerequisite | `src/plc_programming/s7comm.rs:17-18` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| S1 | COTP CR with dst TSAP `01 02` to S7-300 at rack 0 slot 2 | CC accepted; TPKT length ≥ 22 |
| S2 | Setup Communication with requested PDU `480` to an S7-1500 that negotiates `960` | Subsequent ReadVar respects `480` (we use the lower of requested and negotiated) |
| S3 | Read 2 bytes from `DB10.DBB0`, value `0x01F4` | Success item `FF 04 0010 01 F4` |
| S4 | Write `0x01 0xF4` to `DB10.DBB0` against a PLC with PUT/GET disabled | Ack-Data with `errClass=0x87`, `errCode=0x02` → surfaced as `Write access not allowed` |
| S5 | Read from `DB999.DBB0` when DB999 does not exist | `errClass=0x82`, `errCode=0x04` → `Object does not exist` |
| S6 | PLC Control Start on a CPU already in RUN | `errClass=0x83`, `errCode=0x01` → `CPU already in RUN` |
| S7 | Connect to an S7-1500 configured for "Full protection" | COTP CR succeeds; Setup Communication fails with `0xD6 0x01` CPU protection level — ROADMAP-Q3 |
| S8 | Frame larger than `MAX_S7_PACKET_SIZE` (64 KiB) | Rejected before parsing |
