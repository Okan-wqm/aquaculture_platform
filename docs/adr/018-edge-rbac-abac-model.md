# ADR-018: Edge RBAC — ABAC Permission-Set + 5-Key Segregation + Tenant Trust Root + Per-Operator Keys + Break-Glass

**Status:** Proposed (opened 2026-04-19; revised post-audit 2026-04-19; target Accepted 2026-05-03 after ADR-019 (DEC-002) + ADR-021 (DEC-008) reach Proposed minimum)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + auth-security-expert + security-auditor + edge-industrial-auditor
**Owner:** Okan (until security-lead hire; PROC-001 tracks TBD sweep)
**Deadline:** 2026-05-03 (blocked on ADR-019 sealed tenant binding + ADR-021 HSM slots for all 5 keys)
**Related findings:** DEC-004 RESOLVED (this ADR), SEC-001 (RBAC absent), DEC-002 (ADR-019 sealed tenant + A/B anti-rollback), DEC-008 (ADR-021 key ceremony)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-5, §3.1 RBAC iki-katman, §5 Faz 2
**Supersedes:** Plan A'nın "pluggable JSON policy doc with string[] capabilities" kararı (pure-tickling-crescent.md §5.4)

---

## Context (WHY)

### Problem
Edge agent 16+ MQTT komutunun (deploy_program, write_modbus, force_value, failover_control, firmware_update, reboot) **hiçbiri authorize edilmiyor** — `commands.rs:250-515` `execute()` direkt dispatch. User endişesi: *"rbac sistemini tam oturtamadım daha da"* → edge vocabulary fixed olmalı (platform evrimine bağışık), flexibility cloud manifest katmanında olmalı. Ama gevşeklik = güvenlik açığı; çözüm iki-katmanlı.

### Post-audit context
Bu ADR'ın ilk sürümü security-auditor tarafından **4 CRITICAL + 5 HIGH + 4 MEDIUM + 4 LOW** bulgu ile NEEDS_REVISION verildi. SL-2 adversarial baseline paper seviyesinde bile sağlanmıyordu. Bu revizyon her bulguyu §7 closure table'ında kapatır.

Belirleyici findings:
- **CRITICAL-001 tenant-id trust root:** `config.rs:188 tenant_id: Option<String>` plaintext dosyada → fiziksel erişimle saldırgan tenant-A manifest'ini tenant-B cihazına taşır (cross-tenant pivot, zero key compromise).
- **CRITICAL-002 policy_version wipeable:** SQLCipher tabanlı `highest_seen_version` SD wipe → monotonic 0 → eski imzalı manifest replay (downgrade attack, zero key compromise).
- **CRITICAL-003 key count inconsistency:** Title "3-Key" ama gövdede 4. (rescue) + 5. (emergency policy) key var → blast radius iddiası yanıltıcı + implementer key ceremony drift.
- **CRITICAL-004 two-person single-key:** "İkincil operator kendi command_signing_key ile imzalar" prose der ama edge binary tek `command_signing_pubkey` taşır → her iki imza aynı key'den; platform compromise = two-person bypass.

---

## Decision (WHAT)

**İki-katmanlı RBAC + 5-Key Segregation (3 online + 2 factory) + sealed tenant binding + anti-rollback storage + per-operator command keys + break-glass + hot-reload recovery invariant + edge-side DoS protection.**

### 1. Edge vocabulary — fixed Permission enum

```rust
// WHY: Cloud RBAC model evrildikçe edge binary dokunulmasın istiyoruz — user'ın
//      "RBAC tam oturmadı" endişesini karşılar. AMA gevşek string cap'leri tip-güvenli değil.
// WHAT: Edge vocabulary closed enum (make-it-impossible); cloud manifest custom_roles
//       bu enum üzerine permission bundle kurar; platform değişimi manifest'i etkiler, enum'u değil.
// INVARIANT: Permission variant kaldırmak YASAK (backward compat); additive-only genişletme;
//            her genişletme ADR amendment + min_edge_version bump gerektirir (§6 manifest shape).
pub enum Permission {
    // Read paths
    ReadTag, ReadAuditLog,

    // Write paths — actuator class specific (interface-agnostic effect permission §4)
    WriteTag { tag_id: TagId },
    ModbusWrite { device_id: DeviceId, register_range: Range<u16> },
    GpioWrite { pin: u8 },
    PwmWrite { channel: u8 },
    SpiWrite { device_id: SpiDeviceId },
    OpcUaWrite { tag_id: TagId },

    // Effect-based (attacker bir interface'de deny olursa diğerine geçemez)
    AffectActuator { class: ActuatorClass }, // Chemistry|Aeration|Lighting|Filtration|Feeding|LifeSupport

    // Lifecycle
    DeployProgram, UpdateFirmware, Reboot,
    SafeStateTrigger,

    // Debug
    WatchSubscribe, DebugStep, ForceValue,

    // Admin
    FailoverControl, ManagePolicy, ManageLicense,

    // Emergency (break-glass — hardcoded subset, §5)
    EmergencyActuator { class: ActuatorClass }, // binary-hardcoded allowlist
}
```

### 2. Key Segregation — 5 keys (3 online + 2 factory) (AUDIT-CRITICAL-003 kapama)

| Key | Class | Ceremony | Rotation | Verifier module | Blast on compromise |
|---|---|---|---|---|---|
| `firmware_signing_key` | online (HSM hot) | 4-eye + HSM | 180-gün | `updater::verify_firmware` | Attacker backdoor firmware; RBAC / commands / emergency / rescue hâlâ güvenli |
| `rbac_manifest_signing_key` | online (HSM hot) | 4-eye + HSM | 180-gün | `authz::verify_manifest` | Attacker rol map ekleyebilir ama WriteTag hedef tag'leri bytecode header'da sabitlenmiş (ADR-017); firmware / commands / emergency hâlâ güvenli |
| `command_signing_key` (root) | online (HSM hot) | 4-eye + HSM | 180-gün | `authz::verify_command_envelope` | Attacker komut imzalayabilir ama per-operator subkey (§4) ile bileşik; tek compromise two-person'ı kıramaz |
| `rescue_firmware_signing_key` | factory (air-gap) | HSM cold | NEVER (re-flash gerekir) | `updater::verify_rescue_firmware` | Primary firmware key compromise sonrası recovery path; rescue key compromise = physical re-flash only |
| `emergency_policy_signing_key` | factory (air-gap) | HSM cold | NEVER (re-flash gerekir) | `authz::emergency::verify_emergency_policy` | Break-glass policy imzalar; permission set binary-hardcoded narrow (§5); widening structurally impossible |

```rust
// WHY: Single-key compromise = backdoor + "attacker=Admin" birlikte = platform compromise ⇒ fleet compromise.
//      5-key segregation blast radius 1/5 ile sınırlar. Emergency + rescue factory-only.
// WHAT: EdgeTrustAnchor struct 5 pubkey; ayrı verifier modülü her biri için; mutual module-isolation.
pub struct EdgeTrustAnchor {
    pub firmware_signing_pubkey: VerifyingKey,           // → updater::
    pub rbac_manifest_signing_pubkey: VerifyingKey,      // → authz::
    pub command_signing_root_pubkey: VerifyingKey,       // → authz::verify_command_envelope (root chain)
    pub rescue_firmware_signing_pubkey: VerifyingKey,    // → updater::rescue
    pub emergency_policy_signing_pubkey: VerifyingKey,   // → authz::emergency
    // NOT included: program_signing_pubkey (ADR-019 §1 slot 6, bytecode için) and
    //                provisioning_signing_pubkey (ADR-019 §1 slot 7, tenant sealing için)
}

// Binary'de 5 ayrı compile-time const; program_signing ADR-021 (DEC-008) ile tanımlanır.
// tests/invariants/rbac_key_segregation.rs — her module yalnız kendi pubkey'ini import eder (compile-time grep).
```

**Compromise propagation matrix:**

| Compromise | firmware | rbac | command root | rescue | emergency | Effect |
|---|---|---|---|---|---|---|
| firmware only | ✗ | | | | | Backdoor binary; rescue path mevcut |
| rbac only | | ✗ | | | | Rol map genişletme; WriteTag header-bound; limited |
| command root only | | | ✗ | | | Per-operator subkey bileşik olmadan two-person bypass edemez |
| firmware + rbac | ✗ | ✗ | | | | Backdoor + admin grant; rescue firmware ile recovery |
| firmware + rbac + command | ✗ | ✗ | ✗ | | | 3/5 catastrophic ama rescue + emergency kalıyor; SafeStateTrigger hâlâ mümkün |
| + rescue | ✗ | ✗ | ✗ | ✗ | | 4/5; emergency hâlâ life-safety korumakta |
| + emergency | ✗ | ✗ | ✗ | ✗ | ✗ | Total fleet compromise; requires factory-HSM + online-HSM BOTH breached |

### 3. Tenant binding — sealed trust root (AUDIT-CRITICAL-001 kapama)

**Problem:** `config.yaml::tenant_id` plaintext, freely-writable → saldırgan tenant-A imzalı manifest'ini tenant-B cihazına taşır.

**Decision:** `expected_tenant` **ASLA** mutable config'den okunmaz. Kaynak hiyerarşisi:

1. **Provisioning-signed blob** (`/var/lib/suderra/provisioning.bin`) — factory veya field provisioning aşamasında `provisioning_signing_key` ile imzalanır (ADR-019 scope, key hiyerarşisinde firmware altında chain)
2. **TPM-sealed alternative** (RPi 5 TPM2 ya da external TPM var ise) — PCR[0..3] + policy sealed
3. **Rescue recovery:** provisioning blob corrupt / missing → emergency policy mode (life-safety only) + cloud-initiated re-provisioning

```rust
// WHY: Freely-writable config dosyası tenant binding için yetersiz. Sealed storage şart.
// WHAT: ProvisioningBlob imzalı; edge boot'ta verify; edge binary trust root bu blob.
// INVARIANT: authz::verify_manifest() sadece ProvisioningBlob::verified_tenant_id() okur;
//            config.tenant_id kullanımı yasak (compile-time grep invariant).
#[derive(Serialize, Deserialize)]
pub struct ProvisioningBlob {
    pub device_id: [u8; 16],
    pub tenant_id: [u8; 16],                  // INVARIANT: authz sealed source
    pub issued_at: i64,
    pub rbac_manifest_trust_chain_root: PublicKey,  // allows platform-side sub-CA delegation
    pub command_signing_root_trust_chain: PublicKey,
    pub signature: Signature,                 // ed25519 by provisioning_signing_key (ADR-019)
}

// Boot sequence (simplified):
//   1. Read /var/lib/suderra/provisioning.bin
//   2. Verify signature with PROVISIONING_PUBKEY (binary-embedded const)
//   3. Seal `verified_tenant_id` in an Arc<OnceCell<TenantId>>; never mutable
//   4. authz::verify_manifest checks manifest.tenant_id == OnceCell::get().unwrap()
//
// tests/invariants/tenant_binding_sealed.rs — grep for any authz:: code reading config.tenant_id directly
```

**Consequences:** `config.yaml::tenant_id` legacy artifact olarak kalır (telemetry/logging label amaçlı); mutable erişim yine var ama **güvenlik kararlarında kullanılmaz**. Compile-time grep invariant + CODEOWNERS.

### 4. Anti-rollback storage — TPM NV + A/B slot counter (AUDIT-CRITICAL-002 kapama)

**Problem:** `highest_seen_version` SQLCipher'da → SD wipe → monotonic reset → eski imzalı manifest replay edilir (downgrade attack, zero key compromise).

**Decision — Hierarchical anti-rollback:**

```
Tier 1 (RPi 5 + TPM2): TPM NV counter for policy_version_floor
  ↓ fallback
Tier 2 (RPi 4 or TPM-less): eMMC RPMB partition monotonic counter
  ↓ fallback
Tier 3 (hardware without RPMB): firmware A-partition slot counter (updated at each verified manifest
         accept; re-flash resets only via firmware_signing_key-authenticated flow)
  ↓ last-resort
Tier 4 (legacy hardware): CRITICAL boot event; operator-gated acceptance
         `config.i_accept_rollback_window: true` + expires_at; config.yaml itself signed (§8)
```

```rust
// WHY: SD wipe saldırısı zero key compromise ile downgrade açıyor.
// WHAT: Monotonic counter her verified manifest accept'te bump; regresyon ASLA.
//       Verification sırası: counter_read → manifest.policy_version > counter_read ? accept : reject
// INVARIANT: tests/invariants/rollback_protection_storage.rs — tier ≥ 3 için fiziksel wipe
//            sonrası eski manifest replay fails (simulated).
pub trait AntiRollbackCounter: Send + Sync {
    fn read_current_floor(&self) -> Result<u64, StorageError>;
    fn bump_to(&self, new_floor: u64) -> Result<(), StorageError>;
    fn tier(&self) -> RollbackProtectionTier;  // for telemetry
}

// Boot: select highest-tier backend available; telemetry emits RollbackProtectionTier metric;
// CRITICAL alarm if tier drops below previously-seen tier (e.g., TPM failure).
```

ADR-019 (DEC-002) cross-reference: A/B partition slot counter ADR-019 kapsamı; bu ADR Tier 2-3 storage primitive'i specifier-level tanımlar, implementer-level ADR-019'da.

### 5. Emergency policy — factory-signed, binary-hardcoded permission narrowing (AUDIT-CRITICAL-003 + HIGH-009 kapama)

**Problem:** `emergency_policy.json.sig` dosyası sadece prose'da "SafeStateTrigger + Reboot + ReadAuditLog" diye sınırlanıyor — attacker factory key compromise'ta `ManagePolicy` imzalayabilir. Ayrıca O2 crash'te yetersiz (aerator override gerek).

**Decision:**

```rust
// WHY: Emergency permission set MANIFEST-DRIVEN DEĞİL — binary-hardcoded. Emergency key compromise
//      bile widening edemez. Emergency manifest yalnız NARROWING (hardcoded set'ten seçim) yapabilir.
// WHAT: EmergencyContext AuthorizedContext'ten ayrı newtype; emergency verify path izolasyonlu.
// INVARIANT: src/authz/emergency.rs src/authz/policy.rs'i import etmez; AuthorizedContext construct edemez.

const EMERGENCY_PERMITTED_BASE: &[Permission] = &[
    Permission::SafeStateTrigger,
    Permission::Reboot,
    Permission::ReadAuditLog,
    // LIFE-SAFETY scope — O2 crash senaryosu için EmergencyActuator, binary-hardcoded tag allowlist ile:
    Permission::EmergencyActuator { class: ActuatorClass::LifeSupport },
];

// EmergencyActuator dispatch path:
const EMERGENCY_LIFE_SAFETY_TAGS: &[&str] = &[
    "aerator_*",        // glob — compile-time expanded against device-specific tag registry
    "o2_dosing_*",
    "emergency_drain_*",
    "co2_scrubber_*",
];

// EmergencyActuator write rate limit (hardcoded, manifest cannot widen):
const EMERGENCY_ACTUATOR_MAX_WRITES_PER_SEC: u32 = 1;
const EMERGENCY_ACTUATOR_MAX_WRITES_PER_5SEC: u32 = 3;

pub struct EmergencyContext {
    // Narrower than AuthorizedContext — subset selected from EMERGENCY_PERMITTED_BASE
    permissions: HashSet<Permission>,
    actor: EmergencyActor,  // operator-on-site ID, ed25519-signed by operator key
    issued_at: Instant,     // monotonic
    expires_at: Instant,    // max 24h; re-issue via cloud when connectivity restored
}

impl EmergencyContext {
    // INVARIANT: permissions ⊆ EMERGENCY_PERMITTED_BASE (runtime + compile-time verify)
    pub(in crate::authz::emergency) fn new(
        selected: &[Permission],
        actor: EmergencyActor,
    ) -> Result<Self, EmergencyError> {
        for p in selected {
            if !EMERGENCY_PERMITTED_BASE.contains(p) {
                return Err(EmergencyError::WideningAttempt(p.clone()));
            }
        }
        Ok(Self { permissions: selected.iter().cloned().collect(), actor, issued_at: Instant::now(), expires_at: Instant::now() + Duration::from_hours(24) })
    }
}

// Command dispatch branches:
//   fn execute(cmd, ctx: AuthorizedContext)  → normal path
//   fn execute_emergency(cmd, ctx: EmergencyContext)  → emergency path, subset commands only
// Two distinct handler types; compile-time separation.

// tests/invariants/emergency_cannot_widen.rs — fuzz emergency_policy.json content; verify widening
// past EMERGENCY_PERMITTED_BASE → EmergencyError at parse time.
```

**O2 crash E2E acceptance (Faz 2 close):** simulated O2 drop + cloud offline; operator-on-site uses emergency credential → aerator duty increased via `EmergencyActuator { class: LifeSupport }` → event audited → manifest-governed state restored on next reload.

### 6. Manifest shape — version-bound + required_permissions + min_edge_version (AUDIT-HIGH-006 kapama)

```json
{
  "schema_version": 2,
  "policy_version": 42,
  "signing_key_epoch": 3,
  "tenant_id": "uuid-bytes-hex",
  "min_edge_version": "2.0.0",
  "required_permissions": ["ReadTag", "WriteTag", "AffectActuator", "DeployProgram"],
  "valid_from": "RFC3339",
  "valid_until": "RFC3339",
  "max_offline_grace_days": 180,
  "default_templates": { "Viewer": [...], "Operator": [...], "Admin": [...], "Emergency": [...] },
  "custom_roles": [
    {
      "name": "FeedTechnician",
      "permissions": ["ReadTag", "AffectActuator:Feeding", "WatchSubscribe"],
      "constraints": {
        "tag_patterns": ["feeder_*", "pump_feed_*"],
        "value_ranges": { "feeder_duty": { "min": 0.0, "max": 100.0 } }
      },
      "operators": [
        { "operator_id": "user_uuid", "command_signing_pubkey": "base64_ed25519" }
      ]
    },
    { "name": "Veterinary", "permissions": [...], "operators": [...] }
  ],
  "two_person_required": [
    "UpdateFirmware", "DeployProgram", "SafeStateTrigger", "ForceValue",
    "ModbusWrite:safety_tagged"
  ],
  "recovery_invariant": {
    "at_least_one_role_has": "ManagePolicy",
    "verified_at_issue_time": true
  },
  "signature": "base64_ed25519_by_rbac_manifest_signing_key"
}
```

#### Key additions vs prior revision

- **`schema_version`** (existing) + **`signing_key_epoch: u32`** (AUDIT-MEDIUM-012): `(epoch, policy_version)` tuple; edge stores highest-seen per epoch; rotation bumps epoch; old-epoch manifests reject post-rotation regardless of their version.
- **`min_edge_version: SemVer`** (AUDIT-HIGH-006): edge refuses manifests targeting future edge versions → no silent drop.
- **`required_permissions: HashSet<PermissionName>`** (AUDIT-HIGH-006): if ANY unknown to the binary → manifest REJECT (fail-closed, not silent drop).
- **`max_offline_grace_days: u32`** (explicit config field, default 180): expiration + offline window both considered.
- **`custom_roles[].operators[]`** (AUDIT-CRITICAL-004): **per-operator ed25519 pubkey** embedded; edge verifies envelope signatures against THIS per-operator key, not generic command_signing_pubkey.
- **`recovery_invariant`** (AUDIT-HIGH-007): at least one role MUST have `ManagePolicy`; edge rejects manifests violating this → self-lockout structurally impossible.
- **`constraints`**:  glob anchored, no `**` wildcard (AUDIT-MEDIUM-011); validated at manifest-verify time against compile-time tag registry; patterns matching zero tags OR matching safety-tagged tags they shouldn't → REJECT.

### 7. Per-operator command signing (AUDIT-CRITICAL-004 kapama)

**Problem:** Tek `command_signing_key` = iki imza aynı anahtardan; platform compromise two-person'ı kırar.

**Decision:**

```
Key chain:
  command_signing_root_key (HSM, online)
    └── (delegation via rbac_manifest custom_roles[].operators[].pubkey)
         → Per-operator ed25519 keypair
         → Platform provisions operator keypair, holds private key in per-tenant HSM slot
         → Manifest embeds operator pubkey (rbac_manifest_signing_key ile imzalı)
         → Edge verifies envelope with operator pubkey (NOT root key)
```

**Signed command envelope:**

```rust
#[derive(Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub command: Command,
    pub actor_operator_id: OperatorId,     // matches manifest custom_roles[].operators[].operator_id
    pub binds_to_policy_version: u64,      // INVARIANT: == edge currently-active policy_version; mismatch = reject
    pub binds_to_signing_key_epoch: u32,   // matches manifest signing_key_epoch
    pub tenant_id: [u8; 16],               // INVARIANT: == ProvisioningBlob.verified_tenant_id()
    pub jti: [u8; 16],                     // replay dedup
    pub iat: i64, pub exp: i64,            // wall clock, with monotonic floor (§10)
    pub nonce: [u8; 16],
    pub signature: Signature,              // ed25519 by OPERATOR private key (NOT root)
}

// Two-person envelope:
pub struct TwoPersonEnvelope {
    pub primary: CommandEnvelope,          // first operator
    pub secondary_actor_id: OperatorId,
    pub secondary_signature: Signature,    // by DIFFERENT operator's private key
    // INVARIANT: secondary_actor_id != primary.actor_operator_id
    // INVARIANT: both signatures bind to SAME binds_to_policy_version
    //            (prevents version-skew race AUDIT-CRITICAL-004.race)
}

// verify_command_envelope:
//   1. Look up OperatorId in currently-active manifest custom_roles[].operators[]
//   2. Extract operator pubkey from manifest entry
//   3. ed25519 verify envelope signature with THAT key
//   4. Check envelope.binds_to_policy_version == current manifest policy_version
//   5. Check envelope.tenant_id == ProvisioningBlob::verified_tenant_id()
//   6. jti dedup check
//   7. For two-person commands: verify secondary envelope against SECOND operator's pubkey;
//      assert both signatures bind to SAME policy_version
//
// tests/invariants/two_person_distinct_keys.rs — fuzz: platform compromise single key → cannot forge both
// tests/invariants/two_person_version_binding.rs — version skew race: primary@v42, manifest→v43, secondary@v43 → REJECT
```

### 8. Hot-reload + recovery invariant + in-flight re-check (AUDIT-HIGH-007 kapama)

```rust
// WHY: ManagePolicy self-revoke → fleet lockout; in-flight long command old-manifest TOCTOU.
// WHAT: Recovery invariant + stage-boundary re-check + structured audit.
// INVARIANT: tests/invariants/recovery_invariant_preserved.rs — manifest violating recovery invariant REJECT.

impl PolicyEngine {
    pub async fn reload(
        &self,
        new_manifest_bytes: &[u8],
        new_sig: &Signature,
        caller_ctx: &AuthorizedContext,
    ) -> Result<(), AuthzError> {
        // 0) Permission check (caller must have ManagePolicy)
        caller_ctx.require(Permission::ManagePolicy)?;

        // 1) Cryptographic verify (tenant binding, epoch, version, expiry, signature)
        let verified = verify_manifest(
            new_manifest_bytes, new_sig,
            ProvisioningBlob::verified_tenant_id(),
            anti_rollback_counter.read_current_floor()?,
        )?;

        // 2) INVARIANT: recovery_invariant — at least one role must have ManagePolicy
        if !verified.any_role_has(Permission::ManagePolicy) {
            return Err(AuthzError::RecoveryInvariantViolated);
        }

        // 3) Atomic swap + audit the permission diff
        let old = self.current.read().await.clone();
        *self.current.write().await = Arc::new(verified.clone());
        anti_rollback_counter.bump_to(verified.policy_version)?;

        // 4) Structured audit event with diff (for SIEM)
        audit::emit_policy_reload(caller_ctx, &old, &verified).await?;

        Ok(())
    }
}

// In-flight long-command re-check:
//   - deploy_program / firmware_update / long-running ops re-check Permission against
//     CURRENTLY-ACTIVE manifest at each stage boundary (parse, verify, persist, activate)
//   - Short-running commands evaluate once at dispatch (no TOCTOU window)
//   - Re-check contract: src/commands/mod.rs every long-handler has explicit
//     `ctx.require_current(perm)?` calls; tests/invariants/long_cmd_stage_recheck.rs
```

### 9. Edge-side signature-verify DoS protection (AUDIT-HIGH-008 kapama)

```rust
// WHY: Attacker spams invalid ed25519 envelopes; edge CPU saturates → alarm deadlines (FR6) miss.
// WHAT: Pre-crypto structural checks + rate limit token bucket + signed size cap.
// INVARIANT: tests/invariants/verify_dos_bounded.rs — 10k invalid/sec for 60s; alarm deadline p99 < 250ms.

const EDGE_MAX_ENVELOPE_SIZE_BYTES: usize = 64 * 1024;  // 64KB manifest, 4KB command

pub async fn verify_envelope_rate_limited(
    bytes: &[u8],
    sig: &Signature,
    sender_cn: &str,  // from mTLS cert
) -> Result<VerifiedEnvelope, VerifyError> {
    // 1) Structural pre-checks (cheap) — size, JSON top-level schema
    if bytes.len() > EDGE_MAX_ENVELOPE_SIZE_BYTES {
        return Err(VerifyError::TooLarge);
    }
    let header = parse_header_prefix(bytes)?;  // reject unknown fields, check magic

    // 2) Token bucket per sender (persisted across reboots via SQLCipher)
    if !RATE_LIMITER.try_acquire(sender_cn, 1).await {
        return Err(VerifyError::RateLimitExceeded);
    }

    // 3) Only after cheap gates pass → ed25519 verify (~10µs on RPi 4)
    let verified = ed25519_verify(bytes, sig, &lookup_key(sender_cn, &header)?)?;

    Ok(verified)
}

// Rate limiter config (hardcoded in binary; config.yaml cannot relax):
const VERIFY_RATE_LIMIT_PER_SEC: u32 = 10;
const VERIFY_RATE_LIMIT_BURST: u32 = 30;
```

### 10. Monotonic wall-clock floor (AUDIT-MEDIUM-010 kapama)

```rust
// WHY: RTC backward-set attacker → expired manifest becomes valid again.
// WHAT: Persisted monotonic floor; forward-only; `now = max(wall, floor)`.
// INVARIANT: tests/invariants/time_never_regresses.rs — RTC set-backward + expired manifest → REJECT.

pub struct ClockAuthority {
    // Persisted to SQLCipher (read-protected); also NTS-synced when online.
    last_known_time_floor: AtomicI64,  // unix ms
}

impl ClockAuthority {
    pub fn now_with_floor(&self) -> i64 {
        let wall = chrono::Utc::now().timestamp_millis();
        let floor = self.last_known_time_floor.load(Ordering::Acquire);
        wall.max(floor)
    }

    pub fn bump_floor(&self, new_floor: i64) -> Result<(), ClockError> {
        // INVARIANT: forward-only
        let old = self.last_known_time_floor.load(Ordering::Acquire);
        if new_floor <= old { return Ok(()); }
        self.last_known_time_floor.store(new_floor, Ordering::Release);
        self.persist(new_floor)?;
        Ok(())
    }
}

// Expiry check: uses now_with_floor() not wall clock directly.
```

### 11. AuthorizedContext — honest tier claim (AUDIT-HIGH-005 kapama)

```rust
// WHY: pub(in crate::authz) is Rust-visibility, not type-level impossibility.
//      Tier-1 claim only holds under module-boundary discipline + CODEOWNERS + test invariant.
// WHAT: Honest labeling + tighter submodule scope + invariant test codified.

// File layout:
//   src/authz/
//     mod.rs                     // re-exports, NO AuthorizedContext::new access
//     context/                   // 2-file submodule — intentionally tiny, CODEOWNERS-gated
//       mod.rs                   // pub use AuthorizedContext; no other items
//       verify.rs                // ONLY caller of AuthorizedContext::new()
//     policy.rs, emergency.rs, manifest.rs, etc.

// Visibility:
pub struct AuthorizedContext { ... }
impl AuthorizedContext {
    // WHY: pub(super) means `crate::authz::context` submodule only — enforced by git diff reviewer.
    //      Combined with CODEOWNERS line, tier-1 + tier-3 hybrid claim is honest.
    pub(super) fn new(verified: VerifiedManifestClaims) -> Self { ... }
}

// .github/CODEOWNERS:
// /sens-api-gateway/src/authz/ @security-lead @okan
// /sens-api-gateway/src/authz/context/ @security-lead @okan

// tests/invariants/authorized_context_constructors.rs:
//   Parses src/authz/**/*.rs (ast-grep); asserts AuthorizedContext::new() is called from
//   exactly one location: `src/authz/context/verify.rs`. Any additional caller → CI fail.
```

**Label update:** §Consequences "tier-1 make-it-impossible" kaldırıldı; yerine "**tier-1 via module boundary + tier-3 via invariant test + process-gate via CODEOWNERS**" koyuldu. Honest taxonomy.

### 12. Audit log integrity (AUDIT-MEDIUM-013 kapama)

Detaylı tasarım ADR-020 (kapsam dahilinde audit HMAC chain + append-only + cloud anchor). Bu ADR'da kanca:

```rust
// WHY: ReadAuditLog emergency permission set'te; audit wipe ile breach forensics çöker.
// WHAT: HMAC chain'li append-only sink; cloud anchor periyodik; ADR-020'de full spec.
// INVARIANT: Bu ADR Accepted olmadan ADR-020 Proposed minimum olmalı.

impl AuditSink {
    // entry_N_hmac = HMAC-SHA256(audit_chain_key, entry_N-1_hmac || entry_N_payload)
    // cloud relay: edge/{device_id}/audit topic; offsite backup 7-year retention
}
```

**Dependency:** ADR-020 (Audit Log Integrity) — opened as DEC-019 in finding board, Faz 2 deadline.

---

## Alternatives Considered

### Alt-1 Plan A "JSON policy doc + string[] capabilities"
Tip-güvenlik yok, single-key blast radius, tenant binding yok, versioning yok. 3 agent validasyonu REDDET.

### Alt-2 OPA embedded
Binary ayak izi ARM'da 10-25 MB ağır; Rego DSL öğrenme eğrisi; policy bundle distribution pipeline gerekir. **Yeniden değerlendirme tetikleyicisi:** ADR-023 SL-3 + fleet 500+ cihaz.

### Alt-3 X.509 cert-based RBAC
500+ cihaz + 20+ rol cert management ergonomik değil; nöbet rotasyonunda mapping sürekli değişir; CRL distribution edge'de pratik değil.

### Alt-4 4-sabit-rol (Plan B V1)
Aquaculture rolleri çeşitli (veterinary/feed-tech/maintenance/shift/auditor); Emergency=safe-state-only O2 crash'te yetersiz.

---

## Consequences

### Positive
- **Tip güvenliği:** `Permission` enum compile-time bound; yanlış permission sahibi olmak IMPOSSIBLE
- **5-key blast radius:** firmware ↔ RBAC ↔ command root ↔ rescue ↔ emergency compromise ayrık
- **Per-operator two-person:** single-key platform compromise two-person'ı kıramaz
- **Sealed tenant:** plaintext config pivot kapalı; ADR-019 provisioning blob trust root
- **Anti-rollback:** TPM NV → RPMB → A/B slot counter; SD wipe replay attack kapalı
- **Unknown permission = REJECT:** silent-drop sınıfı kapatıldı; `min_edge_version` + `required_permissions`
- **Recovery invariant:** `ManagePolicy` self-lockout structurally impossible
- **Emergency binary-hardcoded:** widening compromise ile bile imkansız; O2 crash için EmergencyActuator:LifeSupport
- **DoS protection:** edge-side verify rate limit + size cap + structural pre-checks
- **Time monotonic floor:** RTC backward attack kapalı
- **Honest tier claims:** tier-1 + tier-3 + CODEOWNERS hybrid, prose yaldızı yok

### Negative
- **Platform iş yükü:** Per-operator key provisioning + HSM slot genişlemesi (per-tenant); custom_roles editor UI; manifest signing pipeline; staged rollout orchestration; audit log cloud relay + anchor
- **Implementation kod:** `src/authz/` ~2500-3000 satır (mod/policy/context/emergency/manifest/tests); `src/keystore/` rollback counter backends
- **ADR cross-dependencies:** ADR-019 (sealed tenant + A/B anti-rollback + canonical 7-slot key ceremony map) + ADR-020 (audit HMAC chain) + ADR-021 (key ceremony implementation of 7-slot canonical map: 5 RBAC/firmware + 1 program_signing + 1 provisioning) → ADR-018 Accepted için tümü ≥ Proposed
- **Offline grace + anti-rollback gerilim:** 180-gün offline + epoch rotation → tier-2/3 kayıt alanı büyüyebilir; Faz 2 capacity planning

### SL-3 readiness claim DELETED
Önceki revisyondaki "SL-3 hazırlığı" ifadesi kaldırıldı. Current design SL-2 **adversarial** hedefler. SL-3 için gerekli formal attestation + remote attestation + dm-verity ADR-023 (DEC-017) kapsamındadır.

---

## 7. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-018-FINDING-001 | CRITICAL | §3 sealed tenant | ProvisioningBlob (ADR-019); plaintext config kullanımı yasak; compile-time grep invariant |
| ADR-018-FINDING-002 | CRITICAL | §4 anti-rollback | TPM NV → RPMB → A/B slot counter; SD wipe replay fails |
| ADR-018-FINDING-003 | CRITICAL | §2 5-key + §5 emergency narrowing | Title/content tutarlı; emergency binary-hardcoded base set; widening impossible |
| ADR-018-FINDING-004 | CRITICAL | §7 per-operator + binds_to_policy_version | Platform compromise single-key → iki imza üretemez; version skew race reject |
| ADR-018-FINDING-005 | HIGH | §11 honest tier claim | tier-1 + tier-3 + CODEOWNERS hybrid; label düzeltildi |
| ADR-018-FINDING-006 | HIGH | §6 min_edge_version + required_permissions REJECT | Silent-drop sınıfı kapatıldı |
| ADR-018-FINDING-007 | HIGH | §8 recovery invariant + re-check | Self-lockout structurally impossible; long-cmd stage re-check |
| ADR-018-FINDING-008 | HIGH | §9 edge-side verify rate limit | 10/s token bucket; 64KB envelope cap; structural pre-checks |
| ADR-018-FINDING-009 | HIGH | §5 EmergencyActuator + O2 acceptance | LifeSupport class + binary-hardcoded tag allowlist + rate limit; O2 crash E2E test |
| ADR-018-FINDING-010 | MEDIUM | §10 monotonic floor | Wall-clock forward-only floor; persisted |
| ADR-018-FINDING-011 | MEDIUM | §6 constraints anchored glob | Anchored patterns, no `**`; compile-time tag registry validation |
| ADR-018-FINDING-012 | MEDIUM | §6 epoch + version tuple | `(signing_key_epoch, policy_version)`; rotation bumps epoch |
| ADR-018-FINDING-013 | MEDIUM | §12 ADR-020 dependency | HMAC chain + append-only + cloud anchor; ADR-020 BLOCKER |
| ADR-018-FINDING-014 | LOW | §2 5-key table | Rescue firmware pubkey scope: updater::rescue; §5 tablo |
| ADR-018-FINDING-015 | LOW | Acceptance criteria | Compile-time trait bound yerine grep (test harness) |
| ADR-018-FINDING-016 | INFO | §11 honest labels | "tier-3 make-it-detectable, log warn" silent-drop için kaldırıldı |
| ADR-018-FINDING-017 | INFO | Owner: Okan + PROC-001 | Bulk TBD sweep finding board'da |
| ADR-018-FINDING-018 | INFO | (stilistik) | Karma TR/EN prose kabul; code identifier'lar EN, prose TR |
| AUDIT-002 | HIGH | §11 | `pub(super)` 2-file submodule + CODEOWNERS + invariant test |
| AUDIT-003 | MEDIUM | §2 | "3-Key Segregation" → "5-Key Segregation (3 online + 2 factory)"; tablo tam |
| AUDIT-004 | MEDIUM | Throughout | Forward refs `ADR-019 (DEC-002)`, `ADR-020 (DEC-019 TBD)`, `ADR-021 (DEC-008)`, `ADR-023 (DEC-017)` annotated |
| AUDIT-005 | MEDIUM | Owner: Okan + PROC-001 | TBD sweep finding board'da |

---

## 13. Implementation Plan (Plan §5 Faz 2)

**Hafta 6-9:**

1. **Sprint 6.1** — `src/authz/` iskelet + `Permission` enum + `AuthorizedContext` tiny submodule + CODEOWNERS
2. **Sprint 6.2** — ProvisioningBlob parser + sealed tenant binding + `tests/invariants/tenant_binding_sealed.rs`
3. **Sprint 7.1** — Manifest parser + ed25519 verify + epoch/version tuple + recovery invariant check + `required_permissions` fail-closed
4. **Sprint 7.2** — AntiRollbackCounter trait + TPM backend + RPMB backend + A/B slot backend + tier fallback telemetry
5. **Sprint 7.3** — Hot-reload + in-flight re-check + audit diff emit
6. **Sprint 8.1** — Per-operator command envelope verify + two-person distinct-key invariant + version binding
7. **Sprint 8.2** — Emergency module + binary-hardcoded narrowing + EmergencyActuator + O2 E2E acceptance
8. **Sprint 8.3** — Edge-side verify rate limit + DoS invariant test
9. **Sprint 9.1** — 8+ invariant test green + Kani candidate (rbac_non_bypass)
10. **Sprint 9.2** — SL-2 adversarial re-audit (2 bağımsız güvenlik agent) + gap close

**Acceptance criteria (Faz 2 close):**
- `grep "AuthorizationPolicy\|AuthorizedContext" sens-api-gateway/src/commands/` > 0 in every file
- 5 ayrı ed25519 pubkey const binary'de embed (AST verify)
- `tests/invariants/rbac_key_segregation.rs` green
- `tests/invariants/authz_on_commands.rs` green
- `tests/invariants/tenant_binding_sealed.rs` green
- `tests/invariants/rollback_protection_storage.rs` green
- `tests/invariants/recovery_invariant_preserved.rs` green
- `tests/invariants/two_person_distinct_keys.rs` green
- `tests/invariants/two_person_version_binding.rs` green
- `tests/invariants/emergency_cannot_widen.rs` green
- `tests/invariants/long_cmd_stage_recheck.rs` green
- `tests/invariants/verify_dos_bounded.rs` green
- `tests/invariants/time_never_regresses.rs` green
- `tests/invariants/authorized_context_constructors.rs` green
- IEC 62443 SL-2 **adversarial** re-audit: FR1/FR2/FR5/FR6 green
- O2 crash E2E: emergency credential + aerator override + audit trail
- Status → Accepted

---

## References

- NIST SP 800-162 "Guide to Attribute Based Access Control (ABAC)"
- IEC 62443-3-3 SL-2 FR2 (Use Control), FR5 (Restricted Data Flow), FR6 (Timely Response)
- TCG TPM 2.0 Library Specification — NV counter semantics
- JEDEC eMMC 5.1 — Replay Protected Memory Block (RPMB)
- `/var/aqua-saas/sens-api-gateway/src/commands.rs` L250-515 (ungated dispatch — Faz 2 target)
- `/var/aqua-saas/sens-api-gateway/src/config.rs` L186-188 (plaintext tenant_id — sealed per §3)
- `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.4 D-4 REVİZE MAJOR
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-5, §3.1, §5 Faz 2
- ADR-017 (ST Bytecode — RbacGatedWriter + AuthorizedContext consumer)
- ADR-019 (DEC-002) — Firmware Signing + A/B Partition + **Provisioning Blob sealed tenant binding** (BLOCKER)
- ADR-020 (DEC-019) — Audit Log HMAC Chain (BLOCKER)
- ADR-021 (DEC-008) — Platform Key Ceremony (canonical 7-slot map per ADR-019 §1: 5 RBAC/firmware + 1 program_signing + 1 provisioning) (BLOCKER)
- ADR-023 (DEC-017) — SL-3 Upgrade Path (remote attestation, dm-verity, secure boot)
