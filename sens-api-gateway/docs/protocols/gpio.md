# GPIO (General-Purpose Input/Output) — Wire Contract Reference

**Protocol role on this device:** host digital I/O. `suderra-agent` reads input pins (dry-contact sensors, door switches, float switches) and drives output pins (relays, optocouplers) on the Raspberry Pi / Revolution Pi.

RFC 2119 keywords apply.

## 1. Standard + version

- **Broadcom BCM2835 / BCM2711 / BCM2712 ARM Peripherals** datasheet, §6 General-Purpose I/O (GPIO). Raspberry Pi 4 = BCM2711; CM4 = BCM2711; Pi 5 = BCM2712.
- **Linux GPIO character device ABI V2** (`/dev/gpiochipN`, `GPIO_V2_GET_LINE_IOCTL`). rppal uses the character device ABI where available, falling back to direct `/dev/mem` peripheral mapping on older kernels.
- Pin numbering convention used in this agent: **BCM numbering** (the SoC peripheral number, not the 40-pin header position). Rationale: rppal defaults to BCM; YAML `pin:` is a BCM number.

## 2. Crate + feature flag

- Crate: `rppal = "0.17"` on Linux targets only (`Cargo.toml:315`).
- Feature flag: `gpio = ["rppal"]` (`Cargo.toml:326`). Enabled in the default build (`Cargo.toml:325-326`).
- Non-Linux targets: `src/gpio.rs` compiles (it has no platform-specific surface beyond the rppal-gated methods). `is_available` returns `false` outside Linux.

## 3. Supported operations

| Operation | Status | Anchor |
|-----------|--------|--------|
| Init (reserve BCM pin lines) | PRESENT | `GpioCommand::Init` (`src/gpio.rs:85-88`) |
| Read all configured input pins in a single tick | PRESENT | `GpioCommand::ReadAll` (`src/gpio.rs:89-92`) |
| Read a single pin | PRESENT | `GpioCommand::ReadPin` (`src/gpio.rs:93-97`) |
| Write to an output pin | PRESENT | `GpioCommand::WritePin` (`src/gpio.rs:98-103`) |
| Pull-up / pull-down / none on inputs | PRESENT | `GpioConfig.pull`, `src/config.rs:1127-1129` |
| Invert value | PRESENT | `GpioConfig.invert`, `src/config.rs:1131-1133` |
| Debounce | PRESENT | `GpioConfig.debounce_ms`, `src/config.rs:1135-1136` |
| Interrupt-driven edge detection | PRESENT via rppal (not exposed at this actor layer today) | ROADMAP-Q3 for a push-based event API |
| Hot-reconfigure (YAML reload without restart) | PRESENT | `GpioCommand::Reconfigure` (`src/gpio.rs:108-113`) |
| Pin count introspection | PRESENT | `GpioCommand::GetPinCount` (`src/gpio.rs:104-105`) |

## 4. Wire format

GPIO is a digital-level interface; there is no packet. The observable contract is the **voltage level** on each pin:

| State | Voltage on Pi 4 / Pi 5 (3.3 V logic) |
|-------|---------------------------------------|
| `PinState::High` | ≥ 2.0 V (Schmitt-trigger threshold is device-dependent) |
| `PinState::Low` | ≤ 0.8 V |
| Floating (no pull, no drive) | Indeterminate — MUST NOT be relied on for an input without `pull` |

### 4.1 Pull-up / pull-down

- `pull: up` configures the internal ~50 kΩ pull-up → an unconnected input reads `High`.
- `pull: down` configures the internal ~50 kΩ pull-down → an unconnected input reads `Low`.
- `pull: none` leaves the pin floating — operator MUST provide an external pull resistor.

### 4.2 Invert

`invert: true` flips the logical `PinState` before the value enters the process image. The underlying BCM pin level is unchanged; this is purely an application-layer transform. It is used to normalise active-low dry contacts (e.g. an emergency-stop button that pulls the line to GND when pressed).

### 4.3 Debounce

`debounce_ms` specifies the minimum time a mechanical contact MUST hold its new level before the value is considered stable. Mechanical switches (relays, push-buttons) typically bounce 5-20 ms; a default `debounce_ms: 50` covers the common cases. The debounce is implemented in software by the reader — not at the SoC peripheral level.

## 5. Error handling

- Channel-send retry: 3 retries at 10 ms exponential (`src/gpio.rs:31-35`).
- Actor-send backpressure: default queue 64, minimum 16 (`src/gpio.rs:29`, `src/gpio.rs:146`).
- Operation timeout: configurable per-handle (`src/gpio.rs:119-120`), default 5 s.
- GPIO unavailable (non-Linux / missing peripheral / permission denied): `is_available()` returns `false`; calls surface as `Err`.

## 6. Authentication + encryption

- **None.** Physical pins carry no cryptographic identity. Access control is physical enclosure + restricted boot flow (see `security/secure-boot.md`). `HARDWARE-VENDOR RESPONSIBILITY` covers enclosure tamper-evident seals.

## 7. Configuration schema

```yaml
gpio:
  pins:
    - name: emergency_stop
      pin: 17                     # BCM 17
      direction: input
      pull: up                    # up | down | none
      invert: true                # E-stop is normally-closed → pulled low when pressed; invert so we report logical HIGH
      debounce_ms: 50
    - name: pump_relay
      pin: 23                     # BCM 23
      direction: output
```

See `src/config.rs:1117-1137`.

## 8. Worked example

Operator closes an emergency-stop button wired between BCM 17 and GND, while BCM 17 is configured `pull: up, invert: true`:

| Physical state | BCM 17 level | `PinState` after invert | Reported value |
|----------------|--------------|-------------------------|----------------|
| E-stop NOT pressed | `High` (internal pull-up) | `Low` | dry-contact closed = false ⇒ system runs |
| E-stop pressed | `Low` (contact to GND) | `High` | dry-contact open = true ⇒ system must safe-state |

The state change propagates through `ReadAll` on the next poll. Debounce ensures a 30-ms bounce does not emit two flips.

## 9. Test coverage

- 4 `#[test]` blocks in `src/gpio.rs` cover: `PinState::from`/`Into<bool>` symmetry, actor-handle construction, channel-size minimum clamp. HIL acceptance: a loopback harness connecting an output pin to an input pin and checking that `WritePin(High)` → `ReadPin = High`.

## 10. Interop certification status

- Not applicable — GPIO is a device-local physical interface.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| rppal Linux-only | `Cargo.toml:315` |
| `gpio` feature enables rppal | `Cargo.toml:326` |
| BCM numbering is the YAML convention | `src/gpio.rs:1-6` |
| Channel retry / backpressure | `src/gpio.rs:29-35` |
| Actor commands set | `src/gpio.rs:84-113` |
| PinState High / Low round-trip with bool | `src/gpio.rs:42-59` |
| `pull`, `invert`, `debounce_ms` fields | `src/config.rs:1127-1136` |

## Interop test plan

| # | Input | Expected output |
|---|-------|-----------------|
| G1 | Init with one input pin `BCM 17, pull=up, invert=false`, no external connection | `ReadPin(17)` returns `High` |
| G2 | Short BCM 17 to GND | `ReadPin(17)` returns `Low` within 50 ms |
| G3 | Same setup with `invert=true` | Shorted to GND reports `High` (logical) |
| G4 | Init output pin `BCM 23`, `WritePin(23, High)` with oscilloscope probe | Pin level 3.3 V |
| G5 | Bounce: toggle the input 10 times in 20 ms with `debounce_ms: 50` | Reader observes one stable transition |
| G6 | Hot-reconfigure to add a new pin without restart | Subsequent `ReadAll` includes the new pin |
| G7 | GPIO not available (no kernel `gpiochip0`) | `is_available()` returns `false`; subsequent calls surface `Err` |
