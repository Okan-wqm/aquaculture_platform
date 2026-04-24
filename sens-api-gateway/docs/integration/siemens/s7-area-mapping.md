# S7 Area Mapping Reference

**Scope:** Which Siemens S7 memory areas the gateway can read and write; which addressing syntaxes are accepted; PDU (Protocol Data Unit) negotiation; PLC-family-specific constraints.

All entries below are anchored to actual code in `src/plc_programming/s7comm.rs`. Any row that says "NOT SUPPORTED" means the code does not implement it today.

---

## Siemens version compatibility matrix

| S7 PLC family | Access supported | Notes | Evidence |
|---|---|---|---|
| S7-200 | Not fully supported — declared in type enum but connection parameters not validated for 200-family | Status label: NOT-TESTED | `s7comm.rs:223` |
| S7-300 | PRESENT — read/write all supported areas | Default slot 1 | `s7comm.rs:225-227` |
| S7-400 | PRESENT — read/write all supported areas | Same as S7-300 | `s7comm.rs:228` |
| S7-1200 | PRESENT — requires "Permit access with PUT/GET" in TIA Portal | TSAP connection type 0x02 | `s7comm.rs:230-231`, `:531-536` |
| S7-1500 | PRESENT — requires PUT/GET permit; full S7comm+ extension not implemented | TSAP connection type 0x02 | `s7comm.rs:232-233`, module doc `:9` |
| LOGO! | Declared but limited support — no firmware-level testing | Status label: NOT-TESTED | `s7comm.rs:234-235` |

---

## S7 memory area support matrix

Area codes below match the S7comm wire protocol. Address parser is at `s7comm.rs:332-467`; read/write dispatch at `:1401` (`read_variable`) and `:1452` (`write_variable`).

| Area | Wire code | Gateway constant | Read | Write | Accepted address syntax | Evidence |
|---|---|---|---|---|---|---|
| Process inputs (PE / I / E) | `0x81` | `S7_AREA_PE` | YES | YES | `IB<n>`, `IW<n>`, `ID<n>`, `I<byte>.<bit>`, `EB<n>`, `EW<n>`, `ED<n>`, `E<byte>.<bit>` | `s7comm.rs:84`, parser `:361-362`, `:427-466` |
| Process outputs (PA / Q / A) | `0x82` | `S7_AREA_PA` | YES | YES | `QB<n>`, `QW<n>`, `QD<n>`, `Q<byte>.<bit>`, `AB<n>`, `AW<n>`, `AD<n>`, `A<byte>.<bit>` | `s7comm.rs:85`, parser `:363-364`, `:427-466` |
| Merker / bit memory (MK / M) | `0x83` | `S7_AREA_MK` | YES | YES | `MB<n>`, `MW<n>`, `MD<n>`, `M<byte>.<bit>` | `s7comm.rs:86`, parser `:359-360`, `:427-466` |
| Data Block (DB) | `0x84` | `S7_AREA_DB` | YES | YES | `DB<n>.DBX<byte>.<bit>`, `DB<n>.DBB<byte>`, `DB<n>.DBW<byte>`, `DB<n>.DBD<byte>` | `s7comm.rs:87`, parser `:372-425` |
| Timer (T) | `0x1D` | `S7_AREA_TM` | YES — as word | YES — as word | `T<n>` | `s7comm.rs:89`, parser `:340-347` |
| Counter (C) | `0x1C` | `S7_AREA_CT` | YES — as word | YES — as word | `C<n>` | `s7comm.rs:88`, parser `:349-356` |
| Instance DB (DI) | — | — | NOT SUPPORTED — parser treats `DI<n>.DIW<n>` as unknown | NOT SUPPORTED | — | parser `:336`: only `DB` prefix recognised |
| Peripheral I/O (PI / PQ direct) | — | — | NOT SUPPORTED | NOT SUPPORTED | — | no constant declared |
| System data block (SDB 0x42) | `0x42` via `S7BlockType::SDB` | `S7BlockType::SDB` | Block upload only — not variable-read | Block download only | — | `s7comm.rs:266` |
| Local data (L) | — | — | NOT SUPPORTED | NOT SUPPORTED | — | no constant declared |

**Rule:** every row labelled NOT SUPPORTED means the parser will return `Err("Unknown S7 address area")` or `Err("Invalid DB field format")` today (`s7comm.rs:366`, `:379`). No silent fallback exists.

---

## S7 transport size matrix

Transport size bytes carried in the S7 `ReadVar` / `WriteVar` request parameter item.

| Transport size | Gateway constant | Wire code | Byte length | Evidence |
|---|---|---|---|---|
| BIT | `S7_TS_BIT` | `0x01` | 1 bit (returned as 1 byte with LSB relevant) | `s7comm.rs:92` |
| BYTE | `S7_TS_BYTE` | `0x02` | 1 | `s7comm.rs:93` |
| WORD | `S7_TS_WORD` | `0x04` | 2 | `s7comm.rs:94` |
| INT | `S7_TS_INT` | `0x05` | 2 (signed 16-bit) | `s7comm.rs:95` |
| DWORD | `S7_TS_DWORD` | `0x06` | 4 | `s7comm.rs:96` |
| DINT | `S7_TS_DINT` | `0x07` | 4 (signed 32-bit) | `s7comm.rs:97` |
| REAL | `S7_TS_REAL` | `0x08` | 4 (IEEE 754 single) | `s7comm.rs:98` |

Data transport sizes in responses (different enum):

| Response transport size | Gateway constant | Wire code | Interpretation |
|---|---|---|---|
| BIT | `S7_TS_DATA_BIT` | `0x03` | Length field is in BITS | `s7comm.rs:101` |
| BYTE / WORD / DWORD | `S7_TS_DATA_BYTE_WORD_DWORD` | `0x04` | Length field is in BITS (×8) | `s7comm.rs:102` |
| REAL | `S7_TS_DATA_REAL` | `0x08` | Length field is in BYTES | `s7comm.rs:103` |

---

## PDU (Protocol Data Unit) negotiation

Per S7comm Setup Communication exchange, client requests a PDU size; server returns the one it will honour. The gateway requests per `S7Config.pdu_size` and stores the negotiated value in `negotiated_pdu` (`s7comm.rs:479`).

| PDU size (bytes) | Supported by gateway request | Typical PLC response |
|---|---|---|
| 240 | YES | S7-300, S7-400 classic |
| 480 | YES — **default** | S7-300/400, S7-1200 |
| 960 | YES | S7-1500, S7-1200 with extended firmware |

Evidence: default value `default_pdu_size() -> 480` at `s7comm.rs:216-218`. Max transfer per packet and chunking honour the negotiated PDU (`s7comm.rs:773-790`).

**Rule for large block transfers:** if application data exceeds the negotiated PDU, the gateway chunks the transfer; see `s7comm.rs:781`. A negotiated PDU smaller than 240 bytes returns a hard error: `"Negotiated PDU too small for data transfer"` (`s7comm.rs:790`).

---

## Address parser examples (verified from test suite)

The following examples are taken from `s7comm.rs:1504-1571` (the `#[cfg(test)]` mod `tests` block):

| Input string | Parsed area | DB number | Byte offset | Bit offset | Transport size |
|---|---|---|---|---|---|
| `DB1.DBW0` | DB (0x84) | 1 | 0 | 0 | WORD |
| `DB1.DBX0.3` | DB (0x84) | 1 | 0 | 3 | BIT |
| `MW100` | MK (0x83) | 0 | 100 | 0 | WORD |
| `M10.3` | MK (0x83) | 0 | 10 | 3 | BIT |
| `IB0` / `EB0` | PE (0x81) | 0 | 0 | 0 | BYTE |
| `QB0` / `AB0` | PA (0x82) | 0 | 0 | 0 | BYTE |
| `T5` | TM (0x1D) | 0 | 5 | 0 | WORD |
| `C10` | CT (0x1C) | 0 | 10 | 0 | WORD |

---

## Block upload / download — partial support

The gateway implements the S7 block transfer subprotocol functions `S7_FUNC_START_UPLOAD` (0x1D), `S7_FUNC_UPLOAD` (0x1E), `S7_FUNC_END_UPLOAD` (0x1F), `S7_FUNC_START_DOWNLOAD` (0x1A), `S7_FUNC_DOWNLOAD` (0x1B), `S7_FUNC_END_DOWNLOAD` (0x1C) — `s7comm.rs:74-79`.

However:

- **`compile_to_mc7()` is a placeholder** — `s7comm.rs:862-901`. It emits a block skeleton (two-byte "PP" signature, version, block type, number, and a NOP + block-end payload). A real ST-to-MC7 compiler is not implemented per `s7comm.rs:897`. The logger emits a `warn!` at compile time stating "MC7 compilation is simplified - full ST compilation requires TIA Portal Openness".
- **Block download into a running PLC therefore transfers a skeleton, not a compiled program.** Operators must NOT use this path in production. Full compilation is tracked as ORPHAN-EDGE-007, target Q4 2026.

---

## Error surface

S7 errors returned by the PLC are parsed to a human-readable message at `s7comm.rs:110-164`. Classes covered: `0x00` (no error), `0x81` (application relationship), `0x82` (object definition), `0x83` (no resources), `0x84` (service processing), `0x85` (supplies), `0x87` (access), `0xD2` (OVS), `0xD4` (diagnostic), `0xD6` (protection), `0xDC`/`0xDD`/`0xDE` (block download / upload / delete), `0xDF` (password).

Representative code-level errors: `(0x84, 0x01)` → "PDU size error"; `(0x87, 0x02)` → "Write access not allowed"; `(0xD6, 0x02)` → "Insufficient privileges". These surface verbatim in the gateway's error chain and are logged structured.

---

## Cross-reference

- TIA Portal integration paths: `tia-portal.md`
- Wire-level S7comm protocol: `sens-api-gateway/docs/protocols/s7comm.md`
- Known gaps / roadmap: `tia-portal.md#known-gaps-with-finding-ids`
