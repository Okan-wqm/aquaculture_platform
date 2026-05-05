# SIMATIC IPC Deployment

**Scope:** Deploying `sens-api-gateway` onto Siemens SIMATIC IPC (Industrial PC) hardware and IOT2050 gateway hardware. This chapter is an overlay on top of the generic install runbook in `sens-api-gateway/docs/deployment/install.md`; it documents SIMATIC-specific deltas (TPM, watchdog, firmware image, connectivity).

---

## Siemens version compatibility matrix

| SIMATIC hardware | CPU arch | OS image | Agent build target | Status |
|---|---|---|---|---|
| SIMATIC IPC227G (Nanobox) | x86_64 (Atom x6413E / x6425E) | SIMATIC IPC DiagMonitor + Debian 11/12 | `x86_64-unknown-linux-gnu` | PRESENT — same install path as Revolution Pi |
| SIMATIC IPC427G (Microbox) | x86_64 (Core i3/i5/i7 11th gen) | Debian 12 | `x86_64-unknown-linux-gnu` | PRESENT |
| SIMATIC IPC477G (Panel PC) | x86_64 (Core i3/i5/i7 11th gen) | Debian 12 | `x86_64-unknown-linux-gnu` | PRESENT |
| SIMATIC IPC BX-39A | x86_64 | Debian 12 | `x86_64-unknown-linux-gnu` | PRESENT |
| SIMATIC IOT2050 Basic | ARM64 (TI AM6528) | IOT2050 Example Image V2.x (Debian-based) | `aarch64-unknown-linux-gnu` | PRESENT — tested on community image |
| SIMATIC IOT2050 Advanced | ARM64 (TI AM6548) | IOT2050 Example Image V2.x | `aarch64-unknown-linux-gnu` | PRESENT |
| SIMATIC IOT2040 (legacy) | x86 (Quark x1020) | Yocto (legacy) | NOT SUPPORTED — Rust 1.85 + edition 2024 exceed Quark toolchain | NOT-PLANNED |

Rust toolchain requirement: `rust-version = "1.85"` per `sens-api-gateway/Cargo.toml:5`. Any SIMATIC IPC image running a Rust toolchain older than 1.85 requires a toolchain update before agent install.

---

## Install runbook delta (SIMATIC IPC vs. generic install)

Follow `sens-api-gateway/docs/deployment/install.md` end-to-end, with these per-platform deltas.

### Delta 1 — TPM 2.0 detection

SIMATIC IPC227G / IPC427G / IPC477G / BX-39A ship with an onboard TPM 2.0 (Infineon SLB 9670 typical). IOT2050 does NOT have a TPM — key material sits in the eMMC-backed filesystem protected by LUKS.

| Model | TPM 2.0 | Gateway key storage strategy |
|---|---|---|
| IPC227G | YES | `/dev/tpmrm0` → tpm2-tools → tpm2-tss-engine for mTLS keys (roadmap — not wired in v1.6.0) |
| IPC427G | YES | Same as IPC227G |
| IPC477G | YES | Same as IPC227G |
| IPC BX-39A | YES | Same as IPC227G |
| IOT2050 Basic | NO | LUKS-encrypted `/var/lib/suderra/secrets/` on the eMMC partition |
| IOT2050 Advanced | NO | Same as Basic |

The TPM-backed key-store integration is tracked separately in `sens-api-gateway/docs/security/` and in ORPHAN-EDGE-011 (target Q4 2026). Today the agent uses filesystem-stored keys regardless of TPM availability.

### Delta 2 — Hardware watchdog

SIMATIC IPCs expose a hardware watchdog via `/dev/watchdog`. The gateway's systemd unit should enable `WatchdogSec=` to benefit.

Recommended systemd override (create with `systemctl edit suderra-agent`):

```ini
[Service]
WatchdogSec=30s
Restart=on-failure
RestartSec=5s
NotifyAccess=main
```

The agent emits `sd_notify(WATCHDOG=1)` (not yet implemented at v1.6.0 — tracked as ORPHAN-EDGE-014). Until it lands, systemd's `Restart=on-failure` still recovers from crashes, but liveness-based restart requires the sd_notify path.

### Delta 3 — Network identity and gateway-vs-device role

SIMATIC IPCs are typically placed on the control LAN (CPU/PLC side) OR the supervisory LAN. Decide the network role before provisioning:

| Network role | Consequence for agent config |
|---|---|
| Control LAN only | Agent reaches PLCs directly (S7comm, OPC UA); cloud egress blocked; MQTT must be local broker only |
| Supervisory LAN only | Agent reaches cloud; PLC data arrives via OPC UA from control-LAN-to-supervisory-LAN gateway |
| Dual-homed (two NICs) | Agent binds to specific NICs per protocol; requires explicit `bind_address` in YAML per subsystem |

### Delta 4 — Firmware image and package pinning

SIMATIC IPC DiagMonitor images are Debian-derived and ship additional Siemens diagnostic packages. Do not remove them; the gateway coexists.

Package install (Debian 12 on any SIMATIC IPC / IOT2050):

```bash
sudo apt-get install -y \
  ca-certificates \
  libssl3 \
  systemd \
  tpm2-tools \    # IPC only; harmless on IOT2050
  cryptsetup      # IOT2050 LUKS path
```

The agent itself is a single static binary; no runtime package dependencies beyond glibc and libssl.

### Delta 5 — IOT2050 specifics

The IOT2050 image has a read-only rootfs by default. Agent installation requires:

```bash
# Switch rootfs to read-write
sudo iot2050setup     # interactive menu → Filesystem → RW
# ... install agent ...
# Switch back to read-only
sudo iot2050setup     # interactive menu → Filesystem → RO
```

Log destination on IOT2050 must go to a persistent writeable partition (`/var/log/suderra/` on `/var` bind-mounted to an eMMC partition), otherwise structured logs are lost on reboot.

### Delta 6 — GPIO access

IOT2050 has a 60-pin IO connector with GPIO, UART, SPI, I2C. Access paths:

| Subsystem | Device node | Agent feature flag | Evidence |
|---|---|---|---|
| GPIO | `/dev/gpiochip*` | `gpio` feature (default) | agent config subsystem |
| UART | `/dev/ttyS*`, `/dev/ttyUSB*` | Modbus RTU via `ttyS*` | `src/modbus.rs` |
| I2C | `/dev/i2c-*` | `i2c` feature | `src/i2c.rs` |
| SPI | `/dev/spidev*` | `spi` feature | `src/spi.rs` |

SIMATIC IPC427G / 477G expose GPIO via PCI-attached expansion modules; the pinout is Siemens-proprietary. Consult the specific IPC datasheet before wiring.

### Delta 7 — SCADA display feature (IPC Panel PC)

IPC477G is a Panel PC with an integrated touchscreen. The agent supports a `scada-display` cargo feature that renders a process mimic on the panel:

```bash
cargo build --release --features scada-display
```

See `sens-api-gateway/docs/SCADA_EDGE_DEPLOY.md` (repo-root doc) for the display-specific setup. IPC227G / IPC427G without a panel run headless; do NOT enable `scada-display` on those.

---

## Provisioning flow for SIMATIC IPC

1. **Image prep:** Debian 12 is the target for all modern SIMATIC IPCs. IOT2050 uses the Siemens-published IOT2050 Example Image (V2.x).
2. **Network config:** assign static IP or DHCP reservation on the chosen LAN(s).
3. **Hostname + serial:** hostname should encode the SIMATIC serial label (e.g. `ipc227g-sn123456`).
4. **Onboarding bundle:** place `/etc/suderra/agent.yaml` and `/etc/suderra/pki/*.crt` per `sens-api-gateway/docs/deployment/install.md`.
5. **Start agent:** `systemctl enable --now suderra-agent`.
6. **Verify:** `journalctl -u suderra-agent -f` — expect `MQTT connected` within 30 seconds, `OPC UA session established` if OPC UA upstream is configured.

---

## Hardware watchdog + TPM status table

| Feature | IPC227G | IPC427G | IPC477G | IPC BX-39A | IOT2050 | Agent uses it today? |
|---|---|---|---|---|---|---|
| Hardware watchdog | YES | YES | YES | YES | YES | systemd `WatchdogSec=` works; agent `sd_notify` ROADMAP |
| TPM 2.0 | YES | YES | YES | YES | NO | NO — filesystem keys today; ROADMAP Q4 2026 |
| Secure boot | Optional (UEFI) | Optional (UEFI) | Optional (UEFI) | Optional (UEFI) | Siemens-signed image only | Depends on customer image; not enforced by agent |
| LUKS full-disk encryption | Customer-configured | Customer-configured | Customer-configured | Customer-configured | REQUIRED for IOT2050 key storage | Customer responsibility |

---

## Known gaps

| Gap | Finding ID | Target |
|---|---|---|
| Agent does not emit `sd_notify(WATCHDOG=1)` — systemd `WatchdogSec=` is best-effort | ORPHAN-EDGE-014 | Q3 2026 |
| TPM-backed key storage not wired; filesystem keys on all targets | ORPHAN-EDGE-011 | Q4 2026 |
| No Siemens-certified install bundle (`.deb` signed by Siemens) — customer installs manually | — | Not started |

---

## Cross-reference

- Generic install runbook: `sens-api-gateway/docs/deployment/install.md`
- SCADA display feature: `sens-api-gateway/docs/SCADA_EDGE_DEPLOY.md`
- Security architecture (TPM, LUKS): `sens-api-gateway/docs/security/`
- Cargo rust-version constraint: `sens-api-gateway/Cargo.toml:5`
