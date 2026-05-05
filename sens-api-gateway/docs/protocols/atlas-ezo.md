# Atlas Scientific EZO — Wire Contract Reference

**Protocol role on this device:** application-layer driver on top of I²C. `suderra-agent` interrogates Atlas Scientific EZO circuits (pH, Dissolved Oxygen, Electrical Conductivity, ORP, RTD temperature) for aquaculture / hydroponics water-quality sensing.

RFC 2119 keywords apply.

## 1. Standard + version

- Vendor: **Atlas Scientific LLC** (Long Island City, NY).
- Reference documents: product-line datasheets (all public):
  - **EZO™-pH circuit**, datasheet Rev 4.0+.
  - **EZO™-DO (Dissolved Oxygen)** datasheet.
  - **EZO™-EC (Electrical Conductivity)** datasheet.
  - **EZO™-ORP** datasheet.
  - **EZO™-RTD** datasheet.
- The transport is standard I²C in 100 kHz mode (see `i2c.md`). The EZO circuits ship with a UART mode option that is NOT used here.

## 2. Crate + feature flag

- No dedicated crate — driver is hand-rolled at `src/atlas_ezo.rs` (159 LoC).
- Uses `src/i2c.rs` `I2cHandle` as transport.
- Feature flag: inherits `gpio = ["rppal"]` because I²C support ships with the `gpio` feature on Linux targets (`Cargo.toml:315, 326`).

## 3. Supported operations

| Command | Status | Anchor |
|---------|--------|--------|
| `R` — trigger a reading | PRESENT | `src/atlas_ezo.rs:29-62` |
| Calibration commands (e.g. `Cal,mid,7.00`, `Cal,low,4.00`, `Cal,high,10.00`, `Cal,clear`) | PRESENT | `src/atlas_ezo.rs:121-158` |
| Any other EZO command (e.g. `T,<temp>` temperature compensation, `I` device info, `Status`, `Sleep`, `Factory`) | NOT-WIRED at the driver layer — ROADMAP-Q3 | Raw write / read is available via `I2cHandle::write_direct` + `read_direct`, which is how the driver is implemented. Operators MAY compose their own commands today, with the caveat that timing delays are driver-specific. |

### 3.1 EZO sub-type delay

`AtlasEzoType::read_delay_ms` (`src/process_image.rs`) encodes the spec-required wait between `R` and the subsequent read:

| EZO type | Delay |
|----------|-------|
| pH | 900 ms |
| DO | 600 ms |
| EC | 600 ms |
| ORP | 900 ms |
| RTD | 600 ms |

Calibration is hard-coded to 1600 ms (`src/atlas_ezo.rs:131`) which exceeds the worst-case processing time across the EZO family (datasheet max ~1300 ms).

## 4. Wire format

### 4.1 Trigger + wait + read pattern

```
1. Master I2C Write:  [ 'R' ]                            → EZO begins measurement
2. Master sleeps:     delay_ms(per sensor type)          → EZO is NACK / clock-stretching during this window
3. Master I2C Read:   32 bytes                            → EZO returns status + ASCII string
```

### 4.2 Response frame (32 bytes)

| Byte | Meaning |
|------|---------|
| `data[0]` | Status code (`src/atlas_ezo.rs:69-107`) |
| `data[1..32]` | Null-terminated ASCII float string. Padding bytes after the null MAY be any value; the driver stops reading at the first `0x00`. |

### 4.3 Status codes

| Status | Meaning | Driver action (`src/atlas_ezo.rs:75-117`) |
|--------|---------|-------------------------------------------|
| `1` | Success | Parse ASCII float; emit `TagQuality::Good` |
| `2` | Syntax error | Emit `TagQuality::Bad`; WARN log |
| `254` | Still pending (not ready) | Emit `TagQuality::Uncertain`; DEBUG log |
| `255` | No data | Emit `TagQuality::Bad`; WARN log |
| anything else | Unknown | Emit `TagQuality::Bad`; WARN log |

## 5. Error handling

- Any I²C NACK on the `R` write → `TagQuality::CommFailure`.
- Empty response buffer → `TagQuality::CommFailure`.
- Non-UTF-8 or non-numeric payload on status = 1 → `TagQuality::Bad` with the offending string in the WARN log.
- Calibration failure surfaces as `anyhow::Error` with the status code in the message.

## 6. Authentication + encryption

- **None.** EZO is an I²C slave; see `i2c.md` § 6.

## 7. Configuration schema

Defined indirectly through the I²C device list + a `process_image` tag assignment:

```yaml
i2c:
  devices:
    - name: ph_probe
      address: 0x63
      bus: 1
      clock_speed_hz: 100000
      description: "Atlas EZO pH"

# process_image entry — tag bound to an EZO device
process_image:
  tags:
    - name: pond1_ph
      source:
        type: atlas_ezo
        device: ph_probe
        ezo_type: ph                # ph | do | ec | orp | rtd
      poll_interval_ms: 5000
```

The EZO I²C address is per-sensor-default: pH `0x63`, DO `0x61`, EC `0x64`, ORP `0x62`, RTD `0x66` (change via the EZO's own `I2C,<addr>` command on a one-off basis, vendor procedure).

## 8. Worked example

Read pH from EZO-pH at `0x63`:

```
t=0 ms   Write  [ 0x52 ]                         — 'R' command
t=900ms  Read   32 bytes                         — first byte = 0x01 (success)
          Example payload:
          01 37 2E 32 35 00 .. (padding)         — status=1, "7.25\0"
Decoded: value = 7.25  quality = Good
```

Calibration of the mid-point at pH 7.00:

```
Write "Cal,mid,7.00"                             — 12 bytes
Sleep 1600 ms
Read 32 bytes                                     — status must be 0x01 for the response string
```

## 9. Test coverage

- No `#[test]` blocks in `src/atlas_ezo.rs` directly (0 tests at the file level). Coverage is end-to-end through the process-image layer.
- HIL against Atlas Scientific EZO pH, DO, EC, ORP, RTD is the RECOMMENDED acceptance path; the bench vectors in § "Interop test plan" are the minimum acceptance set.

## 10. Interop certification status

- Atlas Scientific does not operate a formal certification programme; interoperability is proven by bench verification against the datasheet.
- The Suderra edge agent ships with water-quality calibration runbooks under `operations/water-quality-calibration.md` (owned by `operations-sla-writer`).

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| `R` command + 32-byte read shape | `src/atlas_ezo.rs:29-62` |
| Per-sensor delay via `AtlasEzoType::read_delay_ms` | `src/atlas_ezo.rs:42` |
| Status codes 1 / 2 / 254 / 255 | `src/atlas_ezo.rs:69-117` |
| Calibration delay 1600 ms | `src/atlas_ezo.rs:131` |
| Runs on `I2cHandle` | `src/atlas_ezo.rs:9, 35, 46` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| Z1 | EZO-pH at 0x63, water at pH 7.0 (freshly calibrated mid) | Status byte `0x01`, ASCII "7.00" or "7.01"; `TagQuality::Good` |
| Z2 | EZO-pH, read before the 900 ms delay expires | Status `0xFE` (254); `TagQuality::Uncertain` |
| Z3 | Disconnect probe BNC cable | Reading hits ±0 with unstable ASCII; NACK on subsequent Write surfaces `CommFailure` |
| Z4 | Send `Cal,mid,7.00` on a new EZO-pH | Status `0x01`, empty string → driver returns `Ok("")` |
| Z5 | Send `Cal,mid,7.00` on a miscalibrated probe (reading stuck at 3.5) | Status `0xFF` (255) or `0x02` (syntax); driver returns `Err` with the status |
| Z6 | EZO-DO at 0x61 in air-saturated water (~8.3 mg/L) | Status `0x01`, "8.3x"; `TagQuality::Good` |
| Z7 | EZO-EC at 0x64, device not present (wrong bus wiring) | I²C NACK on Write; `TagQuality::CommFailure` |
| Z8 | Two back-to-back `R` commands within 500 ms | Second read returns `0xFE` pending; upstream poller MUST respect `read_delay_ms` |
