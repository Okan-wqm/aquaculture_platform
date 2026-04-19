# ADR-019: Edge Firmware Signing + A/B Partition + Dedicated Rescue Slot + Sealed Provisioning + Master Key Hierarchy

**Status:** Proposed (opened 2026-04-19; revised post-audit 2026-04-19 — 4 CRITICAL + 5 HIGH + 4 MEDIUM + 3 LOW closed in §10 closure table; target Accepted 2026-05-03 after ADR-021 (DEC-008) reaches Proposed minimum)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + edge-expert + security-auditor + edge-industrial-auditor
**Owner:** Okan (until edge-lead hire; PROC-001)
**Deadline:** 2026-05-03 (gates ADR-017 + ADR-018 → Accepted)
**Related findings:** SEC-002, SEC-004, DEC-002, DEC-003, DEC-006, DEC-012, ADR-018 §3 FINDING-001, ADR-018 §4 FINDING-002, ADR-019-FINDING-001..016 (post-audit revision closure)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-6, R-7; §5 Faz 2

---

## Context (WHY)

### Problem
Edge agent iki temel güvenlik boşluğuyla sahada: (1) firmware imza yok (SEC-002), (2) sealed tenant binding yok (ADR-018 §3), (3) anti-rollback yok (ADR-018 §4), (4) SQLCipher master key zayıf (SEC-004). Mevcut HC-1 path `commands.rs:820-1008` GitHub release + SHA-256 `.sha256` — aynı kanaldan hash, chain-of-custody yok.

### Post-audit context
Bu ADR'ın ilk taslağı security-auditor tarafından **4 CRITICAL + 5 HIGH + 4 MEDIUM + 3 LOW** bulgu ile NEEDS_REVISION verildi. Ana problemler: (a) slot 6 çakışması (provisioning vs program keys), (b) PROVISIONING_SIGNING_PUBKEY storage undefined → firmware-key compromise tenant binding'i çökertir, (c) boot_flag single-key signing → A/B flip attack, (d) HC-1 bootstrap trust anchor yok. Bu revizyon §10 closure table ile her bulguyu kapatır.

---

## Decision (WHAT)

**1. ed25519 firmware imzalama + dual-signature boot_flag + signing_key_epoch. 2. Tek A/B + dedicated rescue partition (p6). 3. PROVISIONING_SIGNING_PUBKEY multi-tier pinning (TPM NV / OTP / rescue-embedded, never in updatable rootfs). 4. Sealed ProvisioningBlob + immutable FS bit + re-provisioning auth flow. 5. Master key hierarchy with Argon2id for Tier 3. 6. HC-1 physical bootstrap ceremony + signed fingerprint verification. 7. Crash-consistent migration + UPS preflight. 8. Dedicated rescue partition bypass path. 9. Per-tenant mTLS phases + 3-pin leaf pinning. 10. Install retry cap + auto-rescue trigger.**

### 1. Key ceremony slot map — 7 slots (FINDING-001 kapama)

ADR-017/018/019 ortak key-ceremony map, ADR-021'de canonical:

| Slot | Key | Class | Ceremony | Rotation | Verifier |
|---|---|---|---|---|---|
| 1 | `firmware_signing_key` | online HSM | 4-eye + HSM | 180-gün | `updater::verify_firmware` |
| 2 | `rbac_manifest_signing_key` | online HSM | 4-eye + HSM | 180-gün | `authz::verify_manifest` |
| 3 | `command_signing_root_key` | online HSM | 4-eye + HSM | 180-gün | `authz::verify_command_envelope` |
| 4 | `rescue_firmware_signing_key` | factory air-gap | HSM cold | NEVER (re-flash) | `updater::verify_rescue_firmware` |
| 5 | `emergency_policy_signing_key` | factory air-gap | HSM cold | NEVER (re-flash) | `authz::emergency::verify_emergency_policy` |
| 6 | `program_signing_key` | online HSM | 4-eye + HSM | 180-gün | `st_compiler::verify_bytecode` (ADR-017 §6) |
| **7** | `provisioning_signing_key` | factory semi-air-gap | 4-eye + HSM | 365-gün | `provisioning::verify_blob` (ADR-019 §4) |

Invariant: `tests/invariants/hsm_slot_uniqueness.rs` — `docs/adr/*.md` parse; her key-name için HSM slot N tek; duplicate = CI fail. ADR-017/018 cross-reference güncellenir aynı PR'da.

### 2. PROVISIONING_SIGNING_PUBKEY storage hierarchy (FINDING-002 kapama)

**Problem:** Eğer PROVISIONING_SIGNING_PUBKEY rootfs_a/b içindeyse, firmware_signing_key compromise = attacker pubkey'i değiştir → self-signed malicious provisioning blob → tenant binding kırılır.

**Decision — updatable rootfs dışında pin:**

```
Tier 1 (RPi 5 + TPM2): TPM NV sealed to PCR[0..3] + policy
  └─ TPM NV index 0x1500000 (MIL-spec permanent); unsealable only with PCR quote
Tier 2 (RPi 4 boot partition): /boot/provisioning_pubkey.bin
  └─ signed by rescue_firmware_signing_key (slot 4, factory cold)
  └─ /boot mounted ro at runtime; write only during rescue-slot boot
  └─ OTP fuse checksum spot-check (where available)
Tier 3 (legacy, no TPM, writable /boot): embedded in rescue firmware ONLY
  └─ PROVISIONING_SIGNING_PUBKEY never in rootfs_a/b binary
  └─ rescue firmware must boot at least once post-migration to seed the key
```

```rust
// WHY: Rootfs a/b attacker-replaceable via firmware_signing_key compromise.
//      Trust chain must be rooted outside updatable surface.
// WHAT: Multi-tier load; cross-verify at boot; mismatch → emergency mode.
// INVARIANT: tests/invariants/provisioning_pubkey_outside_rootfs.rs
//   - grep `rootfs_a|rootfs_b` binary: PROVISIONING_SIGNING_PUBKEY bytes must NOT appear
//   - boot-time cross-check: TPM-NV pubkey == /boot/provisioning_pubkey.bin pubkey == rescue-firmware pubkey
//   - mismatch triggers emergency mode + CRITICAL cloud telemetry
pub fn load_provisioning_pubkey() -> Result<VerifyingKey, PkLoadError> {
    let tier1 = tpm_nv_read_pubkey(0x1500000).ok();        // TPM NV
    let tier2 = read_signed_pubkey_from_boot_partition().ok();  // /boot signed file
    let tier3 = RESCUE_EMBEDDED_PROVISIONING_PUBKEY;       // const in rescue firmware
    cross_verify_tiers(tier1, tier2, tier3)
        .ok_or(PkLoadError::TierMismatch)
}
```

Invariant: `tests/invariants/provisioning_pubkey_outside_rootfs.rs`.

### 3. Firmware signing + signing_key_epoch + boot_flag dual-signature (FINDING-003 kapama)

**Problem:** boot_flag sadece firmware_signing_key ile imzalı → key compromise = slot flip attack. Ayrıca version-monotonic ≠ epoch-monotonic; attacker compromise öncesi slot 1 key'le daha yüksek version imzalayıp deploy edebilir.

**Decision:**

```rust
#[derive(Serialize, Deserialize)]
pub struct FirmwareManifest {
    pub magic: [u8; 4],                  // "SFMF"
    pub manifest_version: u16,
    pub firmware_version: SemVer,        // monotonic
    pub signing_key_epoch: u32,          // YENİ — epoch-monotonic; key rotation bumps
    pub release_channel: ReleaseChannel,
    pub target_hardware: HardwareMatrix,
    pub build_timestamp_unix_ms: i64,
    pub source_date_epoch: i64,          // INFORMATIONAL; validated by ADR-023 SLSA L3 reproducer
    pub files: Vec<FirmwareFile>,
    pub total_bytes: u64,                // EDGE_MAX_FIRMWARE_BYTES = 256 MB
    pub min_bootloader_version: SemVer,
    pub requires_rescue_cutover: bool,
    pub dmverity_root_hash: [u8; 32],    // YENİ — rootfs dm-verity hash (FINDING-009)
    pub signature: [u8; 64],             // ed25519 by firmware_signing_key (slot 1)
}

// Signed boot_flag — YENİ: dual-signature + tryboot commit
#[derive(Serialize, Deserialize)]
pub struct SignedBootFlag {
    pub active_slot: Slot,                        // A | B | Rescue
    pub firmware_version: SemVer,
    pub signing_key_epoch: u32,
    pub dmverity_root_hash: [u8; 32],             // pins rootfs content; swap post-rename rejected
    pub issued_at_unix_ms: i64,
    pub firmware_signature: [u8; 64],             // slot 1 signature
    pub rbac_countersignature: [u8; 64],          // YENİ — slot 2 countersig (defense-in-depth)
    pub tryboot_commit_proof: TrybootCommitProof, // YENİ — active_slot health promoted signed report
}

// Boot-time verify:
//   1. Both signatures valid (slot 1 + slot 2 both compromised → yeni attack class)
//   2. signing_key_epoch >= persisted_highest_epoch (epoch anti-rollback)
//   3. dmverity_root_hash matches target slot's computed hash (content pin)
//   4. tryboot_commit_proof valid (slot self-promoted via signed health within budget)
//
// Attacker with slot 1 compromise alone CANNOT flip boot_flag:
//   - cannot forge slot 2 rbac_countersignature
//   - cannot forge tryboot_commit_proof (requires successful health probe + signed attestation)
```

**cloud-side slot-flip anomaly detection:** signed audit event `firmware.slot_flip_attempted`; cloud monitors for flips not preceded by platform-issued deployment command → automatic `rescue_cutover` within 5-minute SLA.

Invariant: `tests/invariants/boot_flag_dual_signature.rs`, `tests/invariants/firmware_epoch_monotonic.rs`.

### 4. TOCTOU-safe install pipeline with mount namespace + dm-verity commit (FINDING-009 kapama)

```
1. Download manifest + firmware bundle → /tmp (tmpfs, RAM only)
   └─ INVARIANT: size enforced against manifest.total_bytes BEFORE write
2. Verify manifest signature (ed25519; firmware_signing_pubkey or rescue_firmware_signing_pubkey)
   └─ signing_key_epoch >= persisted_highest_epoch (ADR-018 §4 AntiRollbackCounter trait)
   └─ firmware_version >= current (via same trait, FINDING-011)
   └─ target_hardware match /proc/device-tree/model
3. Compute dm-verity root hash over extracted tree → match manifest.dmverity_root_hash
4. Select install target slot: A ⊕ current_active (inactive)
5. INVARIANT: Install target slot mounted in PRIVATE MOUNT NAMESPACE (systemd unit
   `PrivateMounts=yes`); never visible to any other process
6. Wipe target slot + extract files + fsync + mmap read-back + SHA-256 re-verify + rename atomic
7. INVARIANT: After install completion, umount target slot (umount -l); no further file ops
8. SignedBootFlag constructed:
   - active_slot = target
   - dmverity_root_hash = computed hash
   - firmware_signature + rbac_countersignature from platform co-signing workflow
   - tryboot_commit_proof = null at install (computed post-boot by target slot)
9. Write SignedBootFlag + set tryboot to try the target slot
10. Reboot into target slot
11. Cold-boot health probe (3-of-3):
    - systemd-notify READY=1
    - cmd-queue heartbeat
    - signed self-attestation posted to cloud (cloud ACK signed back)
    PERSIST across reboots; partial = unhealthy
12. Health OK within cold_boot_budget_secs → target slot signs tryboot_commit_proof with its
    local command_signing delegation → SignedBootFlag updated + committed
13. Health FAIL or cold_boot_budget_secs exhausted → bootloader auto-rollback to previous slot;
    install_attempts counter persisted via AntiRollbackCounter trait
14. INVARIANT: install_attempts >= 2 for same manifest.firmware_version →
    emergency policy mode (NOT auto-retry; NOT silent rollback to compromised slot)
15. INVARIANT: 2+ rollbacks within 24h on slot X AND slot X pre-rescue-epoch →
    auto-boot rescue slot (bypasses A/B flag)
```

`cold_boot_budget_secs` config-driven (RPi4 90s, RevPi 120s). "healthy" rigorously defined 3-of-3 per FINDING-006 kapama.

Invariant: `tests/invariants/install_mount_namespace.rs`, `tests/invariants/dmverity_hash_signed_boot_flag.rs`, `tests/invariants/install_retry_capped.rs`, `tests/invariants/rollback_auto_rescue_trigger.rs`.

### 5. Partition layout — dedicated rescue slot p6 (FINDING-005 kapama)

```
/dev/mmcblk0p1: /boot               (fat32, shared; provisioning_pubkey + tryboot config signed)
/dev/mmcblk0p2: rootfs_a            (ext4)
/dev/mmcblk0p3: rootfs_b            (ext4)
/dev/mmcblk0p4: /var/lib/suderra    (ext4 — state, provisioning.bin, SQLCipher DB)
/dev/mmcblk0p5: /var/log/suderra    (ext4 — append-only audit)
/dev/mmcblk0p6: rootfs_rescue       (ext4 read-only via dm-verity; minimal suderra-agent + recovery tools)
```

**Rescue boot rules:**
- Bootloader ALWAYS attempts rescue boot when `/boot/rescue_trigger.signed` present AND signed by slot 4 (rescue_firmware_signing_key)
- Rescue boot bypasses active A/B flag entirely
- Rescue firmware never occupies slot A or B — never swapped in normal updates
- Rescue firmware embeds: rejection rules for compromised epochs, factory-sealed PROVISIONING_SIGNING_PUBKEY copy (Tier 3 fallback), emergency policy signing pubkey
- Rescue partition size: ~500 MB (minimal userland + recovery tools)
- Rescue update: physical re-flash OR signed rescue-cutover via slot 4 + immutable bit temporarily cleared for one write window

Invariant: `tests/invariants/rescue_slot_dedicated.rs` — rescue partition discoverable; A/B install path never writes to p6.

### 6. ProvisioningBlob — sealed + immutable + re-provisioning flow (FINDING-010 kapama)

```rust
#[derive(Serialize, Deserialize)]
pub struct ProvisioningBlob {
    pub magic: [u8; 4],                 // "PRVB"
    pub schema_version: u16,
    pub device_id: [u8; 16],
    pub tenant_id: [u8; 16],
    pub signing_key_epoch: u32,         // YENİ — ties to current key ceremony epoch
    pub issued_at_unix_ms: i64,
    pub issued_by_operator_id: String,
    pub rbac_manifest_trust_chain_root_pubkey: [u8; 32],
    pub command_signing_trust_chain_root_pubkey: [u8; 32],
    pub program_signing_trust_chain_root_pubkey: [u8; 32],
    pub site_code: String,              // max 64 bytes, sanitized
    pub deployment_notes: String,       // max 512 bytes, UTF-8 normalized, control-char stripped,
                                         // truncated to 32 chars at Prometheus label boundary
    pub signature: [u8; 64],            // ed25519 by provisioning_signing_key (slot 7)
}
```

**Write protection (FINDING-010 kapama):**
```
Partition /dev/mmcblk0p4 (where provisioning.bin lives):
  - Mount: ro,nosuid,nodev by default at runtime
  - Writable only during attested provisioning flow:
    a. Platform-issued short-lived re-provisioning token bound to device_id
    b. Cloud challenge-response (Nonce verify at cloud before token issued)
    c. mount -o remount,rw /var/lib/suderra
    d. Write provisioning.bin
    e. chattr +i provisioning.bin (immutable bit)
    f. sync && mount -o remount,ro /var/lib/suderra
  - Normal runtime: immutable bit prevents rm/rewrite even with root
  - Re-provisioning: requires cloud challenge; stolen provisioning_signing_key alone insufficient
```

**Recovery on corrupt/missing blob (FINDING-013 kapama):**
- Emergency policy mode activated; permission set = ADR-018 §5 `EMERGENCY_PERMITTED_BASE` explicitly
  (SafeStateTrigger + Reboot + ReadAuditLog + EmergencyActuator{class: LifeSupport})
- Emergency mode duration cap: 72h without cloud re-provisioning OR operator-signed local override
- After 72h: outputs halt but sensors continue (asset-loss-risk acknowledged trade-off for safety)
- Cloud alert: `provisioning.emergency_mode_active` CRITICAL + per-device countdown

### 7. Master key hierarchy + Argon2id Tier 3 (FINDING-007 kapama)

```
Tier 1 (RPi 5 + TPM2): TPM NV sealed to PCR[0..3] + policy — unchanged
Tier 2 (RPi 4 / TPM-less): systemd-creds with LUKS backing — unchanged
Tier 3 (legacy, operator-gated):
  OLD: HKDF(operator-passphrase, device_id)           — BROKEN (brute-force + public device_id)
  NEW: Argon2id(
         passphrase = operator-passphrase,
         salt       = HKDF(device_id, provisioning_nonce, "keystore-salt-v2"),
         m          = 256 MiB,  // memory-hard
         t          = 3,         // iterations
         p          = 4,          // parallelism
       )

Passphrase entropy floor:
  - zxcvbn score >= 4  OR  24-char diceware
  - Rejected at provisioning time; no mid-boot acceptance
  - Stored in operator's password manager; never env var, never on-disk
  - systemd LoadCredential via PAM keyring (memory-only); reboot-persistent keyring requires operator login

Expiry behavior (FINDING-007 B):
  - T-14d: CRITICAL telemetry + cloud surface warning (device_id + site_code listed)
  - T-0: device degrades to emergency policy mode
    + write path disabled (read-only sensors)
    + only re-provisioning accepted (operator passphrase renewal)
    + NEVER silently renews
  - Fleet SLA: keystore_backend{tier="3"} / fleet_total > 5% → cloud CRITICAL with named list
```

**Systemd + in-process hardening** (unchanged from V1, kept for completeness):
- `LimitCORE=0`, `ProtectKernelModules`, `SystemCallFilter=@system-service`, full sandbox
- `prctl(PR_SET_DUMPABLE, 0)` post-unsealing
- `mlock(master_key_bytes)` swap prevention
- Panic hook → explicit `.zeroize()` + `process::abort()` (no unwinding)
- `memfd_secret(2)` attempt (kernel 5.14+), fallback mlock

### 8. mTLS migration — per-tenant phases + 3-pin leaf rotation (FINDING-008 kapama)

**Per-tenant phase gating (not fleet-global):**

```yaml
tenant_manifest (signed by rbac_manifest_signing_key):
  tenant_id: uuid
  mtls_phase: legacy | warn | strict
  mtls_phase_expires_at: RFC3339
  # INVARIANT: Enterprise tenants MAY start at strict from day 1
  # INVARIANT: Any device successfully presenting mTLS cert twice auto-promotes to warn
  #            for THAT device, independent of tenant phase
  # INVARIANT: stricter of (device self-promoted, tenant phase, global cap) wins
```

**Per-tenant timeline bounds:**

| Phase | Per-tenant max | Hard fleet cap | Behavior |
|---|---|---|---|
| legacy | 60 gün | 90 gün | Accept mTLS + token; warn log on token |
| warn | 90 gün | 120 gün | mTLS required; token = reject + 30d audit |
| strict | — | — | mTLS only; token reject |

Total migration: 150 gün per-tenant (up to 210 gün fleet-wide hard cap for slowest tenant).

**3-pin leaf certificate pinning (FINDING-008 B):**

```yaml
mqtt.broker.pinned_leaf_cert_sha256:
  - <current-leaf-hash>           # slot 1
  - <next-leaf-hash>              # slot 2 — rotation staged
  - <rescue-leaf-hash>            # slot 3 — delivered via rescue firmware (slot 4 signed)
# INVARIANT: If slot 1 and slot 2 both revoked (CA incident, accidental expiry),
#            slot 3 activates automatically via rescue firmware boot
# Rotation ceremony: quarterly for slots 1 & 2; slot 3 rotated annually with rescue firmware
```

**Config integrity:** `/etc/suderra/config.yaml.sig` ed25519 factory-signed (DEC-013); runtime verify; `enforcement: "legacy"` override impossible without re-provisioning.

**Cipher suite explicit (unchanged):**
```yaml
mqtt.tls.allowed_cipher_suites:
  - TLS_AES_256_GCM_SHA384
  - TLS_CHACHA20_POLY1305_SHA256
```

Invariant: `tests/invariants/mtls_phase_per_tenant.rs`, `tests/invariants/mtls_3pin_rescue_fallback.rs`.

### 9. HC-1 bootstrap trust ceremony (FINDING-004 kapama)

**Problem:** Mevcut fleet unsigned firmware path. Migration SSH ile iniyor ama device kendi adına trust anchor yok. Attacker GitHub release'i veya SSH TOFU'yu ele geçirirse trust anchor attacker oluyor.

**Decision — iki yol:**

**Yol A — Factory provisioning (yeni üniteler):**
- Trust anchor factory'de burn edilir
- Field bootstrap yok
- Bu ADR'ın normal akışı

**Yol B — Field migration (mevcut HC-1 fleet):**

```
Pre-migration state:
  - Device: unsigned firmware, no trust anchor
  - Cloud: has device_id + mtls cert (legacy phase)

Bootstrap ceremony (per-device, coordinated):
1. Platform signs a one-time `first-signed-transition.img` with:
   - fingerprint SHA-256 printed on PAPER (physical delivery)
   - fingerprint also delivered via S/MIME-signed email to the deploying technician
   - cloud-logged as "bootstrap pending for device_id"
2. Technician:
   - SSH'es into device using existing known-hosts
   - Reads fingerprint aloud on a recorded phone call to platform operator
   - OR: verifies fingerprint matches S/MIME-signed email on separate-channel device
3. Platform operator verifies fingerprint (printed + verbal + email triangulation)
4. Platform operator signs a `bootstrap_authorization.sig` with their personal operator key
   - delivered to technician out-of-band
5. Technician runs migration script with --bootstrap-authorization=<signed-blob>
6. Migration script:
   - verifies bootstrap_authorization against platform operator's pubkey (pre-shared)
   - installs first-signed-transition.img including PROVISIONING_SIGNING_PUBKEY
     via rescue-slot seed (Tier 3 fallback)
   - SSH session logs full transcript, signed by technician, cloud-relayed as audit event
7. First reboot: rescue slot activates → seeds trust chain → normal A/B operation resumes
8. Cloud-side audit:
   - triangulation log: printed fingerprint hash, verbal recording ID, email S/MIME ID
   - technician signature
   - platform operator signature
   - device cloud-ack of first signed firmware
   - 7-year retention

INVARIANT: Bootstrap-authorization blobs are one-time-use; replay dedup 365d cloud-side.
INVARIANT: Fingerprint must be verified through ≥2 independent channels (paper + verbal / email / SMS).
```

**Alternatif Yol B' — Physical re-flash:** for devices where remote ceremony is impractical, physical SD card re-flash at regional depot with factory-signed image. Still requires multi-channel verification of tech identity.

Invariant: `tests/invariants/hc1_bootstrap_ceremony_documented.rs` — verifies runbook docs/runbooks/hc1-bootstrap-ceremony.md references all required channels.

### 10. Crash-consistent migration + UPS preflight (FINDING-012 kapama)

```
Pre-flight:
  1. Check power: RPi power-supervisor HAT voltage record last 24h stable
     (if no HAT: operator attested UPS present + battery test passed last 7d)
  2. fsck -n on source partition; migration aborts on any FS warning
  3. Free space: refuse migration if free < 2× current rootfs (copy, not online-resize)

Migration sequence (crash-consistent):
  a. Create STAGING area: /tmp/migration-staging (tmpfs, RAM-backed)
  b. Flash new bootloader to staging (NOT overwriting active /boot)
  c. Full copy (not online-resize) source rootfs → new B partition
     - rsync --archive --xattrs --acls --hard-links --checksum
     - fsync per file; final barrier fsync
  d. SHA-256 verify target partition content against source snapshot
  e. COMMIT SIGNAL: write /boot/ab_migrated.sig (signed by bootstrap_authorization)
  f. Swap bootloader atomic: cp staging/bootloader.bin /boot/bootloader.bin + fsync + blockdev --rereadpt
  g. Reboot

Crash recovery on boot:
  - If /boot/ab_migrated.sig absent AND staging detected → revert to pre-migration bootloader
    + no data loss, migration can be retried
  - If /boot/ab_migrated.sig present AND bootloader intact → proceed with A/B
  - If /boot/ab_migrated.sig present AND bootloader corrupt → boot rescue slot + cloud alert
```

Invariant: `tests/invariants/migration_crash_consistent.rs` — simulated power-loss at each step; post-reboot state is either pre-migration or post-migration, never intermediate.

### 11. currentlyInstalledVersion via AntiRollbackCounter trait (FINDING-011 kapama)

```rust
// WHY: Separate version counter would be re-creation of SD-wipe downgrade attack.
//      Single hierarchical counter serves BOTH firmware_version AND policy_version.
// WHAT: Reuse ADR-018 §4 AntiRollbackCounter trait; distinct keys for firmware vs policy.
pub trait AntiRollbackCounter: Send + Sync {
    fn read_firmware_version_floor(&self) -> Result<SemVer, StorageError>;
    fn read_firmware_epoch_floor(&self) -> Result<u32, StorageError>;
    fn read_policy_version_floor(&self, tenant: TenantId) -> Result<u64, StorageError>;
    fn bump_firmware(&self, new_version: SemVer, new_epoch: u32) -> Result<(), StorageError>;
    fn bump_policy(&self, tenant: TenantId, new_version: u64) -> Result<(), StorageError>;
    fn tier(&self) -> RollbackProtectionTier;
}

// Tier 1: TPM NV (separate NV indices for firmware vs policy)
// Tier 2: eMMC RPMB (separate RPMB slots)
// Tier 3: A/B signed slot counter (persisted in /boot/rollback_state.sig signed by rescue key)
// Tier 4: file + operator acceptance (same escape hatch as keystore Tier 3)
```

### 12. Audit trail for rollback events (FINDING-015 kapama)

```rust
// ADR-020 (DEC-019) defines audit HMAC chain; ADR-019 contributes FirmwareRollbackEvent contract:
#[derive(Serialize, Deserialize)]
pub struct FirmwareRollbackEvent {
    pub event_id: [u8; 16],
    pub device_id: [u8; 16],
    pub tenant_id: [u8; 16],
    pub from_version: SemVer,
    pub to_version: SemVer,
    pub from_epoch: u32,
    pub to_epoch: u32,
    pub reason: RollbackReason, // HealthProbeFailed | InstallAttemptCapReached | RescueCutover | OperatorForced
    pub rollback_count_24h: u32,
    pub triggered_at_unix_ms: i64,
    pub hmac_chain_prev: [u8; 32],
    pub hmac_chain_entry: [u8; 32], // via audit_hmac_chain_key (HKDF from master)
}
```

### 13. SLSA L3 reproducible build (FINDING-014 kapama)

`source_date_epoch` alanı INFORMATIONAL; verifier ADR-023 (DEC-017) SLSA L3 reproducer iş paketinde tanımlı. Bu ADR-019'da implementation value yok; alan schema forward-compat için korunur.

---

## 10. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-019-FINDING-001 | CRITICAL | §1 7-slot map | Slot 7 `provisioning_signing_key`; ADR-017/018 ortak PR'da güncellenir |
| ADR-019-FINDING-002 | CRITICAL | §2 pubkey hierarchy | TPM NV / /boot signed / rescue-embedded; tests/invariants/provisioning_pubkey_outside_rootfs.rs |
| ADR-019-FINDING-003 | CRITICAL | §3 dual-signature + epoch | `rbac_countersignature` slot 2 + `signing_key_epoch` + tryboot_commit_proof + dmverity_root_hash |
| ADR-019-FINDING-004 | CRITICAL | §9 bootstrap ceremony | Paper + verbal + email triangulation; operator signature; 7-year cloud audit |
| ADR-019-FINDING-005 | HIGH | §5 dedicated p6 rescue | Rescue slot never A/B-swapped; `/boot/rescue_trigger.signed` slot 4 signed |
| ADR-019-FINDING-006 | HIGH | §4 rigorous health + retry cap | 3-of-3 health definition; install_attempts >= 2 → emergency mode; 2+ rollbacks/24h → auto-rescue |
| ADR-019-FINDING-007 | HIGH | §7 Argon2id + expiry spec | Argon2id m=256MiB/t=3/p=4; entropy floor 128-bit; expiry → emergency mode |
| ADR-019-FINDING-008 | HIGH | §8 per-tenant phases + 3-pin | Per-tenant manifest mtls_phase; auto-promote on mTLS success; 3-pin rescue slot |
| ADR-019-FINDING-009 | HIGH | §4 mount namespace + dm-verity | PrivateMounts=yes; dmverity_root_hash in SignedBootFlag; umount post-install |
| ADR-019-FINDING-010 | MEDIUM | §6 immutable bit + re-prov auth | chattr +i; ro,nosuid,nodev; cloud challenge-response for re-provisioning |
| ADR-019-FINDING-011 | MEDIUM | §11 AntiRollbackCounter trait | Reuse ADR-018 §4 trait; separate NV indices for firmware vs policy |
| ADR-019-FINDING-012 | MEDIUM | §10 crash-consistent migration | Staging area; commit signal ab_migrated.sig; UPS preflight; full-copy not online-resize |
| ADR-019-FINDING-013 | MEDIUM | §6 emergency mode life-safety | Permission set = ADR-018 §5 EMERGENCY_PERMITTED_BASE + 72h duration cap + outputs-halt-sensors-read trade-off |
| ADR-019-FINDING-014 | LOW | §13 INFORMATIONAL label | `source_date_epoch` forward-compat; verifier ADR-023 scope |
| ADR-019-FINDING-015 | LOW | §12 FirmwareRollbackEvent | Event schema + ADR-020 HMAC chain integration |
| ADR-019-FINDING-016 | INFO | §6 sanitization | UTF-8 normalized, control-char stripped, 32-char truncation at Prometheus boundary |

---

## Alternatives Considered

### Alt-1 Plan B V1 "atomic_swap default + opt-in A/B" — 3 agent REDDET

### Alt-2 LUKS rootfs encryption — her boot operator passphrase; remote-reboot impossible

### Alt-3 UBI/UBIFS — eMMC ile overkill; Faz 11 SL-3 re-eval

### Alt-4 Cloud-sealed provisioning — offline 2-6 hafta senaryosunda brick

### Alt-5 In-place replace — atomic değil; V1 varyantı reddedildi

---

## Consequences

### Positive
- **Firmware integrity:** ed25519 + per-file SHA-256 + TOCTOU close (mount namespace + dm-verity) + epoch-monotonic + dual-signature boot_flag
- **Sealed tenant (ADR-018 §3 RESOLVED):** ProvisioningBlob + PROVISIONING_SIGNING_PUBKEY multi-tier pinning + chattr+i
- **Anti-rollback (ADR-018 §4 RESOLVED):** Shared AntiRollbackCounter trait; signing_key_epoch rotation breaks old-key-signed firmware
- **Rescue slot dedicated:** p6 read-only dm-verity; bypass path for compromise scenarios
- **HC-1 bootstrap auditable:** multi-channel fingerprint triangulation; 7-year retention; supply-chain pivot risk closed
- **Crash-consistent migration:** UPS preflight + staging + commit signal; power-loss → pre-migration OR post-migration, never intermediate
- **Argon2id Tier 3:** GPU-resistant; 128-bit entropy floor; expiry → emergency mode not silent renew
- **Per-tenant mTLS:** enterprise tenants move fast; laggard doesn't block fleet; 3-pin rescue fallback prevents CA-incident brick
- **Master key discipline:** TPM → systemd-creds → Argon2id file; coredump + mlock + panic zeroize; SEC-004 RESOLVED

### Negative
- **Storage doubling + rescue:** rootfs_a + rootfs_b + rescue = 2× + ~500MB; typical 16GB SD baseline
- **Migration complexity:** UPS preflight + staging + crash-consistent steps; longer than V1 in-place
- **HC-1 bootstrap logistics:** paper + phone + email triangulation per device; 500+ fleet operator-hours
- **Signing pipeline complexity:** 7 HSM slots (slot 6 program_signing + slot 7 provisioning) + dual-signature boot_flag + rbac countersignature on every firmware deploy
- **Implementation kod:** `src/updater/` ~3000-3500 satır; `src/keystore/` ~2000-2500 satır; `src/provisioning/` ~800-1000 satır
- **Operator passphrase UX:** Argon2id m=256MiB derivation at boot adds ~3-5s cold boot latency (acceptable within 90-120s budget)

### SL-3 deferrals (ADR-023 scope, tracked DEC-017)
- dm-verity rootfs beyond boot_flag hash (full runtime enforcement)
- Secure boot chain (OTP fuses — factory-only, hardware refresh required)
- Remote attestation (TPM PCR quote → cloud)
- SLSA L3 reproducible verifier pipeline

---

## 11. Implementation Plan (Plan §5 Faz 2)

**Hafta 6-9:**

1. Sprint 6.1 — 7-slot key ceremony map + ADR-017/018/019 cross-ref PR
2. Sprint 6.2 — `src/updater/` + FirmwareManifest (with signing_key_epoch + dmverity_root_hash)
3. Sprint 6.3 — `src/keystore/` + Argon2id Tier 3 + passphrase entropy check
4. Sprint 7.1 — TOCTOU-safe install + mount namespace + dm-verity commit
5. Sprint 7.2 — SignedBootFlag dual-signature + tryboot_commit_proof
6. Sprint 7.3 — Dedicated rescue partition p6 + rescue boot bypass logic
7. Sprint 7.4 — PROVISIONING_SIGNING_PUBKEY multi-tier load + cross-verify
8. Sprint 8.1 — ProvisioningBlob + immutable bit + re-provisioning challenge-response
9. Sprint 8.2 — HC-1 bootstrap ceremony runbook + ceremony tooling
10. Sprint 8.3 — Crash-consistent migration + UPS preflight
11. Sprint 8.4 — AntiRollbackCounter trait integration (firmware + policy)
12. Sprint 8.5 — Per-tenant mTLS phases + 3-pin leaf rotation
13. Sprint 8.6 — systemd hardening (LimitCORE + syscall filter + watchdog)
14. Sprint 8.7 — Install retry cap + auto-rescue trigger + health probe 3-of-3
15. Sprint 9.1 — 15+ invariant test green + Kani candidate
16. Sprint 9.2 — SL-2 adversarial re-audit (2 bağımsız güvenlik agent)

**Acceptance criteria (Faz 2 close):**
- 15 invariant test green (listed in §4, §2, §5, §8, §9, §10)
- systemd service hardening verified (`systemctl show | grep LimitCORE` = 0)
- Migration E2E on RPi4 + RPi5 + RevPi Connect 4 (with power-loss chaos)
- Rescue cutover E2E (primary key revoke → rescue boot → re-provisioning)
- HC-1 bootstrap ceremony runbook + tabletop exercise
- IEC 62443 SL-2 adversarial re-audit: FR1 + FR3 + FR4 green
- Status → Accepted

---

## References

- IEC 62443-4-1, IEC 62443-3-3 FR3, FR4
- NIST SP 800-193, SP 800-147
- TCG TPM 2.0 Library Specification
- Argon2id RFC 9106
- Raspberry Pi tryboot documentation
- JEDEC eMMC 5.1 RPMB
- SLSA framework (https://slsa.dev)
- `/var/aqua-saas/sens-api-gateway/src/commands.rs:820-1008` (current unsigned path — Faz 2 target)
- ADR-017 (ST Bytecode — program_signing trust chain; 7-slot map consumer)
- ADR-018 (Edge RBAC — AntiRollbackCounter trait + sealed tenant binding consumer + 7-slot map consumer)
- ADR-020 (DEC-019) — Audit Log HMAC Chain (FirmwareRollbackEvent integration)
- ADR-021 (DEC-008) — Platform Key Ceremony (canonical 7-slot map) (BLOCKER)
- ADR-023 (DEC-017) — SL-3 Upgrade Path (dm-verity full rootfs + secure boot + remote attestation)
