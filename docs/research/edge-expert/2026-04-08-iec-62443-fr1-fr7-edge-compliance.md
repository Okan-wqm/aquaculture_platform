# Research: IEC 62443 FR 1–7 Edge Compliance Mapping

**Topic:** Foundational Requirements 1–7 mapped to the edge agent — device identity, RBAC, system integrity, data confidentiality, restricted data flow, timely response, resource availability, firmware verification, secure boot, anomaly detection
**Date:** 2026-04-08
**Agent:** edge-expert

## Sources

- [ISA — ISA/IEC 62443 Series of Standards](https://www.isa.org/standards-and-publications/isa-standards/isa-iec-62443-series-of-standards)
- [ISA Global Cybersecurity Alliance — Quick Start Guide (PDF)](https://gca.isa.org/hubfs/ISAGCA%20Quick%20Start%20Guide%20FINAL.pdf)
- [ISA GCA blog — Structuring the ISA/IEC 62443 Standards](https://gca.isa.org/blog/structuring-the-isa-iec-62443-standards)
- [ISASecure — The Case for SL2 as a Minimum (PDF)](https://www.isasecure.org/hubfs/The-Case-for-ISA-IEC-62443-Security-Level-2-as-a-Minimum-FINAL.pdf)
- [ISASecure — Why SL2 for ICS Components?](https://isasecure.org/isasecure-isa/why-security-capability-level-2-for-industrial-control-system-components)
- [ISASecure — 62443-4-2 What's New](https://isasecure.org/isa-iec-62443-4-2-what-s-new-in-4-2-1)
- [ISA InTech — New standard specifies security capabilities for control systems](https://www.isa.org/intech-home/2018/september-october/departments/new-standard-specifies-security-capabilities-for-c)
- [NIST SP 800-82 Rev. 3 — Guide to OT Security](https://csrc.nist.gov/pubs/sp/800/82/r3/final)
- [OWASP — Internet of Things Project (Top 10)](https://owasp.org/www-project-internet-of-things/)
- [OWASP — IoT Security Testing Guide — Firmware](https://owasp.org/owasp-istg/03_test_cases/firmware/)
- [OWASP — ISTG Firmware Update Mechanism](https://owasp.org/owasp-istg/03_test_cases/firmware/firmware_update_mechanism.html)
- [OWASP — ISTG Installed Firmware](https://owasp.org/owasp-istg/03_test_cases/firmware/installed_firmware.html)
- [OWASP — IoT Security Verification Standard (ISVS)](https://owasp.org/www-project-iot-security-verification-standard/)
- [OWASP IoT Top 10 2018 (PDF archive)](https://owasp.org/www-pdf-archive/OWASP-IoT-Top-10-2018-final.pdf)

## Key Findings

### IEC 62443 structure and the seven Foundational Requirements
ISA/IEC 62443 is a series (1-1 concepts, 2-x policy, 3-x system, 4-x component). The **4-2 component standard** is the one directly binding on the `sens-api-gateway` edge agent (it is classified as an "Embedded Device" — EDR — in 62443-4-2). The seven **Foundational Requirements** apply to every zone and conduit:

| FR | Name | Short definition |
|----|----|----|
| FR 1 | Identification and Authentication Control (IAC) | Only authenticated humans, processes, devices may access resources. |
| FR 2 | Use Control (UC) | Authenticated parties have only the privileges they need (RBAC, least privilege). |
| FR 3 | System Integrity (SI) | The integrity of processes, software, firmware and data is protected from unauthorised modification. |
| FR 4 | Data Confidentiality (DC) | Information at rest and in transit is protected from unauthorised disclosure. |
| FR 5 | Restricted Data Flow (RDF) | Zones and conduits segment the control network; flows are explicitly allowed. |
| FR 6 | Timely Response to Events (TRE) | The system reports events and responds to incidents within bounded time. |
| FR 7 | Resource Availability (RA) | The system remains operational under degraded conditions; essential functions are preserved. |

### Security Levels (SL) and the "SL2 minimum" guidance
- SL1: casual/coincidental violation.
- **SL2: intentional violation using simple means with low resources, generic skills.** ISASecure's guidance to OEMs is that SL2 is the minimum defensible posture for industrial components shipped in 2025+.
- SL3: sophisticated means, moderate resources, ICS-specific skills.
- SL4: sophisticated means, extended resources, ICS-specific skills.

For a cloud-connected aquaculture gateway, **SL2 is the target**, with forward path to SL3 for life-safety outputs. SL3 adds mandatory crypto at the component level, multi-factor authentication, and hardware-root-of-trust requirements.

### 62443-4-2 component requirements that bind on an edge agent (selected)
- **CR 1.1–1.14 (IAC):** unique device identity, per-account authentication, public-key-based authentication for machine-to-machine, account management including disable-unused, credential strength, credential lifetime.
- **CR 2.1–2.12 (UC):** authorization enforcement, session lock, role-based access control on all command interfaces, remote session termination, audit log of privilege changes.
- **CR 3.1–3.14 (SI):** communications integrity (MAC/AEAD), **code authenticity — signed firmware**, malicious code protection, audit log integrity, input validation on all boundaries, error handling that does not reveal state, session integrity (replay protection).
- **CR 4.1–4.3 (DC):** confidentiality at rest and in transit, cryptographic algorithm selection aligned with NIST SP 800-131A.
- **CR 5.1–5.4 (RDF):** network segmentation, zone boundary protection.
- **CR 6.1–6.2 (TRE):** audit log generation, continuous monitoring with bounded-time event dispatch.
- **CR 7.1–7.8 (RA):** DoS protection, resource management, backup/restore, emergency power, recoverable restart, network independence (graceful degradation), least functionality (disable unused ports/services), control system component inventory.

### Firmware verification & secure boot (OWASP ISTG + 62443 CR 3.4)
- **Signed firmware is mandatory.** CR 3.4 "Code Authenticity" requires the edge device to verify the digital signature of any executable code (firmware, OTA updates, scripts, plug-ins) before execution.
- **OWASP ISTG-FW tests**:
  - ISTG-FW-INST-001: Signed firmware — device must refuse unsigned or wrongly-signed update packages.
  - ISTG-FW-INST-002: Bootloader signature — the bootloader itself must be verified by the preceding stage (secure boot chain).
  - ISTG-FW-UPDT-001: Update authentication — update client authenticates to the update server (mTLS + signature).
  - ISTG-FW-UPDT-002: Rollback protection — monotonic version counters reject downgrade.
- **Secure boot on target hardware**:
  - Raspberry Pi Compute Module 4 / 5 and RevPi: hardware OTP can pin a boot-ROM key; signed `boot.img` ramdisk; encrypted rootfs tied to TPM-sealed key.
  - Infineon SLB9670 TPM (common on RevPi variants) provides sealed key storage, hardware RNG, and PCR-based remote attestation.
  - `sens-api-gateway` must integrate with (a) systemd measured boot, (b) TPM-sealed SQLCipher key, (c) signed binary verified at startup against a key burned into OTP.

### Anomaly detection and TRE (FR 6)
- **Sensor-level anomaly detection**: statistical process control (EWMA, CUSUM) on each tag, configurable per tag class. Aquaculture-specific thresholds (DO, pH, NH3) have hard safety bounds; breaching them must emit an event within a bounded latency (≤ 1 scan cycle + MQTT publish).
- **System-level anomaly detection**: watchdog counters, task liveness, RSS/CPU budget exceedance, reconnect storms, unexpected command source.
- **Audit log** is an append-only table with cryptographic chaining (each row includes HMAC over `prev_hmac || row`); forms a tamper-evident journal for CR 6.1.

### Resource availability (FR 7) for edge
- **Watchdog**: systemd `WatchdogSec` with the agent calling `sd_notify(WATCHDOG=1)` from a dedicated health task. Hardware watchdog (BCM2835 WDT on RPi, iTCO on x86 RevPi Connect) as second line.
- **Graceful degradation**: loss of MQTT → continue Modbus control loop with locally cached setpoints + offline queue. Loss of sensor → `Uncertain_LastUsableValue` quality + operator alarm.
- **Least functionality**: SSH disabled on production, only the agent health HTTP endpoint exposed (axum); bind to localhost or a mgmt interface, not 0.0.0.0.
- **Recoverable restart**: crash + systemd restart must deterministically reach safe-state before resuming control; the boot path must set all outputs to their configured safe value **before** re-arming the scripting engine.

## Security Concerns

- **No hardware root of trust** ⇒ CR 3.4 signed-firmware check can be bypassed by rewriting the verification code itself → full compromise. TPM-sealed key + OTP-burned bootloader key are mandatory for SL2.
- **Shared / hard-coded device credentials** across a fleet violate FR 1. Each unit must hold a unique X.509 client cert (MQTT mTLS, Modbus/Security TLS) issued by the fleet CA during provisioning.
- **Ungated command ingress** (MQTT subscribe on a command topic without an RBAC layer) violates FR 2.
- **Audit log that is not integrity-protected** violates CR 3.1 and makes post-incident forensics impossible.
- **Unbounded restart storms** (crash loop without backoff) violate FR 7 and degrade availability.
- **Debug endpoints left enabled** (Prometheus metrics, pprof, rumqttc's raw event dump) leak sensitive data and violate FR 5 least-functionality.
- **Rollback-enabled OTA** violates ISTG-FW-UPDT-002 and enables reintroducing known-vulnerable firmware.

## Performance Concerns

- Crypto on boot (signed firmware check + TPM-sealed key unseal + SQLCipher PBKDF2) must complete within the system watchdog grace period; on RevPi Connect 4, budget ~3 s.
- Audit-log HMAC chaining adds per-row cost ≈ 2 µs on ARMv8 with crypto extensions — trivial.
- Anomaly detection (EWMA/CUSUM) runs once per scan cycle per tag; must be capped to not starve control-loop budget.

## Architectural Implications for edge-expert reviews

1. **FR 1 — IAC:**
   - Unique device identity from `provisioning.rs` must produce an X.509 client cert in a TPM-backed key slot; no shared fleet key.
   - MQTT mTLS AND Modbus Security with X.509 role extension enforced in production.
   - Health HTTP endpoint requires an authenticated token (mTLS or time-bounded operator JWT); no anonymous `/metrics`.
2. **FR 2 — UC:**
   - Every command path (MQTT command topic, HTTP command endpoint, Modbus write function code) goes through a single `rbac.rs` gate keyed on authenticated role.
   - RBAC policy is compiled from `config.rs` with deny-by-default; no role → `Err(Forbidden)`.
   - Audit log every allow and every deny.
3. **FR 3 — SI:**
   - All binaries built in a reproducible way (`cargo build --locked`) and signed. The signature is verified at startup against a key pinned in OTP or TPM.
   - Input validation at every boundary: MQTT payload (strict schema), Modbus response bounds check, config parse errors fatal at load-time.
   - Audit log table `audit_log(id, ts, actor, action, prev_hmac, row_hmac)` with HMAC chain; periodic export to backend for off-device preservation.
4. **FR 4 — DC:**
   - TLS ≥ 1.2, AEAD cipher suites only. Rustls default suite list is acceptable; explicit `danger_accept_invalid_certs` FORBIDDEN (see MQTT research).
   - Data at rest: SQLCipher for offline queue, TPM-sealed key (see SQLCipher research).
5. **FR 5 — RDF:**
   - Least functionality: no SSH, no telnet, no serial console on production.
   - HTTP health bound to mgmt VLAN or localhost; Prometheus metrics gated by token.
   - Only allow-listed outbound destinations (broker, OTA server) enforced by firewall config in the deploy manifest.
6. **FR 6 — TRE:**
   - Sensor anomaly detection per tag; configurable hard safety bounds raise an event on the alarm topic within one scan cycle.
   - Audit log export target is the backend alarm topic, QoS ≥ 1.
   - Telemetry includes a heartbeat at fixed cadence so backend can detect silent failure.
7. **FR 7 — RA:**
   - Hardware watchdog enabled via systemd `WatchdogSec`; agent notifies from a dedicated task.
   - Startup sets all outputs to safe-state BEFORE arming the scripting engine.
   - Crash loop backoff via systemd `RestartSec` with a jittered progression.
   - Graceful degradation documented and tested: MQTT loss → continue local control; sensor loss → alarm + last-usable-value quality code.

## Domain Rule Additions for edge-expert

- **R-62443-01 (FR 1):** Per-device X.509 client cert in a TPM-backed slot. Shared fleet credentials FORBIDDEN. MQTT mTLS and Modbus Security X.509 role extension REQUIRED in production.
- **R-62443-02 (FR 1):** Health HTTP endpoint requires an authenticated token or mTLS. Anonymous `/metrics` is FORBIDDEN in production.
- **R-62443-03 (FR 2):** Single `rbac.rs` gate on every command path (MQTT, HTTP, Modbus write). Deny-by-default; unknown role → `Err(Forbidden)`.
- **R-62443-04 (FR 2):** Every allow AND every deny in RBAC is audit-logged.
- **R-62443-05 (FR 3):** Binaries built with `cargo build --locked` (reproducible), signed, verified at startup against a key pinned in OTP/TPM.
- **R-62443-06 (FR 3):** Strict schema validation on all external input (MQTT payload, HTTP body, Modbus response bounds, config parse). `serde_json::Value`-as-passthrough is FORBIDDEN on boundary paths.
- **R-62443-07 (FR 3):** Audit log table uses HMAC chaining (`prev_hmac || row`); periodic export to backend for off-device preservation.
- **R-62443-08 (FR 4):** TLS ≥ 1.2, AEAD suites only. `danger_accept_invalid_certs` FORBIDDEN. Data at rest in SQLCipher with TPM-sealed key.
- **R-62443-09 (FR 5):** Least functionality — no SSH/telnet/serial console on production image. Health HTTP bound to localhost or mgmt VLAN, never 0.0.0.0.
- **R-62443-10 (FR 5):** Outbound connections restricted to allow-listed destinations via deploy-manifest firewall config.
- **R-62443-11 (FR 6):** Per-tag anomaly detection with hard safety bounds; violations emit an alarm event within one scan cycle + publish latency.
- **R-62443-12 (FR 6):** Telemetry heartbeat at fixed cadence for backend silent-failure detection.
- **R-62443-13 (FR 7):** Hardware watchdog enabled via systemd `WatchdogSec`; dedicated agent task calls `sd_notify(WATCHDOG=1)`.
- **R-62443-14 (FR 7):** Startup sets ALL control outputs to safe-state BEFORE arming the scripting engine. Any code path that arms the engine before safe-state is a CRITICAL finding.
- **R-62443-15 (FR 7):** Crash-loop backoff via systemd `RestartSec` with jitter; unlimited immediate restart is FORBIDDEN.
- **R-62443-16 (FR 3, OWASP ISTG):** Firmware update rejects unsigned or wrong-key packages; monotonic version counter blocks downgrade; update client uses mTLS to the update server.
- **R-62443-17 (Secure Boot):** Signed `boot.img` + OTP-pinned bootloader key on RPi CM4/CM5/RevPi target hardware; TPM-sealed SQLCipher key; encrypted rootfs.
- **R-62443-18 (Least Privilege at OS):** Agent runs as a dedicated unprivileged user with `CAP_NET_BIND_SERVICE` only if needed; systemd unit with `PrivateTmp`, `ProtectSystem=strict`, `NoNewPrivileges`, `SystemCallFilter`.
- **R-62443-19:** Debug features (raw event dumps, Prometheus introspection, pprof) compile-gated behind `#[cfg(feature = "debug-endpoints")]`; release builds reject the feature.
- **R-62443-20:** Target security capability is **SL 2** minimum for the gateway; SL 3 path required for any component controlling life-safety aquaculture outputs (DO/pH/temp thresholds, dosing pumps).
