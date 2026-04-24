# PWM (Pulse Width Modulation) — Wire Contract Reference

**Status for this chapter: `CODE-COMPILED-NOT-WIRED` — ORPHAN-EDGE-014.**

The PWM actor in `src/pwm.rs` is fully implemented but carries a file-level `#![allow(dead_code)]` (`src/pwm.rs:21`) with the explanatory comment *"TODO: PWM actor fully implemented but not yet wired in main.rs init_hardware"* (`src/pwm.rs:20`). It is NOT instantiated by the agent binary today. This chapter is the normative reference for the signal the code WILL emit once wired.

RFC 2119 keywords apply.

## 1. Standard + version

- PWM is not a communications protocol with a single specification body; it is a signal-modulation scheme defined by its frequency, duty cycle, and polarity. Relevant norms:
  - **Broadcom BCM2835 / BCM2711 / BCM2712 ARM Peripherals** datasheets, §9 PWM.
  - **RC Servo convention** — 50 Hz carrier, pulse width 1.0 ms (full CCW) / 1.5 ms (centre) / 2.0 ms (full CW). The agent exposes a `servo_mode: true` helper that pins frequency to 50 Hz (`src/pwm.rs:54`).

## 2. Crate + feature flag

- Crate: `rppal = "0.17"` on Linux (`Cargo.toml:315`).
- Feature flag: `gpio = ["rppal"]` (`Cargo.toml:326`).
- File-level dead-code allowance: `#![allow(dead_code)]` (`src/pwm.rs:21`).

## 3. Supported operations (when wired)

| Operation | Status | Notes |
|-----------|--------|-------|
| Hardware PWM on PWM0 (GPIO 12 / GPIO 18) | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:7-8` |
| Hardware PWM on PWM1 (GPIO 13 / GPIO 19) | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:7-9` |
| Software PWM on any GPIO | CODE-COMPILED-NOT-WIRED | Reduced precision per `src/pwm.rs:12` |
| Frequency configurable per channel | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:44-47` |
| Duty-cycle configurable 0.0-1.0 | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:48-49` |
| Servo-mode helper (50 Hz, 1-2 ms pulse) | CODE-COMPILED-NOT-WIRED | `src/pwm.rs:53-55` |

## 4. Wire format

PWM is a single-wire signal; there is no packet.

### 4.1 Signal parameters

- **Frequency** (Hz): period `T = 1 / f`. Typical ranges:
  - Motor control: 1-25 kHz.
  - LED dimming: 200 Hz - 2 kHz (avoid flicker).
  - Servo: 50 Hz (fixed).
- **Duty cycle** (0.0 - 1.0): fraction of the period the signal is HIGH (active-high assumed).
- **Resolution**: hardware PWM on the Pi is driven by the 500 MHz PWM clock; duty cycle resolution is implementation-defined (typically 10-16 bits). Software PWM resolution degrades with load and with scheduler jitter.
- **Polarity**: active-high by default. Active-low requires an external inverter or a GPIO-level invert at the SoC peripheral.

### 4.2 Hardware vs software PWM

| Aspect | Hardware PWM | Software PWM |
|--------|--------------|--------------|
| Jitter | Sub-microsecond | Milliseconds (scheduler-dependent) |
| Max practical frequency | > 100 kHz | ~1-5 kHz |
| CPU cost | Near zero | Continuous timer interrupts |
| Channels on RPi | 2 (PWM0, PWM1) | Any free GPIO |
| Recommended for | Motor VFD, precise LED dimming, audio | Status LEDs, slow fans |

Configuration exposes `hardware: bool` (`src/pwm.rs:50-53`); `true` requires one of PWM0/PWM1 pins.

### 4.3 Servo mode

When `servo_mode: true` is set, the actor:
- pins frequency to 50 Hz;
- interprets `duty_cycle` as a normalised 0.0-1.0 value mapped into pulse widths `1.0 ms - 2.0 ms` (linear). `duty_cycle = 0.5` ⇒ 1.5 ms ⇒ servo centre.

## 5. Error handling

- Requesting hardware PWM on a non-PWM-capable GPIO MUST surface as an error.
- Frequency outside the hardware-supported range on software PWM MUST be rejected at configuration-validation time. Today this is a gap — `ORPHAN-EDGE-014` includes the validation rule.
- No retry policy — PWM is a continuous signal, not a transaction.

## 6. Authentication + encryption

- **None.** PWM is a physical signal with no content to authenticate or encrypt. Physical-layer tamper-resistance is the deployment's concern (`HARDWARE-VENDOR RESPONSIBILITY`).

## 7. Configuration schema (reserved — not consumed today)

```yaml
pwm:
  channels:
    - name: vfd_setpoint
      pin: 18                        # GPIO 18 = PWM0 (Alt5)
      frequency_hz: 10000            # 10 kHz for VFD analog reference
      initial_duty_cycle: 0.0
      hardware: true
      servo_mode: false
    - name: door_servo
      pin: 13                        # GPIO 13 = PWM1 (Alt0)
      frequency_hz: 50               # pinned by servo_mode
      initial_duty_cycle: 0.5        # 1.5 ms = centre
      hardware: true
      servo_mode: true
```

See `src/pwm.rs:38-88`.

## 8. Worked example (reserved)

Set `vfd_setpoint` from 0.0 → 0.5 → 1.0 linearly over 10 s:

```
t=0s    duty = 0.00  (0 % HIGH)
t=5s    duty = 0.50  (50 % HIGH, i.e. 50 µs HIGH per 100 µs period @ 10 kHz)
t=10s   duty = 1.00  (100 % HIGH — a DC high, not a PWM)
```

## 9. Test coverage

- 4 `#[test]` blocks in `src/pwm.rs` cover: config default, actor command plumbing, servo-mode duty conversion, enable/disable state transitions. No HIL vector — PWM is not wired.

## 10. Interop certification status

- Not applicable while status is `CODE-COMPILED-NOT-WIRED`.

## 11. Evidence

| Claim | Anchor |
|-------|--------|
| `#![allow(dead_code)]` | `src/pwm.rs:21` |
| "not yet wired in main.rs init_hardware" | `src/pwm.rs:20` |
| PWM0 / PWM1 pins | `src/pwm.rs:7-9` |
| Configuration struct | `src/pwm.rs:38-56` |
| Servo-mode helper | `src/pwm.rs:53-55` |
| ORPHAN-EDGE-014 status | `docs/reviews/orphan-findings.md` (tracked) |

## Interop test plan (pending wiring, ROADMAP-Q3)

| # | Input | Expected output |
|---|-------|-----------------|
| W1 | Hardware PWM on GPIO 18 @ 10 kHz, duty 0.5 | Scope capture: 50 % HIGH time, 100 µs period, jitter < 1 µs |
| W2 | Software PWM on GPIO 22 @ 1 kHz, duty 0.25 | Scope capture: 25 % HIGH on average; jitter may exceed 100 µs under load |
| W3 | Servo mode on GPIO 13, duty 0.0 → 1.0 over 5 s | Pulse width ramps from 1.0 ms to 2.0 ms at 50 Hz |
| W4 | Duty > 1.0 | Rejected at configuration time |
| W5 | Hardware PWM requested on GPIO 17 (non-PWM pin) | Rejected with explicit error |
