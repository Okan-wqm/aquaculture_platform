# ADR-020: Audit Log HMAC Chain + Hybrid Ed25519 Forensic Proof + Cloud Anchor + Tamper-Resistant Storage

**Status:** Proposed (opened 2026-04-19; revised post-audit 2026-04-19 — 4 CRITICAL + 5 HIGH + 6 MEDIUM closed in §14 closure table; target Accepted 2026-05-03)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + security-auditor + compliance-expert + auth-security-expert
**Owner:** Okan (temp — PROC-001)
**Deadline:** 2026-05-03 — ADR-018 §12 BLOCKER
**Related findings:** SEC-007, DEC-019, ADR-017 §13 consumer, ADR-018 §5 + §11 consumer, ADR-019 §12 FirmwareRollbackEvent, ADR-020-FINDING-001..019 (post-audit closure)
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-11, §5 Faz 2; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §2.5 SEC-007

---

## Context (WHY)

### Problem (SEC-007)
Mevcut `scada_db.audit_log` tablosu post-execution yazılıyor; tamper-evident değil; persistent sink yok; cloud sync yok; HMAC chain yok. Saldırgan root'la DB rows silebilir, regulatory forensics çöker. scada-display feature OFF → audit yazımı kapalı.

### Downstream consumer ADR'lar
- ADR-017 §13: ST bytecode deploy/rollback/undeploy, WriteTag deny, force, debug step
- ADR-018 §5 + §11: ReadAuditLog permission, policy reload diff, two-person integrity, emergency mode, signature rejection
- ADR-019 §12: FirmwareRollbackEvent, install, rescue cutover

### Post-audit context
İlk taslak security-auditor tarafından **4 CRITICAL + 5 HIGH + 6 MEDIUM + 4 LOW** bulgu ile NEEDS_REVISION. Verdict BLOCK değil çünkü architectural foundation doğru; ama 4 CRITICAL kapatılmadan Accepted mümkün değil. Bu revizyon §14 closure table ile tümünü kapatır.

### ADR-021 decoupling (FINDING-002 kapama)
İlk taslak cloud anchor signing'ı ADR-021 (BLOCKED) slot 8'e defer ediyordu → transitive BLOCKED. V2: **interim anchor key ceremony bu ADR içinde tanımlanır** (Option A); ADR-021 unblocked olduğunda slot 8 formal yerine geçer, interim key retire edilir. Decoupled.

---

## Decision (WHAT)

**1. HMAC-SHA256 chain + per-epoch ed25519 attestation signing. 2. Append-only enforced via `chattr +a` + `CAP_LINUX_IMMUTABLE` drop. 3. TPM NV / RPMB / signed-counter entry_id anchoring (tail truncation detection). 4. Interim offline-HSM anchor key ceremony (decouples from ADR-021). 5. Severity-per-variant + CRITICAL buffer reservation + INFO rate limit + safety-path carve-out. 6. `audit-verify` CLI uses published device ed25519 pubkey, NOT master key (forensic independence). 7. Append-only file + fsync + `create` rotation (not `copytruncate`). 8. Cloud relay MQTT + consumer idempotency (not exactly-once). 9. Cryptographic erasure via per-tenant pseudonymization (GDPR Art 17 + KVKK Art 7). 10. v1 re-encryption at migration (key lineage continuity). 11. Stable-Rust negative-trait-based `AuditSafe` + enum-closed schema (no Custom escape hatch).**

### 1. Chain structure + hybrid cryptographic binding

```rust
// WHY: HMAC fast (5μs) for hot-write path; ed25519 per-epoch for forensic independence
//      (verifier uses device pubkey, not master key — FINDING-003 kapama).
// INVARIANT: tests/invariants/audit_chain_continuous.rs — chain gaps, HMAC mismatch,
//            epoch transitions CI'da yakalanır; reordering post-compromise cloud anchor'da tespit.

#[derive(Serialize, Deserialize)]
pub struct AuditEntry {
    pub entry_id: u64,
    pub device_id: [u8; 16],
    pub tenant_pseudonym: [u8; 32],      // §10 — HMAC(tenant_erasure_key, tenant_id)
    pub hmac_epoch: u32,
    pub timestamp_unix_ms: i64,          // monotonic-floor-adjusted (ADR-018 §10)
    pub timestamp_certainty: TimestampCertainty,  // FINDING-017: Unsynced|MonotonicOnly|NTPSynced|GPSSynced
    pub actor_pseudonym: [u8; 32],       // §10 — HMAC(tenant_erasure_key, operator_id)
    pub action: AuditAction,             // §7 closed enum
    pub severity: AuditSeverity,         // Critical|High|Medium|Info|Debug — compile-derived (FINDING-004)
    pub outcome: AuditOutcome,
    pub subject: AuditSubject,
    pub reason: Option<SanitizedReasonEnum>, // §10 — enum-bounded, no free text
    pub correlation_id: Option<[u8; 16]>, // derived from first entry_hmac (FINDING-015)

    pub prev_hmac: [u8; 32],
    pub entry_hmac: [u8; 32],
}

// Genesis entry (entry_id=0):
//   prev_hmac = HMAC(master, "genesis" || device_id || provisioning_nonce_from_blob)
//   (FINDING-016 — pins to specific provisioning event, not [0u8; 32])

// Epoch rotation entry:
//   AuditAction::HmacEpochRotated { old_epoch, new_epoch, old_key_final_hmac,
//                                    per_epoch_ed25519_sig: [u8; 64] }
//   per_epoch_ed25519_sig = ed25519_sign(device_audit_attestation_key,
//                                         old_key_final_hmac || old_epoch || boot_nonce)
//   (FINDING-003 — forensic verifier uses device_audit_attestation_pubkey, not master key)
```

### 2. HMAC key derivation + per-epoch ed25519 attestation

```rust
// WHY: HMAC secrecy protects live write path; ed25519 attestation lets forensic auditor
//      verify chain integrity with ONLY the device's published pubkey (FINDING-003).
// WHAT: Device generates ed25519 audit_attestation_keypair at provisioning;
//       private key TPM-sealed; public key published to cloud anchor + firmware bundle.

fn derive_audit_hmac_key(master: &Secret<MasterKey>, epoch: u32) -> Secret<AuditHmacKey> {
    let salt = b"audit-hmac-chain-v2";
    let info = format!("epoch-{epoch}").as_bytes();
    let prk = hkdf_extract::<Sha256>(Some(salt), master.expose());
    let okm = hkdf_expand::<Sha256>(&prk, info, 32);
    Secret::new(AuditHmacKey(okm))
}

// Device audit attestation keypair (one per device, lifetime-constant or rotated with master):
fn derive_device_audit_attestation_keypair(
    master: &Secret<MasterKey>,
    device_id: &[u8; 16],
) -> (SigningKey, VerifyingKey) {
    let salt = b"audit-attestation-ed25519-v1";
    let info = device_id;
    let prk = hkdf_extract::<Sha256>(Some(salt), master.expose());
    let okm = hkdf_expand::<Sha256>(&prk, info, 32);
    let signing_key = SigningKey::from_bytes(&okm);
    let verifying_key = signing_key.verifying_key();
    (signing_key, verifying_key)
}

// Publication path:
// - Provisioning ceremony: device_audit_attestation_pubkey published to cloud anchor registry
// - Anchor registry signed by interim_anchor_signing_key (§5a)
// - Forensic CLI fetches pubkey from anchor registry; verifies with that key, not master

// Rotation triggers:
// - Master key rotation → HMAC key rotates; attestation key may stay (HKDF deterministic from
//   device_id + master; if master rotates, attestation key changes but with documented continuity)
// - Compromise → full rotation + new attestation key registered
// - 180-day scheduled

// Epoch transition (with ed25519 attestation — FINDING-003):
// 1. Emit HmacEpochRotated marker with per_epoch_ed25519_sig over old_epoch terminal state
// 2. Derive NEW HMAC key HKDF(master, "epoch-{N+1}")
// 3. Next entry's prev_hmac = HMAC_NEW(marker_entry)
// 4. Persist epoch_keys to SQLCipher (encrypted under master)
// 5. Attestation signature published to cloud anchor — tamper-evident even if HMAC key leaks
```

### 3. Append-only storage — chattr + capability drop (FINDING-001 kapama)

```
Partition: /dev/mmcblk0p5 (ext4 — ADR-019 §5)
File: /var/log/suderra/audit.log
Mode: 0640 suderra:suderra
Mount options: nosuid,nodev,noexec,noatime

### §3a Filesystem immutability enforcement (FINDING-001 CRITICAL closure)

INVARIANT: agent compromise cannot remove append-only attribute.

Architecture:
  1. New systemd unit `suderra-audit-init.service` (Type=oneshot, User=root):
     - Sets chattr +a on /var/log/suderra/audit.log (+ parent dir chattr +a)
     - Configures ambient CAP_LINUX_IMMUTABLE for `suderra-audit-rotator` UID
     - Drops all caps from its own process; exits
  2. `suderra-agent.service` runs as UID suderra WITHOUT CAP_LINUX_IMMUTABLE:
     - Cannot call chattr -a to remove append-only bit
     - Cannot truncate/unlink (EPERM from kernel immutable check)
     - Can only append (O_APPEND) — enforced by kernel
  3. `suderra-audit-rotator.service` (User=suderra-audit-rotator, ambient CAP_LINUX_IMMUTABLE):
     - Runs logrotate
     - During rotation: chattr -a briefly, rename + create new, chattr +a, reapply permissions
     - Window between chattr -a and chattr +a: <1s; advisory lock fcntl F_SETLK prevents
       agent writes during this window (FINDING-013 close)
  4. `suderra-agent` opens log with O_APPEND|O_CLOEXEC (belt + braces)

systemd unit (suderra-agent.service) caps:
  CapabilityBoundingSet=
  AmbientCapabilities=
  NoNewPrivileges=true
  (explicitly empty — no caps whatsoever)

systemd unit (suderra-audit-rotator.service) caps:
  CapabilityBoundingSet=CAP_LINUX_IMMUTABLE
  AmbientCapabilities=CAP_LINUX_IMMUTABLE
  ReadWritePaths=/var/log/suderra
  (minimal — only chattr capability)

INVARIANT: tests/invariants/audit_log_chattr_append.rs
  - Boot both services
  - Assert `lsattr /var/log/suderra/audit.log` shows 'a' flag
  - Assert `getpcaps <suderra-agent-pid>` shows empty caps
  - Assert `getpcaps <suderra-audit-rotator-pid>` shows only CAP_LINUX_IMMUTABLE
  - Attack simulation: agent attempts unlink/truncate/chattr -a → EPERM
  - Attack simulation: agent attempts O_WRONLY|O_TRUNC open → EPERM
```

**Write pipeline (unchanged):**
1. audit::emit(event) → AuditEntry
2. Compute entry_hmac (HMAC key epoch N)
3. Append bincode (pinned v1.3.3 — FINDING-019 closure) to audit.log via O_APPEND
4. fsync(fd) — SLO p99 < 5ms on industrial eMMC (criterion bench gate — FINDING-012)
5. Update TPM NV counter (§9a — FINDING-005) `latest_entry_id`
6. Return to caller

### 4. Severity + backpressure (FINDING-004 CRITICAL closure)

**Severity-per-variant (compile-time-enforced via derive macro; FINDING-009 stable-Rust path):**

```rust
#[derive(Serialize, Deserialize, AuditActionDerive)]
pub enum AuditAction {
    #[severity(Critical)] HmacEpochRotated { ... },
    #[severity(Critical)] FirmwareRollback { ... },
    #[severity(Critical)] FirmwareRescueCutover { ... },
    #[severity(Critical)] EmergencyModeEntered { ... },
    #[severity(Critical)] EmergencyActuatorWrite { ... },
    #[severity(Critical)] TwoPersonRejected { ... },
    #[severity(Critical)] SignatureRejected { ... },
    #[severity(Critical)] PolicyVersionRegressionAttempted { ... },
    #[severity(Critical)] TenantMismatchRejected { ... },
    #[severity(Critical)] StProgramCrashed { ... },
    #[severity(Critical)] ProvisioningBlobCorrupted { ... },
    #[severity(Critical)] TpmUnsealFailed { ... },
    #[severity(Critical)] AuditBufferOverflow { ... },
    #[severity(Critical)] AuditRateLimited { ... },

    #[severity(High)] PolicyReloaded { ... },
    #[severity(High)] StBytecodeDeployed { ... },
    #[severity(High)] StBytecodeRolledBack { ... },
    #[severity(High)] StWriteTagDenied { ... },
    #[severity(High)] FirmwareInstalled { ... },
    #[severity(High)] ReProvisioningCompleted { ... },
    #[severity(High)] TwoPersonSecondarySigned { ... },
    #[severity(High)] ForceValueApplied { ... },
    #[severity(High)] ForceValueRevoked { ... },
    #[severity(High)] CommandRejected { ... },
    #[severity(High)] EmergencyModeExited { ... },

    #[severity(Medium)] GenesisChainInit,
    #[severity(Medium)] LogRotated,
    #[severity(Medium)] StBytecodeUndeployed { ... },
    #[severity(Medium)] KeystoreBackendSelected { ... },
    #[severity(Medium)] TpmUnsealSucceeded,
    #[severity(Medium)] CommandExecuted { ... },
    #[severity(Medium)] ProvisioningBlobLoaded { ... },
    #[severity(Medium)] WatchSessionOpened { ... },
    #[severity(Medium)] WatchSessionClosed { ... },
    #[severity(Medium)] StDebugStepTriggered { ... },

    #[severity(Info)] AuthorizedContextCreated { ... },
    #[severity(Info)] SignatureVerified { ... },
    #[severity(Info)] PermissionChecked { ... },
    #[severity(Info)] CommandReceived { ... },
    #[severity(Info)] TwoPersonRequested { ... },
    // NOTE: Custom { params } REMOVED (FINDING-010) — new variants require ADR amendment
}

pub enum AuditSeverity { Critical, High, Medium, Info, Debug }
```

**Buffer policy (FINDING-004 closure):**

```yaml
# /etc/suderra/audit-buffer.yaml (signed via DEC-013 config.yaml.sig)
buffer:
  max_size_bytes: 1073741824  # 1 GB
  reservations:
    critical_pct: 30           # 30% buffer always reserved for CRITICAL entries
    high_pct: 40
    medium_pct: 20
    info_pct: 10                # strict cap; overflow triggers INFO rate-limit
  rate_limits_per_source_per_sec:
    Info: 10
    Debug: 5
    Medium: 100
    High: unlimited
    Critical: unlimited
  overflow_policy: drop_oldest_non_critical | fail_closed_halt_writes_not_safety | never_overflow

# safety-path carve-out (FINDING-004 interaction with ADR-018 §5):
# fail_closed_halt_writes_not_safety:
#   - Halts: command acceptance path, deploy/rollback, policy reload, bytecode dispatch
#   - NEVER halts: EmergencyActuator writes (ADR-018 §5), SafeStateTrigger, audit emission itself,
#                  safety-critical periodic scan cycle reads/writes
#   - Rationale: operational halt OK; safety-halt NOT OK — fish die in hours
```

**INFO rate limiting prevents amplification:**
```rust
// Token bucket per (source_id, severity); source_id = operator_pseudonym | subsystem_id
// INFO tokens refill 10/s; burst 30
// Overflow: single AuditRateLimited { source, dropped_count, window_secs } Critical entry
//           (itself rate-limited to 1/min/source to prevent cascading critical flood)
```

**INVARIANT: tests/invariants/audit_backpressure_critical_preserved.rs**
- Fuzz 1M INFO entries (rate-limiter + severity classifier engaged)
- Assert all N injected CRITICAL entries retained
- Assert EmergencyActuator path still accepts commands after buffer fills
- Assert safety-stop path never blocked

### 5. Append-only file + `create` rotation (FINDING-013 closure)

Replace `copytruncate` with `create` + HUP signal:

```
/etc/logrotate.d/suderra-audit:
/var/log/suderra/audit.log {
    rotate 90
    daily
    compress
    delaycompress
    missingok
    notifempty
    create 0640 suderra suderra
    sharedscripts
    postrotate
        # Run as suderra-audit-rotator (ambient CAP_LINUX_IMMUTABLE):
        /usr/bin/suderra-audit-rotate-finalize
        # Signals agent to reopen fd; agent locks writes via fcntl advisory during rotation
        kill -HUP $(cat /run/suderra-agent.pid)
    endscript
}

# suderra-audit-rotate-finalize:
#   1. Flock advisory lock on /run/suderra-audit-rotate.lock
#   2. chattr -a /var/log/suderra/audit.log.<date>  (old file)
#   3. chattr +a /var/log/suderra/audit.log         (new file)
#   4. suderra-audit-verify quickcheck --file audit.log.<date>
#   5. Flock release; kill -HUP agent
#   6. Agent reopens fd with O_APPEND on new file; resumes writes
```

Invariant: `tests/invariants/audit_log_rotation.rs` — fuzz write-during-rotation; 0 entries lost/corrupted.

### 5a. Interim offline anchor key ceremony (FINDING-002 CRITICAL closure — decouples from ADR-021)

**Problem:** ADR-020 ilk taslağı cloud anchor signing'i ADR-021 slot 8'e defer ediyordu. ADR-021 BLOCKED → transitive BLOCK. V2: interim ceremony bu ADR scope'unda.

**Interim anchor ceremony (valid until ADR-021 unblocked):**

```
Scope: Daily Merkle root signing for audit anchor transparency log.

Key: interim_audit_anchor_signing_key (ed25519)
Storage: YubiHSM 2 Nano (FIPS variant — YHSM2-FIPS), stored in operator-controlled office safe
         NOT in AWS / NOT in platform datacenter (platform-insider threat excluded)
Ceremony: 2-eye (security lead + platform owner) + legal counsel witness
          At ceremony: key generated inside YubiHSM (never in software memory)
          Public key extracted, signed by platform_owner_ed25519_personal_key, published:
            - Firmware bundle (pinned in device binary)
            - Public GitHub repository (docs/security/anchor-pubkey.pem)
            - Certificate Transparency-style Sigsum log submission
Usage: Daily automated job signs Merkle root via YubiHSM (office connected, engineer approves)
       24h SLO; missed day → HIGH alarm (§5b liveness)
Rotation: 365-day schedule; compromise → immediate rotation + ADR-021 slot 8 adoption if unblocked
Retirement plan: ADR-021 unblocked → slot 8 daily_anchor_signing_key ceremony supersedes;
                 interim key revoked via signed revocation statement in Sigsum log

INVARIANT: tests/invariants/interim_anchor_key_published.rs
  - Binary-embedded INTERIM_ANCHOR_PUBKEY matches docs/security/anchor-pubkey.pem SHA-256
  - Sigsum log entry for publication exists and is verifiable
```

**Decoupling:** ADR-020 Accepted artık ADR-021 unblocking'i BEKLEMİYOR. ADR-021 resolved olduğunda slot 8 yerine geçer (backward-compat verification: old entries signed by interim key, new by slot 8; verifier accepts both per epoch).

### 5b. Cloud anchor design + liveness SLO (FINDING-014 closure)

**Merkle root daily anchor:**
- Scope: Per-tenant, per-day; all entries from that tenant in 24h window
- Tree: sorted by (device_id, entry_id) tuple; SHA-256 intermediate nodes
- Root: signed by interim_audit_anchor_signing_key (§5a)
- Publication: (1) tenant-scoped S3 bucket, (2) Sigsum append-only CT-style log, (3) signed anchor registry (tenant-facing API)

**Liveness SLO:**
```
Device polls anchor every 24h + 6h grace
  0-24h : normal
  24-30h: warn alarm (operator notification)
  30-48h: HIGH alarm (critical path status red)
  48-72h: CRITICAL alarm + optional fail_closed_halt_writes_not_safety (signed config)
  >72h  : device refuses to start write-path commands until anchor resumes
```

**Merkle proof bandwidth:**
- Device polls at 24h cadence; one request/response: ~2 KB (root + inclusion proof for latest entry_id)
- Intermittent connectivity: device caches last successful anchor + proof for 72h; re-checks on reconnect
- Fleet of 500 devices × 2 KB/day = 1 MB/day cloud egress (trivial)

### 6. `audit-verify` CLI — hybrid verification (FINDING-003 CRITICAL closure)

```rust
// WHY: Forensic auditor MUST NOT need device master key.
// WHAT: Verify HMAC chain internal consistency + verify per-epoch ed25519 attestation with
//       device's PUBLISHED pubkey (from anchor registry).
// INVARIANT: tests/invariants/audit_verify_no_master_key.rs — CLI runs full verify
//            without access to any Secret<MasterKey>; fails closed if accidentally required.

fn main() -> Result<()> {
    let args = CliArgs::parse();

    // NO MASTER KEY LOADING. Fetch device pubkey from anchor registry instead.
    let device_attestation_pubkey = anchor_registry::fetch_device_pubkey(
        args.device_id,
        &args.anchor_endpoint_or_local_cache,
    )?;

    // Load audit.log stream
    let log_stream = audit::load_all_entries(&args.log_dir)?;

    // Walk chain for internal consistency
    let mut prev_hmac = compute_genesis_hmac(args.device_id, args.provisioning_nonce)?; // §1 Genesis binding
    let mut current_epoch = 0u32;
    let mut verified = 0u64;
    let mut issues: Vec<ChainIssue> = Vec::new();

    for entry in log_stream {
        // Check prev_hmac link (chain continuity — internal consistency)
        if entry.prev_hmac != prev_hmac {
            issues.push(ChainIssue::ChainBroken { entry_id: entry.entry_id, ... });
        }

        // WITHOUT master key, cannot verify entry_hmac directly.
        // Instead, verify per-epoch ed25519 attestation at each HmacEpochRotated marker:
        if let AuditAction::HmacEpochRotated { old_epoch, new_epoch, old_key_final_hmac,
                                                per_epoch_ed25519_sig } = &entry.action {
            // Verify attestation with device's published pubkey
            let attested_message = compose_epoch_attestation_message(
                *old_epoch, *old_key_final_hmac, /* boot_nonce */
            );
            device_attestation_pubkey
                .verify_strict(&attested_message, &Signature::from_bytes(per_epoch_ed25519_sig)?)
                .map_err(|_| ChainIssue::EpochAttestationInvalid { epoch: *old_epoch })?;
            current_epoch = *new_epoch;
        }

        prev_hmac = entry.entry_hmac;
        verified += 1;
    }

    // Cross-check with cloud anchor (Merkle proof)
    if args.verify_anchor {
        let anchor = cloud_anchor::fetch_for_tenant_day(tenant_id, day)?;
        // Verify interim_audit_anchor_signing_pubkey (or slot 8 post-ADR-021)
        verify_anchor_signature(&anchor, &INTERIM_ANCHOR_PUBKEY)?;
        // Check entry_hmac appears in Merkle tree
        cross_check_anchor_inclusion(&log_stream, &anchor)?;
    }

    match issues.len() {
        0 => println!("OK — {verified} entries; chain continuity verified;
                       {} epoch attestations verified with device pubkey;
                       anchor cross-check: {}",
                      epoch_count, anchor_result),
        _ => print_and_exit_1(&issues),
    }
    Ok(())
}
```

**Forensic workflow (honest):**
- Auditor receives: (1) audit.log archive (copied off device, possibly with rotation files), (2) device_id, (3) provisioning_nonce (from ProvisioningBlob — visible under Art 30 SoR)
- Auditor fetches: device_attestation_pubkey from anchor registry (public), anchor snapshots
- Auditor runs: `suderra-audit-verify --device-id <...> --log-dir <...> --anchor-endpoint <...>`
- Result: chain internal consistency + per-epoch ed25519 attestation + anchor Merkle inclusion proof
- **What the verifier CANNOT do:** compute fresh HMACs (master key not available). Can detect tampering via (a) chain breaks, (b) invalid ed25519 attestations, (c) missing anchor inclusion.
- **Residual risk:** Tampering WITHIN an epoch AFTER master-key compromise AND BEFORE next epoch rotation is undetectable by internal means; detectable only via anchor inclusion (if tampered entries were relayed before tampering). Documented threat-model boundary (§9).

### 7. Event schema — closed enum (Custom removed — FINDING-010 closure)

Detaylı liste §4'teki severity-per-variant bloğunda. `Custom { params: serde_json::Value }` variant **kaldırıldı**. Yeni event türleri ADR amendment + `AuditAction` enum extension gerektirir (compile-forced schema governance). Event schema extensibility için ayrı `AuditActionV2` enum + upcaster pattern (`@platform/event-contracts` precedent).

### 8. Performance + benchmarks (FINDING-012 closure)

Reference hardware: RPi CM4 + 32 GB Samsung KLM8G1GETF-B041 industrial eMMC (pSLC mode)
Filesystem: ext4, mount options `data=ordered,commit=5,barrier=1,noatime`
Kernel: 6.1 LTS (rpi-6.1.y branch)
Rust: 1.78+; criterion 0.5+

Benchmarks (criterion, CI gate — ±10% regression fails):
- Append + fsync: p50 < 2ms, p99 < 5ms, p99.9 < 15ms
- HMAC-SHA256 (500 B payload): < 10 μs
- Ed25519 per-epoch attestation sign: < 200 μs (once per epoch rotation — rare)
- audit-verify throughput: > 50k entries/sec (verify HMAC chain + ed25519 attestations)
- MQTT relay latency: p99 < 2s under normal; offline buffer spill < 100 ms/entry

Overflow behavior under sustained write burst (10 cmds/sec × 100 devices):
- Local fsync keeps up; MQTT relay queues ~500 entries/device/hour
- Offline buffer 1 GB supports ~72h disconnect at peak rate
- `fail_closed_halt_writes_not_safety` triggers at 90% buffer fill (safety path unaffected)

### 9. Tamper detection + threat model boundary (FINDING-006 closure)

**Detection paths (expanded):**
1. Local HMAC chain break → audit-verify internal consistency check
2. Cloud anchor Merkle inclusion mismatch → cloud-side validation
3. Timestamp regression (clock backward + monotonic floor) → §9 existing check
4. Per-epoch ed25519 attestation invalid → §6 CLI check (detects master-key-compromise forge)
5. TPM NV counter regression → §9a — detects tail truncation (FINDING-005 closure)
6. Anchor liveness SLO miss → §5b — 24-72h cascading alarms

**Threat model boundary (explicit):**

| Threat | Detection | Response time |
|---|---|---|
| Mid-chain entry deletion (no key) | Chain HMAC break | Immediate (on next verify) |
| Tail truncation (no key) | TPM NV counter (§9a) | Immediate (on boot + periodic) |
| Entry reordering (no key) | Chain HMAC break | Immediate |
| Full master-key compromise → forge middle | Per-epoch ed25519 attestation on PRIOR epoch | Next rotation (180 days) OR cloud anchor (24h) |
| Full master-key compromise → forge tail (unrelayed) | Cloud anchor exclusion | Next anchor (24h) |
| Cloud-side insider tampers S3 objects | Sigsum CT log cross-check | On next CT mirror fetch (hours) |
| Both master + interim anchor key compromised | NOT DETECTABLE without external attestation | Requires SL-3 remote attestation (ADR-023) |

**Documented residual risk:** Within-epoch tampering after master-key compromise + before cloud relay is undetectable by device-local mechanisms. SL-2 baseline accepts this; ADR-023 SL-3 remote attestation closes it.

### 9a. TPM NV counter for tail-truncation detection (FINDING-005 CRITICAL closure)

```rust
// WHY: Tail deletion + state-file rewrite = locally-consistent shorter chain;
//      only TPM monotonic counter makes regression detectable.
// WHAT: TPM NV index holds latest_entry_id; increments on every durable write.
// INVARIANT: tests/invariants/audit_tail_truncation_detected.rs — simulated
//            tail delete + state rewrite → boot-time check catches counter regression.

pub trait AuditEntryIdCounter: Send + Sync {
    fn read(&self) -> Result<u64, StorageError>;
    fn increment(&self) -> Result<u64, StorageError>;  // atomic read-modify-write
    fn tier(&self) -> RollbackProtectionTier;
}

// Tier 1: TPM NV counter (NV index 0x1500010)
//   - Defined with TPM2_NV_DefineSpace policy: write requires PolicyAuth bound to suderra-agent
//   - Increment via TPM2_NV_Increment (atomic on hardware)
//   - Read via TPM2_NV_Read (no policy required)
// Tier 2: RPMB counter (eMMC replay-protected)
// Tier 3: Signed monotonic counter file (ed25519 per-device audit_attestation_key over
//          {entry_id, boot_nonce, timestamp})
//
// TIER 3 WEAKNESS (explicit — FINDING-005 closure limitation):
//   Tier 3 is structurally equivalent to the "master key compromised" threat class in §9:
//   audit_attestation_key is HKDF-derived from master (§2), so master compromise →
//   attestation key compromise → counter forgery capability. Tier 3 therefore does NOT
//   add protection beyond what the chain itself provides post-master-compromise.
//   Tier 3 is a last-resort availability path (device ships, TPM absent, RPMB absent);
//   operator MUST accept this limitation via signed config i_accept_tier3_counter_risk.
//   SL-2 adversarial target REQUIRES Tier 1 (TPM NV) OR Tier 2 (RPMB) in production.

// Boot-time check:
//   assert(tpm_counter >= latest_log_entry_id);
//   if tpm_counter > latest_log_entry_id:
//     CRITICAL alarm "tail truncation detected";
//     entry_ids [latest_log_entry_id+1 .. tpm_counter] were written but are missing locally;
//     query cloud anchor for these entry_ids; if present, restore; if not, tamper confirmed

// Every audit::emit path:
//   1. entry_id = counter.increment()  // atomic TPM NV increment
//   2. write entry with entry_id
//   3. fsync
//   (If step 2 or 3 fails: counter is ahead; next boot detects gap; resolved via relay replay)
```

### 10. Privacy — pseudonymization + legal basis (FINDING-007 HIGH closure)

**Cryptographic erasure via per-tenant pseudonymization:**

```rust
// WHY: GDPR Art 17 + KVKK Art 7 right-to-erasure; 7-year retention conflict.
// WHAT: Actor + tenant identifiers stored as HMAC pseudonyms; tenant holds erasure_key.
//       Key destruction renders audit entries unlinkable (EDPB-recognized crypto erasure).
// INVARIANT: tests/invariants/audit_erasure_via_key_destruction.rs — destroying
//            tenant_erasure_key renders entries to show [u8; 32] pseudonyms with no plaintext.

fn actor_pseudonym(tenant_erasure_key: &Secret<TenantErasureKey>, operator_id: &str) -> [u8; 32] {
    hmac_sha256(tenant_erasure_key.expose(), operator_id.as_bytes())
}
// tenant_erasure_key is platform-held per-tenant; can be destroyed on Art 17 DSR
// Chain HMAC + entry_hmac remain valid (regulatory integrity preserved);
// only the human-identifiability is erased

// Reason field — enum-bounded (no free text):
#[derive(Serialize, Deserialize)]
pub enum SanitizedReasonEnum {
    // Deploy/rollback
    ProgramUpgradeRoutine,
    ProgramUpgradeEmergency,
    RollbackHealthCheckFailed,
    RollbackOperatorRequested { ticket_ref: TicketRef },
    // Force/unforce
    ForceCalibrationWindow,
    ForceMaintenanceOverride,
    ForceSafetyIntervention,
    UnforceScheduled,
    UnforceEmergency,
    // Policy
    PolicyRoutineRotation,
    PolicyEmergencyRevocation,
    // Emergency
    EmergencyO2Crash,
    EmergencyPumpFailure,
    EmergencyManualIntervention,
    // Generic last resort (deprecated; flagged in CI for eventual elimination)
    GenericOperator { ticket_ref: TicketRef },
}

// TicketRef: formatted reference to external ticket (Jira / GitHub issue); UUID-validated at emit
```

**Legal bases table (§10a addition):**

| Jurisdiction | Regulation | Article | Retention period | Erasure path |
|---|---|---|---|---|
| EU (GDPR) | Records of processing | Art 30 | Duration of processing + 3 years | Cryptographic erasure via tenant_erasure_key destruction |
| EU (GDPR) | Integrity of processing | Art 32 | Duration of processing + 3 years | Same as above |
| EU (NIS2) | Incident records | Art 23 | 3 years after incident | Archive to legal-hold on active incident |
| EU (IEC 62443 regulated sectors) | Audit records | Plant operator records | 7 years | Crypto erasure aligned + legal-hold override |
| Türkiye | KVKK | Art 12 + Art 7 | As per specific-law exceptions | Same crypto erasure |
| Türkiye | KVKK data residency | For TR tenants | Audit archive within TR | Regional anchor + S3 TR bucket |
| US (SOC 2) | Control monitoring | CC4.1 | 7 years | Crypto erasure aligned |
| Customer-contractual | Higher of above | Per contract | Per contract | Per contract |

**Data residency (§10b — FINDING missing in v1; explicit here):**

KVKK Kurul Karar No: 2019/78 (operative clause, 2019-09-11):
> *"Kişisel veriler, veri sorumlusunun Türkiye'de bulunan sunucularında veya Kurul tarafından yeterli korumaya sahip olduğuna karar verilen ülkelerdeki sunucularda saklanmalıdır. Aksi durumda açık rıza veya Kanun'un 9/2'nci maddesi kapsamındaki istisnalar gerekir."*

Interpretation for this ADR:
- **SAFE DEFAULT (Turkish tenants):** operator-controlled Turkish datacenter (Türk Telekom DC, Garanti BBVA DC, or DigitalOcean Istanbul region when available). No adequacy-decision dependency; no tenant-consent dependency.
- **Opt-in alternative:** AWS `eu-central-1` (Frankfurt). KVKK does NOT currently list AWS regions as "yeterli korumaya sahip"; requires explicit tenant consent (KVKK Art 9/2 istisna path) OR Standard Contractual Clauses equivalent. Tenant admin UI must display + record consent before enabling Frankfurt routing.
- **EU tenants:** `eu-west-1` / `eu-central-1` (GDPR adequacy self-resident).
- **Manifest-driven per-tenant routing:** `tenant_manifest.audit_residency_region: TR | EU_FRANKFURT | EU_IRELAND` (signed, ADR-018 §6); edge relays to region-matching MQTT broker + cloud storage.

Invariant: `tests/invariants/audit_residency_compliance.rs` — Turkish tenant without explicit Frankfurt consent → routing to EU region REJECTED by platform; audit event `DataResidencyViolationAttempt` CRITICAL logged.

**Data portability (§10c — FINDING missing in v1):**
- Tenant audit export: scoped by (tenant_id, date range) → JSON bundle
- Optionally decrypted under tenant-held export key (separate from tenant_erasure_key)
- Rate-limited (1 export/day/tenant) to prevent DoS

### 11. v1 migration — re-encryption (FINDING-008 HIGH closure)

```sql
-- Migration step (Faz 2 Sprint 9.2):

-- 1. Deploy v2.0.0 agent with new audit chain
-- 2. Dump v1 SQLCipher audit_log with v1 master key
-- 3. Re-encrypt under v2 master-derived archive key:
--      archive_wrapping_key = HKDF(v2_master, "audit-v1-archive-wrapping-v1")
--    Store as /var/lib/suderra/audit_v1_archive.sqlcipher (encrypted under archive_wrapping_key)
-- 4. Write GenesisChainInit v2 entry referencing:
--      - last v1 audit_log.id
--      - SHA-256 of full v1 archive
--      - archive_wrapping_key fingerprint
-- 5. v1 master key can now be destroyed (v1 archive readable via v2 master → archive_wrapping_key)
-- 6. v1 original scada_db.audit_log table DROPPED post-verification
-- 7. audit-verify CLI --v1-archive flag decrypts via v2 master + HKDF → reads archive rows

-- INVARIANT: tests/invariants/audit_v1_archive_readable.rs
--   - Simulate v1 master destruction
--   - Read v1 archive via v2 master + HKDF
--   - Cross-validate 100 rows between original v1 dump + archive read-back
```

### 12. Cross-epoch key retention + v2-master-rotation archive re-wrap (FINDING-008 extension)

Per-device epoch_keys registry:
- SQLCipher-encrypted under master key
- All historical epoch HMAC keys retained (7-year + legal-hold)
- Audit-verify CLI: fetches epoch-specific key via HKDF derivation from master (if operator-authorized; forensic path uses §6 ed25519 attestation instead, not this)

**v2-master-rotation v1-archive re-wrap protocol:**

```
Trigger: ADR-019 §6 master key rotation (180-day scheduled OR compromise response)

Atomic migration step (invariant-protected):
  1. Derive NEW archive_wrapping_key = HKDF(new_v2_master, "audit-v1-archive-wrapping-v1")
  2. Decrypt v1 archive under OLD archive_wrapping_key (derived from old master)
  3. Re-encrypt under NEW archive_wrapping_key
  4. Atomic fs rename: audit_v1_archive_new.sqlcipher → audit_v1_archive.sqlcipher
  5. Emit AuditAction::V1ArchiveReWrapped { old_epoch, new_epoch, archive_sha256 } entry
  6. fsync; update state
  7. Old master key + archive key zeroized (memory) + wiped from keystore

Failure modes:
  - Crash between steps 3-4: new archive present alongside old; boot-time check re-resumes from step 4
  - Crash during step 3: new archive partial; boot-time check deletes partial; re-resumes from step 1
  - Atomic rename ensures archive file is always either fully-old or fully-new; no torn state

INVARIANT: tests/invariants/audit_v1_archive_cross_rotation.rs
  - Simulate 2 master rotations; verify v1 archive readable across both
  - Simulate crash mid-re-wrap; boot-time recovery validates archive integrity
```

### 13. Device audit_attestation_key lifecycle (§13 addition for forensic path)

- Generated at provisioning (§1 `derive_device_audit_attestation_keypair`)
- Private key: TPM-sealed (Tier 1) or master-wrapped (Tier 2/3)
- Public key: published to cloud anchor registry; signed by interim_anchor_signing_key (§5a) or slot 8 post-ADR-021
- Rotation: synchronized with master key rotation; new attestation key registered + signed
- Compromise response: revocation statement signed by slot 4 (rescue_firmware_signing_key) published to Sigsum CT log

---

## Alternatives Considered

### Alt-1..4 (unchanged from v1 draft — all rejected with same rationale)

### Alt-5 (NEW) — Full asymmetric signatures on every entry (not hybrid)
Performance: 75μs × 100 entries/day × 500 devices = not bad, but for burst load (ST debug mode 1000+ entries/sec on single device) degrades to ceiling. Hybrid HMAC hot-path + ed25519 attestation per-epoch gets best of both worlds. Alt-5 reddedildi, hybrid seçildi.

### Alt-6 (NEW) — `AuditAction::Custom` extensibility escape hatch
`serde_json::Value` params bypass compile-time AuditSafe denylist (FINDING-010). REDDET — closed enum + schema governance via ADR amendment.

---

## Consequences

### Positive
- **Tamper-evident at SL-2 adversarial:** HMAC chain + per-epoch ed25519 attestation + cloud anchor + TPM NV counter — 6 detection paths; full master-key compromise detectable via anchor within 24h
- **Append-only enforced:** kernel CAP_LINUX_IMMUTABLE + chattr +a; agent compromise cannot truncate/unlink
- **Forensic independence:** audit-verify CLI uses device PUBLISHED pubkey; no master-key egress requirement
- **Decoupled from ADR-021:** interim anchor key ceremony in-scope; ADR-020 Accepted-able independently
- **Severity-safe backpressure:** CRITICAL buffer reservation + INFO rate-limit + safety-path carve-out; evidence-suppression DoS closed
- **Regulatory compliant:** GDPR Art 17/30/32 + KVKK Art 7/12 + SOC 2 CC4 via pseudonymization + legal basis table + data residency + export
- **v1 migration safe:** re-encryption preserves 7-year readability across key rotation
- **Schema governance:** closed enum + ADR-amendment extension; no runtime escape hatch

### Negative
- **Implementation kod:** `src/audit/` ~2500-3000 satır; `libs/backend-common/src/audit-anchor/` ~1000-1500 satır; `audit-verify` CLI ~1500-2000 satır; `suderra-audit-init` + `suderra-audit-rotator` systemd units
- **Interim anchor ceremony operational burden:** Daily engineer-approval flow for anchor signing (YubiHSM + office safe); 10-15 min/day
- **TPM NV counter usage:** NV writes limited (10k-100k cycles depending on TPM model); 180-day rotation + entry_id increments fit easily but requires monitoring
- **Forensic CLI complexity:** hybrid verification more complex than naive HMAC-only; compensated by honest trust model

### Blocker relations
- **DEC-019 RESOLVED** (by this ADR) — ADR-018 §12 dependency satisfied
- **FINDING-002 RESOLVED via §5a interim ceremony** — decoupled from ADR-021 BLOCKED
- **ADR-018 Accepted:** unblocked on audit-chain side; ADR-021 rewrite (DEC-020) still blocks on RBAC side

---

## 14. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-020-FINDING-001 | CRITICAL | §3a | chattr +a + CAP_LINUX_IMMUTABLE drop; 2 systemd units; invariant test |
| ADR-020-FINDING-002 | CRITICAL | §5a | Interim offline-HSM anchor key ceremony; ADR-021 BLOCKED'tan decouple |
| ADR-020-FINDING-003 | CRITICAL | §6 + §13 | Hybrid HMAC + per-epoch ed25519; CLI uses device pubkey, NO master key egress |
| ADR-020-FINDING-004 | CRITICAL | §4 | Severity-per-variant + CRITICAL reservation + INFO rate-limit + safety carve-out |
| ADR-020-FINDING-005 | HIGH | §9a | TPM NV counter AuditEntryIdCounter trait; boot-time regression check |
| ADR-020-FINDING-006 | HIGH | §9 threat model | Post-key-compromise reforge documented boundary; anchor catches within 24h |
| ADR-020-FINDING-007 | HIGH | §10 + §10a/b/c | Pseudonymization + legal basis table + data residency + portability |
| ADR-020-FINDING-008 | HIGH | §11 | v1 re-encryption under v2-derived archive_wrapping_key; key lineage preserved |
| ADR-020-FINDING-009 | HIGH | §4 derive macro stable-Rust | **PRIMARY: build.rs syn scanner** (stable Rust; scans enum variant fields against denylisted type-name regex + crate-local type alias resolution via cargo-expand). **ASPIRATIONAL (when stabilized): auto trait NoSecrets + !impl for Secret<T>** (currently nightly-only `negative_impls` + `auto_traits`; tracked for upgrade when stable). Primary path ships in Faz 2. |
| ADR-020-FINDING-010 | MEDIUM | §7 | Custom variant KALDIRILDI; closed enum + ADR-amendment governance |
| ADR-020-FINDING-011 | MEDIUM | §8 MQTT comment | Consumer idempotency + persisted-subscription; "exactly-once broker" değil end-to-end durable |
| ADR-020-FINDING-012 | MEDIUM | §8 | Reference hardware + FS + kernel specified; criterion bench CI gate |
| ADR-020-FINDING-013 | MEDIUM | §5 | `create` + HUP; advisory lock; `copytruncate` retired |
| ADR-020-FINDING-014 | MEDIUM | §5b | Liveness SLO 0-24-48-72h cascade; fail_closed optional |
| ADR-020-FINDING-015 | MEDIUM | §1 correlation_id | Derived from first entry_hmac; not plaintext forgeable |
| ADR-020-FINDING-016 | LOW | §1 genesis | prev_hmac includes provisioning_nonce; re-provision distinguishable |
| ADR-020-FINDING-017 | LOW | §1 timestamp_certainty | Enum field; audit-verify tolerates Unsynced first M entries/boot |
| ADR-020-FINDING-018 | INFO | §8 | RISC-V add to cross-compile matrix (future hardware roadmap) |
| ADR-020-FINDING-019 | INFO | §8 | bincode 1.3.3 pinned; future postcard/CBOR migration tracked |

---

## 15. Implementation Plan (Plan §5 Faz 2)

**Hafta 6-9:**

1. Sprint 6.4: `src/audit/` iskelet + AuditEntry + HMAC derivation + EpochKeyRegistry + device_audit_attestation_keypair
2. Sprint 6.5: `AuditActionDerive` macro (severity) + `NoSecrets` auto trait + fallback build.rs
3. Sprint 7.4: Append-only file path + chattr enforcement + `suderra-audit-init` + `suderra-audit-rotator` systemd units + criterion bench
4. Sprint 7.5: TPM NV counter integration (AuditEntryIdCounter trait) + boot-time regression check
5. Sprint 8.4: MQTT relay + offline buffer + consumer idempotency + severity-aware backpressure
6. Sprint 8.5: Per-epoch ed25519 attestation signing on rotation + publication to anchor registry
7. Sprint 8.6: `audit-verify` CLI hybrid HMAC + ed25519 path + anchor Merkle proof cross-check
8. Sprint 8.7: Interim anchor YubiHSM ceremony + public key publication + daily signing job
9. Sprint 9.2: v1→v2 migration re-encryption + archive cross-validation
10. Sprint 9.3: Cross-ADR event integration tests (ADR-017/018/019 emit verification)
11. Sprint 9.4: Pseudonymization + legal basis SoR template + tenant erasure + export

**Acceptance criteria (Faz 2 close):**
- All invariants green: audit_chain_continuous, audit_cloud_relay_ordered, cloud_anchor_daily, audit_no_pii_leak, audit_epoch_keys_retained, audit_log_chattr_append, audit_backpressure_critical_preserved, audit_tail_truncation_detected, audit_verify_no_master_key, audit_v1_archive_readable, audit_erasure_via_key_destruction, audit_log_rotation
- `audit-verify --full` 100k-entry corpus < 10s on RPi4
- Append p99 < 5ms on industrial eMMC (criterion bench gate)
- Cloud anchor + interim signing SLO 99.9% / 30-day window
- v1 re-encryption validated
- Pseudonymization tenant_erasure_key destruction renders entries unlinkable
- IEC 62443 SL-2 FR6 adversarial re-audit green (all 4 SRs pass)
- Status → Accepted (without waiting for ADR-021 unblock)

---

## References

- RFC 5869 HKDF, RFC 2104 HMAC
- RFC 6962 Certificate Transparency (anchor log pattern)
- Sigsum append-only log (https://sigsum.org)
- NIST SP 800-92 Log Management
- GDPR Art 17/30/32 + EDPB Guidelines 05/2021 "cryptographic erasure"
- KVKK Art 7/12 + Kurul Karar No: 2019/78 (data residency interpretation)
- NIS2 Art 23 incident records
- SOC 2 CC4.1, CC4.2, CC7.2
- IEC 62443-3-3 FR6 + FR6 RE(1)(2)
- Linux `chattr(1)` + `capabilities(7)` `CAP_LINUX_IMMUTABLE`
- bincode 1.3.3 (pinned; FINDING-019)
- `/var/aqua-saas/sens-api-gateway/src/commands.rs:380-388` (v1 migration target)
- ADR-017 §13 (ST bytecode audit consumer)
- ADR-018 §5 + §11 (RBAC consumer)
- ADR-019 §7 master key hierarchy + §12 FirmwareRollbackEvent
- ADR-021 (BLOCKED; slot 8 daily_anchor_signing_key future; DEC-021 tracks; §5a interim decouples)
- ADR-023 (DEC-017; SL-3 remote attestation — closes within-epoch-post-compromise residual risk)
