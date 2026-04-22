# Platform Threat Model — STRIDE Per-Component + Attack Trees

**Status:** Initial skeleton (Faz 0 STL-007 deliverable; living document — updated every ADR cycle)
**Date:** 2026-04-19
**Owner:** Okan (temp — PROC-001)
**Scope:** sens-api-gateway edge agent + platform services (`apps/auth-service`, `apps/admin-api-service`, `apps/billing-service`, `apps/sensor-service`, `apps/gateway-api`) + ADR-017..022 cross-cutting controls
**Cross-refs:** ADR-017 §9, ADR-018 §5/§9, ADR-019 §9, ADR-020 §9, ADR-022 §5
**Review cadence:** Every new ADR (section-per-ADR addition); quarterly full re-read; post-incident updates within 72h
**Target compliance:** IEC 62443-3-3 SL-2 adversarial (FR1-FR7 mapped §6); GDPR Art 32; KVKK Art 12; SOC 2 CC4

---

## 1. Scope + methodology

### 1.1 STRIDE mnemonic
- **S**poofing — attacker impersonates principal
- **T**ampering — attacker modifies data/code in transit or at rest
- **R**epudiation — principal denies action; insufficient audit
- **I**nformation disclosure — attacker reads data they shouldn't
- **D**enial of service — attacker prevents legitimate use
- **E**levation of privilege — attacker gains unauthorized capability

### 1.2 Assets under protection
1. **Tenant fish stock** (life-safety, operational) — aerator control, O2 dosing, feeding schedule
2. **Tenant operational data** (sensor readings, commands, program bytecode)
3. **Tenant business data** (billing, users, audit trail)
4. **Cross-tenant platform integrity** (one tenant cannot compromise another)
5. **Platform cryptographic trust root** (7-slot HSM key ceremony per ADR-021)
6. **Regulatory compliance evidence** (audit chain 7-year retention per ADR-020)

### 1.3 Threat actors (STRIDE-aware, not exhaustive)
- **T1 External network attacker** — MQTT spoofer, CA-compromise, broker MITM
- **T2 Physical device attacker** — SD card theft, JTAG, supply-chain-compromised hardware
- **T3 Tenant insider (authenticated operator)** — abuses legitimate credentials
- **T4 Platform insider** — admin-api / DB operator; has cross-tenant visibility
- **T5 Cloud-provider insider** — AWS employee with S3/KMS access
- **T6 Supply-chain attacker** — npm dependency compromise, SaaS vendor compromise (YubiHSM, AWS KMS)
- **T7 Nation-state** — out-of-SL-2-scope but documented for SL-3 path (ADR-023)

---

## 2. Component inventory (per-ADR)

| Component | File path | Primary ADR | STRIDE table § |
|-----------|-----------|-------------|---------|
| ST Bytecode Compiler + VM | sens-api-gateway/src/scripting/st_{compiler,vm}.rs | ADR-017 | §3.1 |
| RBAC + Authz | sens-api-gateway/src/authz/ | ADR-018 | §3.2 |
| Firmware Updater | sens-api-gateway/src/updater/ | ADR-019 | §3.3 |
| Audit Chain | sens-api-gateway/src/audit/ | ADR-020 | §3.4 |
| Edge Schema (platform DB) | apps/**/src/database/ | ADR-022 | §3.5 |
| MQTT Broker | Mosquitto / platform | all | §3.6 |
| Provisioning | sens-api-gateway/src/provisioning/ + cloud | ADR-019 §4 | §3.7 |
| Keystore | sens-api-gateway/src/keystore/ | ADR-019 §7 | §3.8 |
| Signing Service (platform) | apps/signing-service/ | ADR-021 | §3.9 |
| HSM Ceremony | offline vault | ADR-021 §4 | §3.10 |

---

## 3. Per-Component STRIDE

### 3.1 ST Bytecode Compiler + Stack VM (ADR-017)

| STRIDE | Threat | Actor | Mitigation (ADR ref) | Residual risk |
|---|---|---|---|---|
| **S** | Unsigned bytecode accepted as legitimate program | T1, T4, T6 | ed25519 signing slot 6 + pre-deserialize verify (ADR-017 §6) | Signing-service (slot 6) compromise allows forged bytecode. ADR-021 4-eye + audit. |
| **T** | In-memory bytecode mutation (RCE in agent) | T1 | Immutable signed `.stbc` artifact + verify-once-execute-many; panic-hook + `process::abort()` (ADR-019 §5 in-process hardening) | RCE with privilege to write /var/lib/suderra disables this path — defended by chattr + cap drop (ADR-020 §3a pattern extension) |
| **T** | Opcode injection via compiler bug | T6 (supply chain) | Closed opcode set + fuzz targets `fuzz_st_compiler.rs` + Kani `safe_state_reachable` harness | Compiler logic bug unknown-unknown; defense: multi-fuzz + canonical `fish_feeder` regression |
| **R** | Program crash + operator denies deploying it | T3 | Audit event `StBytecodeDeployed { program_id, two_person_approvers }` per ADR-020 §7; two-person integrity (ADR-018 §7) | None material |
| **I** | Bytecode reveals proprietary tenant logic to attacker with filesystem access | T2, T4 | Bytecode encrypted at rest (SQLCipher DB; ADR-019 §7 master key) | Master key compromise exposes; defended by TPM tier |
| **D** | Authenticated DoS via infinite loop | T3 | Gas metering (per-opcode cost) + `max_gas_per_tick` signed header + watchdog (ADR-017 §4 + §7) | Gas budget too loose → partial DoS; operational tuning per-tenant |
| **D** | Stack overflow | T3 | `max_stack_depth` signed header; compile-time static analysis | None |
| **E** | WriteTag opcode writes outside `allowed_write_tags` | T3 | `RbacGatedWriter` module-boundary + CODEOWNERS + `tests/invariants/st_rbac_gate_mandatory.rs` (ADR-017 §4; AUDIT-001 kapama) | Compromised agent with cap `CAP_LINUX_IMMUTABLE` could bypass chattr — closed by cap-drop architecture |

### 3.2 RBAC + Authz (ADR-018)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Cross-tenant manifest replay (A manifest → B device) | T2 | Sealed tenant binding via ProvisioningBlob outside mutable config (ADR-018 §3; ADR-019 §4) | ProvisioningBlob PUBKEY storage tier-dependent (ADR-019 §2) |
| **S** | Forged operator signature | T5 | Per-operator ed25519 keypair in cloud HSM; platform signing requires operator 2FA | Single compromised operator private key × single compromised command_signing key = two-person bypass; documented SL-3 gap |
| **T** | Manifest in-flight modification | T1 | ed25519 slot 2 + signing_key_epoch monotonic | HSM slot 2 compromise |
| **T** | Policy version rollback (SD wipe) | T2 | TPM NV / RPMB / A/B slot anti-rollback counter (ADR-018 §4; ADR-019 Tier 1-3) | Tier 3 file-backed counter forgeable under master compromise |
| **R** | "I didn't authorize this command" | T3 | Two-person integrity for CRITICAL commands + signed envelope binds_to_policy_version (ADR-018 §7); audit chain (ADR-020) | None material post-ADR-018+020 |
| **I** | Unauthorized read of other tenant's manifest | T3, T4 | RLS FORCE on `edge.policies` (ADR-022 §3) + TenantScopedRepository (ADR-022 §4) | admin_reporting_role bypass intentional for fleet ops; cross-tenant admin queries audited |
| **D** | ManagePolicy self-lockout | T3, T4 | Recovery invariant enforced (ADR-018 §8); manifest reject if no role has ManagePolicy | Deliberate lockout by compromised ManagePolicy requires break-glass (ADR-018 §5) — life-safety preserved |
| **D** | Signature-verify flooding | T1 | Edge-side rate limit 10/s per sender + token bucket + 64 KB envelope cap (ADR-018 §9) | CPU budget bounded; no DoS |
| **E** | Unknown permission silent-grant | T6 | `required_permissions` REJECT fail-closed (ADR-018 §6) | Enum extension requires binary rebuild; no runtime granting |
| **E** | AuthorizedContext constructor leak | T6 | `pub(super)` 2-file submodule + CODEOWNERS + invariant test (ADR-018 §11) | PR review discipline — process control |

### 3.3 Firmware Updater (ADR-019)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Unsigned firmware accepted (current HC-1) | T1, T6 | ed25519 manifest verify slot 1 + per-file SHA-256 (ADR-019 §1) | HC-1 bootstrap trust ceremony required for first signed transition (ADR-019 §9) |
| **S** | Rescue firmware impersonation | T4 | Separate rescue_firmware_signing_key slot 4 + dedicated partition p6 (ADR-019 §5) | Slot 4 offline-vault compromise scenario in §3.10 |
| **T** | In-install binary swap (TOCTOU) | T2 | Mount namespace + dm-verity root hash in SignedBootFlag (ADR-019 §4) | Kernel-level exploit outside threat model for SL-2 |
| **T** | Boot flag tampering via filesystem | T2 | Dual-signature (slot 1 + slot 2 countersig) + tryboot_commit_proof + signed overlay (ADR-019 §3) | Slot 1 + slot 2 dual compromise (see §3.10) |
| **T** | Firmware downgrade (SD wipe) | T2 | AntiRollbackCounter trait Tier 1-3 + signing_key_epoch monotonic (ADR-019 §11) | Tier 3 forgery if master compromised |
| **R** | Undocumented rollback | T3, T4 | FirmwareRollbackEvent audit entry (ADR-019 §12; ADR-020 §7) | None |
| **I** | Firmware reveals platform internals | — | Firmware binary public artifact (open design); no secrets in firmware | None (firmware is public; trust = signature) |
| **D** | Install-retry loop DoS | T1 | Install retry cap + auto-rescue trigger (ADR-019 §4) | None |
| **D** | Cold-boot window exhaustion | T3 | Tiered per-hardware cold_boot_budget_secs (RPi4 90s / RevPi 120s); health probe 3-of-3 (ADR-019 §4) | None within design budget |
| **E** | Rescue firmware → primary promotion without ceremony | T4 | Rescue signed by slot 4 only; primary must be slot 1; binary enforces role separation | Slot 4 compromise (see §3.10) |

### 3.4 Audit Chain (ADR-020)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Injected genesis entry | T6 | Genesis prev_hmac = HMAC(master, "genesis" \|\| device_id \|\| provisioning_nonce) per ADR-020 §1 FINDING-016 | Re-provisioning distinguishable via new provisioning_nonce |
| **T** | Mid-chain entry deletion | T3 | HMAC chain break detection (ADR-020 §9) | Master-key compromise allows reforge; anchor catches (§9) |
| **T** | Tail truncation + state rewrite | T3 | TPM NV counter regression check (ADR-020 §9a FINDING-005) | Tier 3 weakness documented (§9 threat table) |
| **T** | Cloud-side anchor tampering | T5 | Tracked-retirement offline-HSM anchor signing + Sigsum CT log (ADR-020 §5a; retirement path DEC-021) | Office-safe anchor key compromise requires 2-eye breach + physical vault access |
| **R** | Operator denies force_value action | T3 | Per-operator signed envelope + correlation_id derived from first entry_hmac + audit chain (ADR-020 §7 + §1 FINDING-015) | None material |
| **I** | Audit log contains credentials | T2 | AuditSafe NoSecrets trait + compile-time / build.rs scanner (ADR-020 §4 FINDING-009) | Stable-Rust path = build.rs syn scanner; alias resolution limit documented |
| **I** | Cross-tenant audit leak | T3, T4 | RLS FORCE + tenant_pseudonym column + per-tenant anchor scope (ADR-020 §1 + §5b; ADR-022 §3) | admin_reporting_role bypass intentional |
| **D** | Audit buffer overflow → evidence suppression | T3 | Severity-per-variant + CRITICAL reservation + INFO rate-limit (ADR-020 §4 FINDING-004) | None within architecture |
| **D** | Safety-path halt via audit DoS | T3 | fail_closed_halt_writes_not_safety carve-out (ADR-020 §4) | None (safety-path bypasses command halt) |
| **E** | Custom variant bypass | T3 | Custom enum variant REMOVED (ADR-020 §7 FINDING-010); extension requires ADR amendment | None |

### 3.5 Edge Schema (platform DB, ADR-022)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Fake service-account credential | T5 | Canonical role grants (ADR-022 §1) + explicit REVOKE default-deny + PG connection mTLS | Cloud-provider compromise |
| **T** | Schema drift (missing schema:) | T6 | ADR-011 invariant test (schema-invariants.spec.ts) extended per ADR-022 §8 | CI process dependency |
| **T** | Temporal license overlap | T4 | EXCLUDE USING gist constraint on `edge.licenses` (ADR-022 §2.3) | None |
| **T** | Cross-tenant query via misconfigured repository | T4 | RLS FORCE + TenantScopedRepository compile-time API (ADR-022 §3+§4) | Defense-in-depth; both layers must fail simultaneously |
| **R** | Ceremony witness absence | T4 | Junction table + ed25519 per-witness signature (ADR-022 §2.4 FINDING-013) | Witness key compromise possible; 3-witness quorum mitigates |
| **I** | PII leakage via denormalized counter | — | Counter is row count only, no PII (ADR-022 §2.2 COMMENT) | None |
| **I** | DB backup leaks cross-tenant | T5 | Encrypted at rest + per-tenant crypto erasure (ADR-020 §10) | Backup retention policy + legal-hold |
| **D** | Partition growth exhaustion | T3 | RANGE partitioning + pg_partman DROP PARTITION retention (ADR-022 §2.6) | Operator monitoring SLO |
| **D** | TypeORM synchronize:true drops tables | T6 | synchronize: false MANDATE + invariant test (ADR-022 §7 FINDING-008) | Developer discipline + CI gate |
| **E** | Tenant hard-delete escalation | T4 | `auth.tenants` hard-delete FORBIDDEN platform-wide (ADR-022 §5) | None |

### 3.6 MQTT Broker

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Device cert spoof | T1 | mTLS strict + leaf cert pinning (ADR-019 §8 3-pin) | CA compromise — leaf pin secondary defense |
| **T** | Retained message poisoning | T1 | Broker ACL `retain=true` forbidden on command topics; edge reject (ADR-018 §14 DEC-014) | None |
| **R** | Broker loss of message = no audit | T1 | QoS 2 + consumer idempotency + offline buffer (ADR-020 §4) | Broker compromise documented as T1-scope |
| **I** | Broker admin sees all tenant traffic | T5 | MQTT topic tenant-prefix enforcement (CLAUDE.md ADR-015 cert-is-identity) | Broker audit logs retained per platform SLA |
| **D** | Broker flood | T1 | Per-tenant rate limits at broker level + edge-side verify rate limiter (ADR-018 §9) | Broker operator capacity monitoring |
| **E** | Inter-tenant topic access | T3 | ADR-015 cert CN = identity; per-tenant topic namespace | None |

### 3.7 Provisioning (ADR-019 §4)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Provisioning blob forged | T6 | ed25519 slot 7 signature + PROVISIONING_SIGNING_PUBKEY outside rootfs (ADR-019 §2) | Slot 7 semi-air-gap compromise |
| **T** | `provisioning.bin` file tampered | T2 | chattr +i immutable + nosuid,nodev mount + cloud challenge-response re-prov (ADR-019 §6; ADR-020 §3a pattern) | Physical SD access + cap-escalation required |
| **R** | Factory provisioning without audit | T4 | ceremony_video_archive_url + 3-witness junction table + operator_id FK (ADR-022 §2.4) | Witness collusion |
| **I** | Tenant_id leaks via provisioning metadata | — | ProvisioningBlob in read-only partition; exposed only to authz module | ProvisioningBlob deployment_notes sanitized (ADR-019 §4 FINDING-016) |
| **D** | Re-provisioning flood | T3 | Cloud challenge-response rate limit per device + audit event | Cloud rate-limit tuning |
| **E** | Unauthorized re-provisioning | T3, T4 | Two-person platform-side (operator + security officer) + signed token bound to device_id (ADR-022 §5) | Platform compromise |

### 3.8 Keystore (ADR-019 §7)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Unsealing without valid context | T2 | TPM PCR-sealed policy; unseal fails if boot chain tampered | Replay of legitimate unseal — bounded by TPM quote |
| **T** | Master key tamper | T2 | TPM NV-sealed (Tier 1); systemd-creds LUKS (Tier 2); Argon2id 256 MiB (Tier 3) | Tier 3 fleet-proportion SLA |
| **T** | Coredump leaks key | T2, T4 | LimitCORE=0 + PR_SET_DUMPABLE + mlock + panic zeroize (ADR-019 §5 systemd hardening) | Kernel exploit — out of SL-2 scope |
| **R** | Master-key rotation undocumented | T4 | TpmUnsealSucceeded/Failed + KeystoreBackendSelected audit events (ADR-020 §7) | None |
| **I** | Key in swap | T2 | mlock + memfd_secret attempt (ADR-019 §5) | Kernel version dependent |
| **D** | TPM lockout | T3 | Tiered fallback; operator-gated Tier 3 acceptance (ADR-019 §7 expiry → emergency mode) | Operator passphrase UX burden |
| **E** | Key material extracted via memory dump | T4 | prctl+mlock+panic-abort; debugger attach restricted via ptrace_scope=2 | Root LOCAL compromise |

### 3.9 Signing Service (platform, ADR-021 — BLOCKED; post-rewrite)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Unauthorized signing invocation | T5, T6 | mTLS-only gRPC + per-engineer auth + 2FA + audit chain | ADR-021 under rewrite — revisit post-DEC-020 |
| **T** | Signing request forgery | T5 | Signed request envelope + nonce dedup + per-operator cert | ADR-021 rewrite |
| **R** | Signing without witness | T5 | Witness log + 4-eye enforcement | ADR-021 rewrite |
| **I** | Private key leak | T5 | HSM-enforced key segregation — **blocked on MPC-HSM vendor PoC** (DEC-020) | Currently CRITICAL gap — ADR-021 rewrite priority |
| **D** | Signing service disabled | T5 | HA deployment + AWS KMS DR co-signer | ADR-021 rewrite |
| **E** | Runner job escalation | T6 | Dedicated signing runner + isolated VLAN + workflow_dispatch-only trigger | Standard GitHub Actions hardening |

### 3.10 HSM Ceremony (ADR-021 §4 — offline)

| STRIDE | Threat | Actor | Mitigation | Residual risk |
|---|---|---|---|---|
| **S** | Ceremony impersonation | T4, T7 | Video + 3+ custodian signatures + external auditor | Witness collusion ×3 — nation-state scope |
| **T** | Hardware substitution | T4, T6 | Tamper-evident bags + serials read aloud + auditor binary verification (ADR-021 FINDING-010) | Pre-ceremony supply-chain compromise before bag sealing |
| **R** | Ceremony undocumented | — | 7-year video + transcript + witness testimony (ADR-021 §9) | Retention beyond 7y requires legal-hold |
| **I** | Key share partial disclosure | T7 | FROST N-of-M secret-never-reconstructed; Shamir 3-of-5 geographic distribution (ADR-021 §4) | Nation-state capability |
| **D** | Custodian unavailability | T3 | 3-of-5 quorum + custodian replacement procedure (ADR-021 §4.B FINDING-009) | Custodian turnover logistics |
| **E** | Key escalation via ceremony flaw | T7 | Ceremony-protocol compliance audit (external firm annually) | Documented; audit findings → ceremony update |

---

## 4. Attack Trees

### 4.1 Root: "Attacker gains unauthorized actuator control on tenant X"

```
Attacker gains unauthorized actuator control on tenant X
├── Path A: Compromise edge agent process
│   ├── A.1: RCE via ST bytecode → bytecode injection
│   │   ├── A.1.1: Slot 6 program_signing_key compromise (ADR-021)
│   │   └── A.1.2: ST compiler bug → gadget chain [fuzz tests required]
│   ├── A.2: RCE via commands.rs → command dispatch path
│   │   ├── A.2.1: Slot 3 command_signing_root compromise
│   │   └── A.2.2: Envelope parse vulnerability [fuzz tests required]
│   └── A.3: Physical SD card + TPM-less device
│       └── A.3.1: Tier 3 passphrase brute force (Argon2id m=256MiB mitigation)
│
├── Path B: Platform-side manipulation
│   ├── B.1: Forge RBAC manifest
│   │   └── B.1.1: Slot 2 rbac_manifest_signing_key compromise
│   ├── B.2: Forge firmware manifest
│   │   └── B.2.1: Slot 1 firmware_signing_key compromise
│   └── B.3: Exploit platform → override RBAC at DB
│       └── B.3.1: admin-api-service RCE + RLS FORCE bypass [admin_reporting_role deny]
│
├── Path C: Network MITM
│   ├── C.1: Broker compromise
│   │   └── C.1.1: CA-signed leaf cert + pinning bypass [3-pin rescue fallback]
│   └── C.2: NTP/time spoof → replay via TTL bypass
│       └── C.2.1: NTS deployment + monotonic wall-clock floor [ADR-018 §10]
│
└── Path D: Supply chain
    ├── D.1: npm dependency hijack (jsonwebtoken, moka, serde)
    │   └── D.1.1: cargo-deny + cargo-audit + lockfile review [tools/gates]
    ├── D.2: YubiHSM firmware tamper
    │   └── D.2.1: Vendor supply-chain verification [procurement process]
    └── D.3: AWS KMS operator compromise
        └── D.3.1: KMS audit trail + customer-managed-key policy [CloudTrail]
```

### 4.2 Root: "Attacker exfiltrates cross-tenant audit log data"

```
Attacker exfiltrates cross-tenant audit log data
├── E.1: DB-level cross-tenant query
│   ├── E.1.1: RLS misconfiguration [schema-invariants.spec.ts]
│   ├── E.1.2: Application-layer TenantScopedRepository bypass [compile-time + fuzz test]
│   └── E.1.3: admin_reporting_role credential theft [CODEOWNERS + MFA]
├── E.2: Cloud-side anchor manipulation
│   ├── E.2.1: S3 bucket policy misconfiguration [least-privilege review]
│   └── E.2.2: interim_anchor_signing_key compromise [office safe + 2-eye]
└── E.3: Device-local audit.log exfiltration
    ├── E.3.1: Physical device access → chattr -a bypass [CAP_LINUX_IMMUTABLE drop]
    └── E.3.2: Audit partition mount read → SQLCipher key extraction [TPM unseal policy]
```

### 4.3 Root: "Attacker causes safety incident (fish mortality)"

```
Attacker causes safety incident (fish mortality)
├── F.1: Disable aerator via force_value
│   └── F.1.1: Compromise operator with ForceValue + AffectActuator:Aeration permission
│       └── Mitigation: Two-person integrity MANDATORY on ForceValue (ADR-018 §7)
├── F.2: Push malicious ST bytecode that disables aerator
│   └── F.2.1: Slot 6 program_signing compromise
│       └── Mitigation: Bytecode allowed_write_tags SIGNED header + RbacGatedWriter
├── F.3: Force SafeStateTrigger (safe_state = aerator OFF configuration)
│   └── F.3.1: Safe-state v2 schema (ADR-019 §2 ADR-020 §5 safe-state-v2)
│       └── Mitigation: ProcessAware dependency — safe-state aware of stock density
├── F.4: DoS audit chain → remove accountability → no forensic trail
│   └── Mitigation: safety-path carve-out (ADR-020 §4); emergency actuator bypass
└── F.5: Disable rescue path → block recovery
    └── F.5.1: Slot 4 compromise (offline vault) — nation-state scope
```

---

## 5. Cross-component mitigation matrix

| Attack class | Primary defense (ADR) | Secondary defense | Tertiary defense |
|---|---|---|---|
| Spoofing (cert) | mTLS strict (ADR-019 §8) | Leaf cert pinning 3-pin | ADR-015 cert-is-identity |
| Spoofing (envelope) | ed25519 per-operator key (ADR-018 §7) | binds_to_policy_version | jti dedup |
| Tampering (in transit) | TLS 1.3 + ed25519 signatures | HMAC anchor | cloud anchor Merkle root |
| Tampering (at rest) | SQLCipher encryption | chattr +a + CAP drop | TPM NV counter anti-rollback |
| Repudiation | Per-operator signed commands | Audit HMAC chain | Cloud anchor daily + Sigsum CT log |
| Info disclosure (cross-tenant) | RLS FORCE | TenantScopedRepository | Pseudonymization crypto erasure |
| Info disclosure (key material) | TPM sealed | mlock + coredump disabled | FROST threshold (never-reconstructed) |
| DoS (CPU) | Gas metering + rate limits | Backpressure severity reservations | Per-tenant circuit breakers |
| DoS (storage) | Partition retention + logrotate | Buffer cap + priority | Offline overflow fail_closed safety-carve |
| Privilege escalation | AuthorizedContext module gate | Enum-closed Permission | Two-person integrity critical subset |

---

## 6. IEC 62443-3-3 SL-2 FR Mapping

| FR (Foundational Requirement) | Controls | Coverage |
|---|---|---|
| FR1 Identification & Authentication Control | mTLS strict, per-operator keys, ProvisioningBlob sealed identity | GREEN modulo ADR-021 rewrite |
| FR2 Use Control | ABAC Permission enum, two-person integrity, RLS FORCE, hot-reload recovery invariant | GREEN |
| FR3 System Integrity | ed25519 firmware + manifest + bytecode signing, dm-verity, dual-sig boot_flag | GREEN |
| FR4 Data Confidentiality | TPM sealed master, SQLCipher, Argon2id Tier 3 | GREEN modulo Tier 3 fleet SLO |
| FR5 Restricted Data Flow | per-tenant MQTT topics, RLS + TenantScopedRepository, data residency §10b | GREEN modulo residency ADR-022 implementation |
| FR6 Timely Response to Events | audit HMAC chain + cloud anchor + liveness SLO + emergency actuator | GREEN |
| FR7 Resource Availability | gas metering + rate limiting + partition retention + safety-path carve-out | GREEN modulo ADR-021 signing DR |

**Net SL-2 adversarial status:** GREEN pending ADR-021 rewrite (DEC-020); all other components have resolved audits.

---

## 7. Known Gaps + Deferrals (tracked)

| Gap | Severity | Owner | Deadline | Finding ID |
|---|---|---|---|---|
| ADR-021 signing service architecturally unsafe as initially written | CRITICAL | Okan | 2026-05-17 | DEC-020 |
| SL-3 remote attestation (closes within-epoch post-compromise residual) | Phase-scoped Faz 11 | Okan | 2026-09-30 | DEC-017 |
| WASM re-eval as ST runtime alternative | Phase-scoped Faz 11 | Okan | 2026-09-30 | DEC-017 (SL-3 path re-eval trigger) |
| Hardware adapter inventory (safe-state v2 full) | OPEN | Okan | Faz 0 | — (ADR-024) |
| JSON script runtime deprecation | OPEN | Okan | 2026-09-30 | DEC-018 |

---

## 8. Update procedure

- **New ADR:** add per-component §3.N + attack-tree nodes + FR mapping update
- **Post-audit finding:** update STRIDE rows + residual risk columns
- **Post-incident:** 72h update + runbook cross-link
- **Quarterly:** full re-read + IEC 62443 adversarial re-assessment
- **Owner:** Okan (temp — PROC-001)

---

## References

- Microsoft STRIDE framework (Howard & Lipner "Security Development Lifecycle")
- IEC 62443-3-3 SL-2 Foundational Requirements
- OWASP Threat Modeling Cheat Sheet
- Shostack "Threat Modeling: Designing for Security"
- ADR-015 cert-is-identity (MQTT)
- ADR-017/018/019/020/022 — per-component source
- ADR-011 Schema Ownership Model (RLS baseline)
