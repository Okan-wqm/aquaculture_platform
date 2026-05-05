# Secure Boot — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**Scope:** boot-time integrity guarantees, signed firmware, anti-rollback. Document separates the live v1.6.0 boot path from the Faz 2 roadmap.

---

## 1. Today (v1.6.0)

### 1.1 Boot chain

```
Power-on
  → SoC BootROM (factory-immutable)
    → Secondary bootloader (stage 2, Raspberry Pi EEPROM / Revolution Pi U-Boot)
      → Linux kernel (Debian-signed Raspberry Pi OS kernel or Yocto image)
        → systemd (PID 1)
          → suderra-agent.service
            → suderra-agent binary (`/usr/bin/suderra-agent` — `Cargo.toml:449`)
```

Integrity guarantees at each stage today:

| Stage | Integrity control | Enforced by |
|-------|-------------------|-------------|
| BootROM | Immutable; SoC-vendor signed | HARDWARE-VENDOR RESPONSIBILITY (Broadcom BCM2712 / RP1 on Raspberry Pi 5; Kunbus on RevPi) |
| Secondary bootloader | OS-vendor signed (Raspberry Pi Ltd signed EEPROM updates) | HARDWARE-VENDOR RESPONSIBILITY |
| Kernel + initrd | Debian/RaspiOS package signature | Package manager; `apt` GPG chain |
| systemd unit + binary | Debian-package-signed if distributed via apt; operator-deployed otherwise | Not enforced cryptographically at boot in v1.6.0 |

### 1.2 Agent-level integrity at startup

The live v1.6.0 agent applies these checks at process start:

- **Release-build hardening flags** — `panic = "abort"`, `strip = true`, `lto = true`, `opt-level = "z"`, `codegen-units = 1` (`Cargo.toml:421-426`). `panic=abort` ensures no stack unwind path that could leak in-memory secrets on crash.
- **Clippy DENY gates in release build** — `unwrap_used`, `expect_used`, `indexing_slicing`, `large_stack_arrays`, `todo`, `unimplemented`, `dbg_macro`, `print_stdout`, `print_stderr` (`Cargo.toml:434-442`); `unsafe_op_in_unsafe_fn = deny` (`Cargo.toml:445`). These block a class of panic-prone or side-channel-leak patterns from reaching the binary.
- **Cert-permission validation** — `validate_cert_file` + `validate_key_file_permissions` reject world- or group-readable private keys (`src/security.rs:72-98`).
- **TLS-cert expiry check** — `check_certificate_expiry` in-process via `x509-parser` (`src/security.rs:286-361`; `Cargo.toml:126-127`). Replaces the earlier openssl subprocess approach to remove PATH dependency.
- **Rustls crypto provider install** — `ring` default provider installed for MQTT TLS (`src/mqtt.rs:714`).

### 1.3 What is NOT enforced today

- **No binary-signature verification at boot.** The systemd unit invokes the binary directly. Signed-package distribution (dpkg/apt) is the only integrity control; that is distribution-level, not boot-time cryptographic enforcement. **Operator-level mitigation:** dm-verity or fs-verity on the root filesystem partition where the agent binary lives.
- **No TPM sealing of keystore master.** `tpm` feature is default-off (`Cargo.toml:361`). Runtime keystore backend falls back to systemd-creds or file-backed Argon2id. Label: `TPM tss-esapi feature default-off` per agent spec.
- **No anti-rollback counter.** A downgraded agent binary will start as long as systemd unit + binary perms are valid.
- **No A/B partitioning in the code tree.** Roadmap introduces tryboot overlay + boot-partition switch in Faz 2 Sprint 6.5.

---

## 2. Roadmap (Faz 2 and beyond)

### 2.1 TPM NV anti-rollback (Faz 2 Sprint 6.3, feature `tpm`)

Binding contract:

- `tss-esapi` bindings to libtpms/tpm2-tss (>= 4.0) — `Cargo.toml:284`, optional.
- PCR[0..7] bound: BootROM-measured firmware, secondary bootloader, kernel, initrd, systemd unit, agent binary hash.
- NV counter: monotonically-increasing; agent refuses to boot if `current_version < last_successful_version - rollback_window`.
- Fallback policy: missing TPM at runtime → graceful tier fallback to systemd-creds (Tier 2) or file-backed (Tier 3 with operator acceptance). No silent TPM-disable — operator must accept the downgrade via config (`i_accept_file_backed_keystore_risk`) and an audit event is emitted.

CI invariants (declared in `Cargo.toml` comments lines 282-284):

- `tests/invariants/tpm_feature_cross_compile.rs` — cross-compile matrix must include `cross build --target aarch64-unknown-linux-gnu --features tpm`.
- Feature-OFF binary must not contain `tss_esapi` symbols.

### 2.2 Signed manifest verify at boot (Faz 2 Sprint 6.5)

`src/updater/` stages the types. Runtime path (ROADMAP):

```
systemd ExecStartPre=/usr/bin/suderra-agent --verify-manifest
  → reads /usr/share/suderra/firmware.manifest.json + firmware.manifest.sig
  → verify_firmware_manifest(manifest_bytes, sig, slot1_pubkey)
    → Ed25519 verify_strict (ADR-021 §1 slot 1 firmware_manifest)
    → per-file SHA-256 stream with TOCTOU re-verify on mmap
  → if OK: exec main agent
  → if FAIL: fail-closed, emit audit event, refuse boot
```

### 2.3 A/B partition + confirm-boot handshake

Plan Faz 2 Sprint 6.5:

- tryboot overlay writes new image to B partition.
- Bootloader flag set to try B once; on success the agent sends `boot_confirmed` MQTT to cloud within 10 minutes.
- If no confirmation, bootloader auto-reverts to A — anti-brick rail.
- A/B state tracked in TPM NV + mirrored in `/var/lib/suderra/ab_state.json` (signed).

### 2.4 Config integrity at boot (Faz 2 Sprint 6.6)

`src/config_integrity/` types staged. Runtime (ROADMAP):

- `config.yaml` companion `config.yaml.sig` — Ed25519 over canonical bytes.
- Verify key: factory-provisioned pubkey in sealed read-only storage.
- Fail-closed: if signature invalid or `.sig` missing, boot refuses.
- Factory signing key is slot 6 of ADR-021 §1 (license/program signing reuse).

Label per `src/main.rs:85`: `#[allow(dead_code)] // Faz 2 Sprint 6.6 wires consumers; types pre-staged.`

### 2.5 Runtime-safety primitives (Faz 2 Sprint 6.7)

`src/runtime_safety/` types: NTS-authenticated clock authority, retained-msg guard, drain-before-safe-state shutdown ordering. Today: types only (`src/main.rs:92`). Roadmap lands the ClockAuthority supervisor so monotonic time + wall clock both have a trusted reference for jti expiry + audit timestamps.

---

## 3. Tier-1 make-it-impossible invariants

At full roadmap delivery, these invariants must hold (pre-conditions to shipping Faz 2):

1. **The agent binary cannot execute on a device whose PCR[0..7] does not match the sealing policy** — TPM seal fails, master key unavailable, agent fail-closes at startup before any mutation. (ROADMAP-Sprint 6.3)
2. **An older agent binary cannot start after a newer one has booted successfully** — NV-counter monotonicity. (ROADMAP-Sprint 6.3)
3. **A config.yaml without a matching signed `.sig` cannot reach the main loop** — verify happens before state transitions. (ROADMAP-Sprint 6.6)
4. **An attacker with SD-card write access cannot produce a boot-capable filesystem because PCR bindings will differ once the TPM seals against actual boot measurements** — SD-swap attack mitigated. (ROADMAP-Sprint 6.3)

---

## 4. Defense-in-depth against bypass

| Bypass attempt | Mitigation |
|----------------|------------|
| `strace` / `ptrace` attach to running agent | systemd `SystemCallFilter` + `NoNewPrivileges=yes`; `prctl(PR_SET_DUMPABLE, 0)` (ROADMAP-Sprint 6.3 Layer D of 6-layer defense-in-depth; TODAY: systemd-unit hardening only — ORPHAN-EDGE-004 scope) |
| Coredump of agent | systemd `LimitCORE=0`; in-process `prctl` guard (ROADMAP-Sprint 6.3) |
| Swap-to-disk of key bytes | `mlock()` on master-key bytes (ROADMAP-Sprint 6.3) |
| Panic unwind leaks secret | `panic = "abort"` (`Cargo.toml:425`); panic-hook zeroize additionally pre-loaded (ROADMAP-Sprint 6.3) |
| systemd unit file replaced | File perms + signed package distribution; dm-verity recommended (operator-tier) |

---

## 5. Today vs roadmap summary

| Requirement | Today (v1.6.0) | Roadmap milestone | Orphan ID |
|-------------|----------------|-------------------|-----------|
| Signed firmware manifest verify at boot | Not wired | Faz 2 Sprint 6.5 | ORPHAN-EDGE-004 (types exist, runtime NOT wired) |
| TPM anti-rollback | `tpm` feature default-off | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| A/B partition + confirm-boot | Not in code tree | Faz 2 Sprint 6.5 | Tracked in plan, not yet an orphan |
| Config.yaml signature | Not wired | Faz 2 Sprint 6.6 | ORPHAN-EDGE-004 |
| Defense-in-depth 6 layers runtime | TYPE-ONLY | Faz 2 Sprint 6.2-6.8 | ORPHAN-EDGE-004 |
| Cert expiry monitoring | Live (`src/security.rs:286`) | — | None |
| Panic-abort release profile | Live (`Cargo.toml:425`) | — | None |

---

## 6. Cross-references

- `docs/security/credentials-handling.md` — the 6-layer defense-in-depth matrix referenced in §4.
- `docs/security/crypto-inventory.md` — Ed25519 primitives used for manifest verification.
- `docs/security/threat-model.md` — trust-boundary 7 (kernel/hardware).
- ADR-018, ADR-019 for master-key hierarchy + firmware signing.
