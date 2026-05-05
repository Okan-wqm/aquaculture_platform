# Attack Surface Analysis — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**Scope:** every network port, every filesystem path, every physical interface exposed by a deployed edge device. Three boards: Network, Local, Physical.

---

## 1. Network attack surface

### 1.1 Listening ports (by default feature-set)

| Port | Protocol | Service | Auth requirement | Data sensitivity | Cargo.toml / src feature gate | Mitigation |
|------|----------|---------|------------------|------------------|-------------------------------|------------|
| 8080 | HTTP | Health check endpoint (`/health`) | None — liveness probe only | Low — returns status JSON | `Cargo.toml:328` feature `health` (enabled in default production profile) | Bind-address restricted to local orchestrator network; no tenant data exposed |
| 4840 | TCP (OPC UA) | OPC UA server for 3rd-party HMI read/write | OPC UA `Basic256Sha256` in roadmap; TODAY defaults can include `SECURITY_POLICY_NONE` — ORPHAN-EDGE-005 | High — OT tag read/write | `Cargo.toml:266` optional `opc-ua-server` feature (default-off) | Feature-OFF binary has zero OPC UA symbols (CI gate `tests/invariants/feature_off_no_symbols.sh`); feature-ON operator must pin policy |
| 4842 | TCP (WebSocket over HTTP) | SCADA display kiosk server | Local-LAN trust assumption | Medium — renders current tag values | `Cargo.toml:338` optional `scada-display` feature | CORS middleware via `tower-http` (`Cargo.toml:301`); read-only in v1.6.0 (no WS-initiated tag writes) |
| 1883 / 8883 | MQTT | **Outbound only** from agent to broker | Username+password TODAY (`src/mqtt.rs:237`); per-device X.509 ROADMAP (ORPHAN-EDGE-003) | High — control plane | `Cargo.toml:32` `rumqttc` | TLS mandatory in production; system-CA or pinned-CA (`src/mqtt.rs:744-786`); 1 MiB packet size cap (`src/mqtt.rs:245`); leaf-cert pinning ROADMAP Sprint 6.8 |
| 443 | HTTPS | **Outbound only** to cloud provisioning API | Token-based (single-use) | High — tenant-onboarding token | `Cargo.toml:30` `reqwest` rustls-tls-manual-roots | No cross-origin redirects (`src/provisioning.rs:221`); rustls-only build (no OpenSSL); body truncation on error paths (`src/provisioning.rs:316-329`) |
| Varies | Modbus-TCP | **Outbound only** to PLCs | Modbus TLS (rodbus 1.4, `Cargo.toml:70`) or plain TCP per deployment | High | `Cargo.toml:70` `rodbus = "=1.4.0"` pin (see `ORPHAN-002`) | TLS where supported; CRC-16 protocol-level integrity at minimum |
| 502 | Modbus-TCP | **Inbound** Modbus slave in selected configurations | Plain protocol — no auth primitive | High | same crate | Not recommended for exposed interfaces; gateway deployment should limit to OT-LAN |

Notable absences:

- No SSH daemon (openssh is operator's responsibility if remote admin is wanted; agent does not ship one).
- No Telnet, no SNMP, no Modbus-RTU-over-Ethernet bridge.
- No debug HTTP endpoint (`axum` used only for health + SCADA display behind feature gates).

### 1.2 HTTP attack-surface detail (health endpoint)

- Route: `GET /health` → returns `{"status":"ok"|"degraded", "uptime_s":N}` (no tenant data, no secrets).
- No `POST`/`PUT`/`DELETE` routes exposed.
- No WebSocket on the health server.
- Rate-limiting: relies on orchestrator / reverse-proxy layer. Not in-process in v1.6.0 (Not covered by this policy — see `docs/operations/rate-limiting.md`).

### 1.3 Outbound-only connections

By design, the agent is **initiator-only** for cloud and broker communication:

- Prevents inbound ACL exposure.
- Firewalls require only outbound 443 + 8883; simpler network segmentation for OT sites.
- Removes the Siemens-CSQ "Inbound service initiation" class of findings.

### 1.4 TLS configuration

- TLS 1.3 only (no 1.0/1.1/1.2) — enforced by `CipherSuite` allowlist at `src/mtls/cipher.rs:26-28` and rustls defaults.
- Cipher-suite allowlist: `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_256_GCM_SHA384`, `TLS_AES_128_GCM_SHA256` (`src/mtls/cipher.rs:23,25,27`).
- Hostname verification unconditional (rustls); `verify_hostname=false` in config rejected with fail-fast error (`src/mqtt.rs:700-710`).
- System CA store loaded via `rustls-native-certs` (`Cargo.toml:36`) when no explicit CA bundle is set.

---

## 2. Local attack surface (filesystem + IPC)

### 2.1 Sensitive filesystem paths

| Path | Mode | Owner | Content | Mitigation |
|------|------|-------|---------|------------|
| `/etc/suderra/config.yaml` | 0640 | `suderra:suderra` | Agent config (MQTT broker URL, tenant ID, feature flags) | Root-readable; group-readable by service user; NOT world-readable. Signed `.sig` companion in ROADMAP-Sprint 6.6 (`src/config_integrity/`) |
| `/etc/suderra/db.key` | 0400 | `suderra:suderra` | 32-byte SQLCipher key-derivation material | Atomic create (`OpenOptions::mode(0o400).create_new(true)`, `src/offline_queue.rs:94`) — no TOCTOU. HMAC-SHA256 input, not the final DB key |
| `/etc/suderra/certs/*.crt`, `*.key` | 0400 (key), 0644 (cert) | `suderra:suderra` | mTLS certs / keys (TLS to broker / cloud) | Validated by `validate_key_file_permissions` (`src/security.rs:72-98`); boot refuses on insecure perms |
| `/var/lib/suderra/offline_queue.db` | 0640 | `suderra:suderra` | SQLCipher-encrypted offline MQTT queue | AES-256-CBC at rest; DB key derived from machine-id + db.key; systemd `ReadWritePaths=` restricts writes (see ORPHAN-010 note below) |
| `/var/lib/suderra/retain.db` | 0640 | `suderra:suderra` | SQLCipher RETAIN variables for ST-VM | Same protection as offline_queue.db; domain-separated derived key (`src/keystore/purpose.rs:39`) |
| `/var/lib/suderra/audit/*.jsonl` | 0600 | `suderra:suderra` | HMAC-chained audit entries — ROADMAP Sprint 6.2 sink | HMAC chain (`src/audit/chain.rs:171`) means tamper detectable even if attacker gains 0600 read. TODAY: sink NOT WIRED — runtime audit goes only to `tracing-journald` (ORPHAN-EDGE-004) |
| `/var/log/journal/*` | 2755 `systemd-journal` | root | journald log store | FSS (Forward Secure Sealing) available via journald; structured logging via `tracing-journald` (`Cargo.toml:234`) |
| `/etc/machine-id` | 0444 | root | Distro machine ID | World-readable by design; ONE of two inputs for DB key derivation (combined with db.key) — machine-id alone is NOT the key per Jun-2025 audit closure |

**Note on systemd path divergence (ORPHAN-010):** the systemd unit template historically used `ReadWritePaths=/var/lib/suderra-agent` while runtime writes to `/var/lib/suderra`. The discrepancy is tracked and the systemd unit is the side being aligned.

### 2.2 IPC

- No D-Bus IPC endpoint exposed by the agent.
- `sd-notify` → systemd (watchdog + ready) via `/run/systemd/notify` (`Cargo.toml:101`). Unidirectional; agent writes only.
- No UNIX-domain socket server.
- systemd-creds IPC in ROADMAP-Tier 2 keystore backend (ADR-018 §7) uses the kernel credential helper, not a user-process socket.

### 2.3 Environment variables

- `SUDERRA_DATA_DIR` (optional) — enables path redirect on SQLite writes. ORPHAN-005 records that combined with ORPHAN-010 this creates a defense-bypass class of issue if a hostile process sets the env var to match the wrong systemd ReadWritePaths. Mitigation: systemd unit forbids env override via `PassEnvironment=` exclusion in the hardened unit.

### 2.4 Process hardening

Release-build:

- `panic = "abort"` (`Cargo.toml:425`) — no unwind → no stack-bytes leak path.
- Strip symbols (`Cargo.toml:426`).
- Size-optimized (`opt-level = "z"`, `Cargo.toml:422`).

In-process defense-in-depth (ROADMAP-Sprint 6.3 — ORPHAN-EDGE-004):

- `prctl(PR_SET_DUMPABLE, 0)` via `libc` (`Cargo.toml:206`).
- `mlock` on master key bytes via `libc`.
- `memfd_secret(2)` attempt where kernel ≥ 5.14.
- Panic-hook zeroize with `process::abort()` — no unwind to user code.

---

## 3. Physical attack surface

### 3.1 Interfaces

| Interface | Exposure | Mitigation |
|-----------|----------|------------|
| SD-card slot (Raspberry Pi) | Full filesystem image extraction possible | Master key TPM-sealed (ROADMAP); SQLCipher at rest for DB files; `/etc/suderra/db.key` protected only by filesystem perms if extracted offline; assumption is TPM-sealing closes this |
| USB | USB storage / HID attack | Operator policy should `modprobe -r` usb_storage on kiosk deployments; not enforced in-agent |
| UART / serial console (`/dev/ttyS0`, `/dev/ttyAMA0`) | Console login / bootloader interactive | Disable via `console=` kernel cmdline; disable bootloader interactive mode — HARDWARE-VENDOR RESPONSIBILITY at SBC provisioning |
| JTAG / SWD | Full CPU-state read | SBC vendor eFuse JTAG disable; HARDWARE-VENDOR RESPONSIBILITY (Broadcom RP1 / RP2 eFuse options) |
| GPIO | Tag writes via direct pin manipulation | The agent is one of several processes that may drive GPIO; `gpio` feature uses `rppal` via `PlatformAware GpioPlatform` validation (`src/security.rs:131-181`); pin-range validation per platform |
| I2C / SPI | Direct sensor bus access | Kernel-level access requires CAP_SYS_RAWIO — systemd unit drops capabilities; sensor whitelist in `config.yaml` |
| Case tamper switch | Detect enclosure opening | Not wired in v1.6.0 — HARDWARE-VENDOR RESPONSIBILITY (operator adds hardware tamper switch to GPIO input, consumed by agent as a digital input tag) |
| Network MAC spoof | Hostile peer on OT LAN | Deploy MAC-based 802.1X or port-security on the OT switch — customer network responsibility |

### 3.2 Chain of custody

- **Factory provisioning:** factory operator signs provisioning fingerprint. If TPM is present, master key sealed against PCR[0..7] at this stage.
- **Operator activation:** provisioning_token or tenant_token single-use; device-code derived deterministically from CPU serial or machine-uid (`src/provisioning.rs:447-516`).
- **Field redeployment:** re-provisioning triggers new TPM NV counter; old derivation chains invalidated (Faz 2 Sprint 6.3).

### 3.3 Extracted-media residual risk

Even with SD-card extraction:

- SQLCipher DBs are AES-256-CBC; need `/etc/suderra/db.key` AND `/etc/machine-id`.
- `/etc/machine-id` is on the same SD card (co-extracted), so the DB-key derivation is computable → mitigations depend on machine-uid being tied to a non-extractable fuse AND the Master-key going through TPM seal. Until TPM seal is wired, assume SD-card extraction is a compromise class.
- TLS private keys are file-backed (`/etc/suderra/certs/*.key`) — same attack class until `tpm` feature + sealed-cert-store ROADMAP-Sprint 6.3.

---

## 4. Summary + roadmap reminder

- **Today's net attack surface** is intentionally narrow: three listening ports (two feature-gated), outbound-only control-plane traffic, filesystem paths audited to 0400 / 0640 with atomic-create TOCTOU prevention, TLS 1.3-only cipher allowlist, and 1 MiB MQTT packet caps.
- **Known gaps** live at the orphan-findings ledger:
  - ORPHAN-EDGE-003 — MQTT auth username+password instead of per-device X.509.
  - ORPHAN-EDGE-004 — Defense-in-depth 6 layers TYPE-ONLY until Faz 2 Sprints 6.2–6.8.
  - ORPHAN-EDGE-005 — OPC UA SECURITY_POLICY_NONE negotiation allowed.
- **HARDWARE-VENDOR RESPONSIBILITY** rows explicitly marked; customer network design + SBC vendor eFuse options are out of `sens-api-gateway` code scope.

---

## 5. Cross-references

- `threat-model.md` — STRIDE matrix against each trust boundary.
- `credentials-handling.md` — 6-layer defense-in-depth matrix for key material at rest.
- `deployment/scada-display.md` — CORS + kiosk deployment detail.
- `../compliance/iec-62443.md` — FR1 (identification), FR3 (integrity), FR5 (availability) mapping to the rows in §1-§3.
