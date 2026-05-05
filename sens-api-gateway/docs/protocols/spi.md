# SPI (Serial Peripheral Interface) — Wire Contract Reference

**Status for this chapter: `CODE-COMPILED-NOT-WIRED` — ORPHAN-EDGE-014.**

The SPI actor in `src/spi.rs` is fully implemented but carries a file-level `#![allow(dead_code)]` (`src/spi.rs:23`) with the explanatory comment *"TODO: SPI actor fully implemented but not yet wired in main.rs init_hardware"* (`src/spi.rs:22`). It is NOT instantiated by the agent binary and therefore has no live wire traffic in the field. This chapter documents the binding wire contract that the code would honour once it is wired.

RFC 2119 keywords apply.

## 1. Standard + version

- **Motorola SPI Block Guide V03.06** (M68HC11 reference, 1997; de-facto SPI specification).
- **TI QSPI / ST SPI application notes** fill in vendor-specific edge cases (CS polarity, mode conventions).
- SPI is a de-jure non-standardised bus — conformance is established per-device against the peripheral datasheet.
- Maximum clock: hardware-dependent. Raspberry Pi BCM2835/BCM2711 SPI0 peripheral supports up to ~125 MHz in theory but is reliably run at 10-32 MHz for most ADCs.

## 2. Crate + feature flag

- Crate: `rppal = "0.17"` on Linux targets (`Cargo.toml:315`).
- Feature flag: `gpio = ["rppal"]` (`Cargo.toml:326`). SPI shares the rppal dependency with GPIO and I²C.
- File-level dead-code allowance: `#![allow(dead_code)]` (`src/spi.rs:23`).

## 3. Supported operations (when wired)

| Operation | Status | Anchor |
|-----------|--------|--------|
| Full-duplex transfer | CODE-COMPILED-NOT-WIRED | Actor command `Transfer` in `src/spi.rs` |
| Half-duplex read | CODE-COMPILED-NOT-WIRED | |
| Half-duplex write | CODE-COMPILED-NOT-WIRED | |
| Configurable clock speed, mode, bit order, bits-per-word | CODE-COMPILED-NOT-WIRED | `src/spi.rs:64-97` |
| Multi-chip-select per bus | CODE-COMPILED-NOT-WIRED | SPI0 CE0/CE1; SPI1 CE0/CE1/CE2 |

## 4. Wire format

### 4.1 SPI modes (CPOL / CPHA)

| Mode | CPOL | CPHA | Clock idle | Sample edge | Notes |
|------|------|------|------------|-------------|-------|
| Mode 0 (default) | 0 | 0 | Low | Rising | Most common for ADCs like MCP3008 |
| Mode 1 | 0 | 1 | Low | Falling | |
| Mode 2 | 1 | 0 | High | Falling | |
| Mode 3 | 1 | 1 | High | Rising | Common for Micron / W25Q flash |

See `src/spi.rs:40-51`.

### 4.2 Bit order

| Order | Meaning |
|-------|---------|
| `MsbFirst` (default) | Most-significant bit first — overwhelmingly dominant |
| `LsbFirst` | Some AVR-family hardware / custom-logic FPGAs |

See `src/spi.rs:54-61`.

### 4.3 Chip-select

- Active-low is the convention. rppal SPI asserts CS low for the transfer, high at end.
- Pi SPI peripherals drive CS automatically when the kernel SPI driver owns it. Manual GPIO-driven CS is feasible when the device is not on a native CE line; this path is NOT in the default actor API.

### 4.4 Per-byte layout

SPI transfers are transparent: the wire is a stream of `bits_per_word` bits (default 8). There is no framing, no address, no checksum at the bus level. Higher-level protocols (ADC conversion command, flash SPI-NAND opcodes) are carried inside the byte stream and are device-specific.

## 5. Error handling

- Linux `spidev` returns `EIO` on controller failure; rppal surfaces it as an error.
- No retry / rate-limit in the SPI actor — upstream device drivers would own that.
- `CODE-COMPILED-NOT-WIRED` status means the operator-visible contract today is "no SPI traffic". An explicit ROADMAP-Q3 item under `ORPHAN-EDGE-014` covers wiring + adding integration tests.

## 6. Authentication + encryption

- **None.** SPI is a board-level bus. Physical security is `HARDWARE-VENDOR RESPONSIBILITY`.

## 7. Configuration schema (reserved — not consumed today)

```yaml
spi:
  devices:
    - name: adc_ch0
      bus: 0                          # 0 | 1
      chip_select: 0                  # CE0, CE1 (CE2 on SPI1)
      clock_speed_hz: 1000000         # 1 MHz default
      mode: mode0                     # mode0 | mode1 | mode2 | mode3
      bit_order: msb_first            # msb_first | lsb_first
      bits_per_word: 8                # 8 | 16 (16 requires hardware support)
      description: "MCP3008 8-ch ADC"
```

When the actor is wired, the schema MUST appear under the top-level `spi:` key in `config.yaml`. Today the key is not consumed.

## 8. Worked example (reserved)

MCP3008 10-bit ADC — read channel 0, single-ended:

Wire (Mode 0, MSB first, 1 MHz):

```
MOSI: 0x01 0x80 0x00        (start=1, single-ended/ch0=1000 shifted, don't care)
MISO: 0x00 0x?? 0x??        (first byte undefined, last 2 bytes hold 10-bit result)
```

The MCP3008 answer shape is not SPI-bus business; it is a device property.

## 9. Test coverage

- 5 `#[test]` blocks in `src/spi.rs` exercise: mode / bit-order enum round-trip, default-config, actor command plumbing. No HIL vector — SPI is not wired.

## 10. Interop certification status

- Not applicable while status is `CODE-COMPILED-NOT-WIRED`.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| `#![allow(dead_code)]` | `src/spi.rs:23` |
| "not yet wired in main.rs init_hardware" | `src/spi.rs:22` |
| SPI mode enum | `src/spi.rs:40-51` |
| Bit-order enum | `src/spi.rs:54-61` |
| Configuration struct | `src/spi.rs:64-97` |
| ORPHAN-EDGE-014 status | `docs/reviews/orphan-findings.md` (tracked) |

## Interop test plan (pending wiring, ROADMAP-Q3)

| # | Input | Expected output |
|---|-------|-----------------|
| P1 | `init()` the SPI actor with an MCP3008 on SPI0 CE0 @ 1 MHz Mode 0 | Actor returns `Ok(())`; kernel opens `/dev/spidev0.0` |
| P2 | Transfer `[0x01, 0x80, 0x00]` | Response 3 bytes; byte[1] low 2 bits + byte[2] = 10-bit ADC reading |
| P3 | Configure Mode 3 against a W25Q flash at 10 MHz | ReadID returns `0xEF 0x40 0x18` (Winbond W25Q128) |
| P4 | Wrong CS line (CE1 when device is on CE0) | No ACK from device; result bytes are `0xFF` — upstream driver MUST detect absence |
| P5 | Hot-unplug test | `spidev` returns `EIO`; actor surfaces the error |
