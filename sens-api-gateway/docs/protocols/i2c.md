# I²C (Inter-Integrated Circuit) — Wire Contract Reference

**Protocol role on this device:** I²C master on the Raspberry Pi / Revolution Pi host. `suderra-agent` exposes `I2cHandle` for direct register access plus higher-level drivers (Atlas EZO, BME280, SHT31, ADS1115, PCA9685).

RFC 2119 keywords apply.

## 1. Standard + version

- **NXP UM10204 I²C-bus specification**, Rev. 7.0 (2021-10-01). Successor to the original Philips Semiconductors specification (1982+).
- **SMBus 3.2** (System Management Interface Forum, 2018) — I²C variant with tighter electrical constraints and well-known function set (quick command, send/receive byte, read/write byte/word, block read/write, process call).
- Bit rates used by this agent:
  - **Standard-mode** 100 kHz — default (`src/i2c.rs:60`).
  - **Fast-mode** 400 kHz — configurable.
  - **Fast-mode+** 1 MHz, **High-speed** 3.4 MHz, **Ultra Fast-mode** 5 MHz — hardware-dependent, rarely used on a Raspberry Pi (BCM2835 Broadcom Serial Controller caps at Fast-mode reliably).

## 2. Crate + feature flag

- Crate: `rppal = "0.17"` on Linux targets only (`Cargo.toml:315`).
- Feature flag: `gpio = ["rppal"]` (`Cargo.toml:326`). `gpio` is ON in the default build (`Cargo.toml:325-326`); the I²C driver compiles alongside GPIO.
- Non-Linux targets: the I²C actor in `src/i2c.rs` compiles but falls through to error paths when rppal is unavailable.

## 3. Supported operations

| Operation | Status | Notes |
|-----------|--------|-------|
| Scan bus (7-bit address sweep 0x03-0x77) | PRESENT | `I2cCommand::Scan` (`src/i2c.rs:130-134`) |
| Probe single device | PRESENT | `I2cCommand::Probe` (`src/i2c.rs:136-139`) |
| Read from register (write address + register, repeated-start, read) | PRESENT | `ReadRegister` (`src/i2c.rs:105-110`) |
| Write to register (write address + register + data) | PRESENT | `WriteRegister` (`src/i2c.rs:112-117`) |
| Read direct (no register byte) | PRESENT | `ReadDirect` (`src/i2c.rs:119-123`) |
| Write direct (no register byte) | PRESENT | `WriteDirect` (`src/i2c.rs:125-129`) |
| Block read / block write (SMBus 3.2 §6.5.7-§6.5.8) | NOT-IMPLEMENTED — ROADMAP-Q3 | rppal exposes it; not yet wired into actor |
| Process call (SMBus 3.2 §6.5.10) | NOT-PURSUED | |
| 10-bit addressing (I²C spec §3.1.11) | NOT-IMPLEMENTED — ROADMAP | 7-bit address enforced (`src/i2c.rs:43`) |
| PEC (Packet Error Checking, SMBus §6.5) | NOT-IMPLEMENTED — ROADMAP | |

## 4. Wire format

I²C is a physical-layer protocol; there are no PDU / framing bytes to tabulate in the Modbus sense. The wire exchange is expressed at the START / ADDRESS / DATA / ACK / STOP level:

```
S   AddressW  A  Register  A  <repeated S>  AddressR  A  Data_0  A  Data_1  A  ...  Data_{n-1}  N  P
```

Symbols:

| Symbol | Meaning |
|--------|---------|
| `S` | START condition (SDA falling while SCL high) |
| `P` | STOP condition (SDA rising while SCL high) |
| `AddressW` | 7-bit address + R/W bit 0 (write) |
| `AddressR` | 7-bit address + R/W bit 1 (read) |
| `A` | ACK (slave pulls SDA low on 9th clock) |
| `N` | NACK (master leaves SDA high on the final byte) |
| `<repeated S>` | Repeated START — common for register read, delimits the address phase from the data phase |

**Clock stretching** — a slave MAY hold SCL low to delay the next byte; the BCM2835 I²C controller is `REV 4 HW BUG` (clock stretch is buggy on pre-Pi 4). Pi 4+ handles clock stretch correctly; if you target Pi 3 or earlier, see the well-known kernel parameter `i2c_arm_baudrate=50000` workaround. This is `HARDWARE-VENDOR RESPONSIBILITY` (Broadcom).

**Repeated START semantics** — `ReadRegister` issues write (register byte) + repeated-start + read; it is NOT a separate STOP/START pair, so another master on the bus (multi-master setup) cannot seize the bus between phases.

## 5. Error handling

- NACK on ADDRESS phase (no device present): surfaces as an `Err` in the read/write result.
- NACK mid-transfer: surfaces as an `Err`; transfer aborted.
- Clock-stretching hang: the Linux `i2c-dev` driver returns `EREMOTEIO` after the adapter timeout; rppal maps that to an error result.
- No circuit-breaker / rate-limiter is wired for I²C. Upstream drivers (Atlas EZO) implement their own retry + timing policies.

## 6. Authentication + encryption

- **None.** I²C is a short-distance board-level bus with no authentication, no integrity, no encryption. Every master on the bus can read/write every device.
- Defence-in-depth MUST be physical: enclosure access control, sealed connectors. `HARDWARE-VENDOR RESPONSIBILITY`.

## 7. Configuration schema

```yaml
i2c:
  devices:
    - name: ph_probe
      address: 0x63                    # 7-bit I2C address
      bus: 1                           # RPi I2C1 (GPIO 2 SDA / GPIO 3 SCL)
      clock_speed_hz: 100000           # 100000 | 400000 | ...
      description: "Atlas Scientific EZO pH"
    - name: temperature_humidity
      address: 0x44                    # SHT31
      bus: 1
      clock_speed_hz: 100000
```

See `src/i2c.rs:38-73`.

## 8. Worked example

Scan bus 1 for connected devices:

```
Scan on bus=1 returns: [0x44, 0x63, 0x76]
  0x44 = SHT31 temperature/humidity
  0x63 = Atlas Scientific EZO pH
  0x76 = BME280 temperature/humidity/pressure (SDO=GND)
```

Read 2 bytes from register `0x00` on device `0x44`:

```
Wire: S 88 A 00 A  rS  89 A  D0 A  D1 N  P
(88=0x44<<1|W, 89=0x44<<1|R, D0 D1 are the raw bytes)
```

## 9. Test coverage

- 4 `#[test]` blocks in `src/i2c.rs` cover: actor command routing, read-result helper, scan-result serialisation, default-config round-trip.
- HIL coverage against a BME280 and an Atlas Scientific EZO pH circuit is the standard bench acceptance.

## 10. Interop certification status

- **NXP I²C conformance** — not pursued; a Master-on-Linux-via-rppal does not distinguish itself here.
- **SMBus BIOS Interface certification** — not applicable (this is an embedded-Linux master, not a PC BIOS host).

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| 7-bit address | `src/i2c.rs:42-43` |
| Default bus 1, clock 100 kHz | `src/i2c.rs:55-61` |
| Actor commands scan/probe/R/W-register/R/W-direct | `src/i2c.rs:98-142` |
| rppal Linux-only | `Cargo.toml:315` |
| `gpio` feature pulls rppal | `Cargo.toml:326` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| I1 | Scan bus 1 with BME280 at 0x76 and SHT31 at 0x44 connected | Result contains `[0x44, 0x76]` |
| I2 | ReadRegister on 0x76, register 0xD0 (BME280 chip ID register) | Returns 1 byte = 0x60 |
| I3 | ReadRegister on an unconnected address 0x20 | NACK → `success=false`, `error` non-empty |
| I4 | WriteRegister on 0x44, register 0x30, data `[0xA2]` (SHT31 soft reset) | ACK; `success=true` |
| I5 | ReadDirect 32 bytes from 0x63 (Atlas EZO after `R` command) | 32 bytes; first byte is the EZO status code |
| I6 | Clock-stretch device on RPi 3 running at 100 kHz | Known BCM2835 erratum — may return EREMOTEIO; mitigation is `i2c_arm_baudrate=50000` at boot (host config, `HARDWARE-VENDOR RESPONSIBILITY`) |
| I7 | 10-bit address attempt (e.g. 0x3FF) | Not supported today; configuration rejects / truncates to 7-bit |
