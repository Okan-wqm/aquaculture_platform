# ADR-021: Platform Key Ceremony and Lifecycle — Canonical 7-Slot HSM Map

**Status:** **BLOCKED (post-audit; architectural rewrite required before Proposed → Accepted)**
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + security-auditor + auth-security-expert + compliance-expert + edge-industrial-auditor
**Owner:** Okan (until security-lead hire)
**Deadline:** 2026-05-03 (original) — BLOCKED pending vendor capability redesign; revised deadline TBD by DEC-020 owner
**Related findings:** DEC-008 (platform key ceremony), STL-008 (crypto agility), SEC-002 + SEC-004 (downstream consumers), **DEC-020 (this ADR's rewrite tracking; opened by this revision)**
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-4, §4.9, §5 Faz 0; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.8 D-8
**Downstream ADRs:** ADR-017 §2 §12, ADR-018 §2 §7, ADR-019 §1 §3 §6 §8 — remain BLOCKED until this ADR reaches Accepted with verified vendor integration

---

## ⚠ BLOCKED STATUS — Post-Audit Summary (2026-04-19)

Bu ADR'ın ilk taslağı security-auditor tarafından **BLOCK** verdict ile reddedildi. 6 CRITICAL + 7 HIGH + 6 MEDIUM + 4 LOW bulgu. Üç tanesi **factually wrong vendor capability claims**:

| # | CRITICAL Finding | Reality |
|---|---|---|
| ADR-021-FINDING-001 | "YubiHSM 2 firmware 2.4+ supports FROST participant operations" | **YANLIŞ.** YubiHSM 2 firmware release notes'unda FROST yok; sadece `sign-eddsa` single-key Ed25519. FROST DKG / commitment-share / signature-share primitives hardware'de yok. Keyshare extraction gerekirse HSM'in kendi amacı çöker. |
| ADR-021-FINDING-002 | "AWS CloudHSM … Ed25519 co-signer" | **YANLIŞ.** AWS CloudHSM PKCS#11 Edwards curve desteklemiyor (sadece secp*). Edge agent ekosistemindeki ed25519 ile CloudHSM uyumsuz. |
| ADR-021-FINDING-003 | "AWS KMS FROST participant" | **YANLIŞ.** AWS KMS sadece `Sign(KeyId, Message)` expose eder; FROST'un two-round nonce-commitment + signature-share protokolü yok. KMS FROST participant olamaz (API structurally incapable). |

**Ek CRITICAL:**
- FINDING-004: ML-DSA-65 pubkey 1952 bytes (96 değil); binary overhead ~14 KB pubkey + 3.3 KB/signature (not "~2 KB").
- FINDING-005: 14-gün rotation overlap penceresi, compromise edilen old key için guaranteed 14-day attack window. Epoch counter storage location unspecified — ADR-019 `currently_installed_version` ile aynı SD-wipe class attack.
- FINDING-006: ≤15-dakika revoke SLO, %20 offline fleet için physically unachievable. Rescue firmware ceremony 8-12 saat alır; custodian'lar 5 lokasyonda. Gerçekçi online-fleet SLO ≠ full fleet SLO.

**Auditor recommendation:** §1-§4 + §11 **rewrite** required (not edit). 3 architectural option:
- (a) FROST'u düşür, single-key HSM + procedural 4-eye quorum (honest SL-2; simpler; loses cryptographic threshold property)
- (b) MPC-capable HSM vendor (Cybernetica SplitKey / Sepior / Fireblocks MPC) — blockchain-custody stack; maliyet + operational burden farklı
- (c) FROST'u tamamen software'de tut; HSM sadece key storage; honest-stated-risk — keyshares signing-service process memory'de

**Decision to revise next session** — user'ın "en kaliteli + güvenli + performanslı + mimari" direktifi option (b) MPC-HSM'i destekliyor ama vendor PoC gerektiriyor (şu oturumda yapamam). Honest path: ADR dosyası BLOCKED markalanır, finding board'a DEC-020 "ADR-021 redesign" açılır, sonraki oturumda:
1. MPC-HSM vendor PoC (YubiHSM 2 ya da Fireblocks MPC ya da Cybernetica SplitKey — prototype one-week)
2. ADR-021 §1-§4 + §11 vendor-verified capability set üstünde yeniden yazılır
3. Revoke SLO honest tiers (online + full fleet + ceremony-dependent)
4. ML-DSA sizing düzeltilir
5. Epoch counter storage tamper-resistant location tanımlanır (TPM monotonic counter veya OTP fuse + rotation budget)
6. 3-agent re-audit
7. DEC-020 → RESOLVED; ADR-021 → Proposed

**DEC-020 tracked in finding board** with owner + deadline; not silent deferral.

**Aşağıdaki içerik ilk taslak — BLOCKED olarak işaretlenmiş; referans amaçlı korunuyor. Rewrite sırasında §1-§4 + §11 yeniden yazılacak; geri kalan bölümler (§5 rotation, §9 witness/retention, §10 CI, §12 closure format) salvageable.**

---

## Context (WHY)

### Problem
Üç ADR (017 ST Bytecode, 018 RBAC ABAC, 019 Firmware Signing + Sealed Provisioning) hepsi ed25519-based signed artifact'lere güveniyor. Ama **hiçbir yerde** şu soruların cevabı yok:
- Key'ler nerede üretiliyor?
- Özel anahtar nerede tutuluyor? (CI env var? Geliştirici laptop'u? HSM? Hangi HSM?)
- Kim imzalayabilir? Tek bir kişi mi, quorum mu?
- Compromise durumunda kaç saatte revoke propagate olur?
- 7 farklı key (ADR-019 §1) gerçekten ayrı HSM slot'larda mı, yoksa aynı HSM software bölümünde mi?
- Rotation ne zaman, nasıl?
- Post-quantum upgrade path var mı?
- Air-gap factory key'ler fiziksel olarak nerede tutulur? Nasıl erişilir?

Bu boşluk olmadan "5-key blast radius segregation" (ADR-018 §2) yaldızlı bir iddiadır: CI env var'da 5 farklı ed25519 private key olsa da, CI compromise = 5/5 key compromise = fleet takeover. Key segregation MEKANIK (HSM slot ayrılığı) + PROSEDÜREL (farklı kişiler, farklı onay zincirleri) OLMADAN güvenlik sıfırdır.

### Post-audit context (hazır)
Bu ADR'ın bir önceki taslağı yok; doğrudan final-revizyon olarak yazılmıştır. 3-agent audit bu ADR kabul edildikten sonra scope'a girecek.

### User direktifi
*"yama yok, arkadan dolanma yok, sonraya bırakma yok, geçiştirme yok, görmeden gelme yok"* → Bu ADR tüm key yaşam döngüsü sorularını kapatır. Partial answer = defer = yasak.

---

## Decision (WHAT)

**1. Canonical 7-slot HSM map (hardware-enforced segregation). 2. YubiHSM 2 + FIPS 140-2 Level 3 hardware; AWS KMS olarak disaster-recovery co-signer only. 3. FROST threshold Ed25519 (2-of-3 quorum) online slots için. 4. Offline root ceremony (air-gapped laptop, faraday cage, 4-eye witness). 5. Rotation schedule per-slot. 6. Compromise response playbook ≤15-dakika revoke propagation. 7. Rescue firmware path (primary compromise). 8. Cryptographic agility (Ed25519 → Ed448 → ML-DSA). 9. Witness testimony + 7-year retention + video. 10. CI-integrated signed build pipeline.**

### 1. Canonical 7-slot HSM map (downstream contract for ADR-017/018/019)

Aynı map ADR-019 §1'de tanımlı; burada **authoritative source**:

| Slot | Key name | Class | Ceremony | Storage | Rotation | Quorum (sign) | Verifier (edge-side) |
|------|----------|-------|----------|---------|----------|---------------|----------------------|
| 1 | `firmware_signing_key` | online | 4-eye | YubiHSM 2 primary; AWS KMS co-signer | 180 gün | 2-of-3 FROST | `updater::verify_firmware` |
| 2 | `rbac_manifest_signing_key` | online | 4-eye | YubiHSM 2 primary; AWS KMS co-signer | 180 gün | 2-of-3 FROST | `authz::verify_manifest` |
| 3 | `command_signing_root_key` | online | 4-eye | YubiHSM 2 primary; AWS KMS co-signer | 180 gün | 2-of-3 FROST | `authz::verify_command_envelope` (root chain) |
| 4 | `rescue_firmware_signing_key` | factory | cold | YubiHSM 2 air-gapped; physical vault | NEVER (re-flash required) | 3-of-5 FROST (ceremony) | `updater::verify_rescue_firmware` |
| 5 | `emergency_policy_signing_key` | factory | cold | YubiHSM 2 air-gapped; physical vault | NEVER (re-flash required) | 3-of-5 FROST (ceremony) | `authz::emergency::verify_emergency_policy` |
| 6 | `program_signing_key` | online | 4-eye | YubiHSM 2 primary; AWS KMS co-signer | 180 gün | 2-of-3 FROST | `st_compiler::verify_bytecode` (ADR-017 §6) |
| 7 | `provisioning_signing_key` | factory semi-air-gap | 4-eye | YubiHSM 2 semi-air-gap; accessed during provisioning runs only | 365 gün | 2-of-3 FROST (ceremony) | `provisioning::verify_blob` (ADR-019 §6) |

**Storage diagram:**

```
┌─────────────────────────────── PRIMARY DATACENTER ─────────────────────────────┐
│                                                                                  │
│  ┌──────────────────────────┐          ┌─────────────────────────────────────┐  │
│  │ YubiHSM 2 — Slot Group A │          │ Signing Service                      │  │
│  │  (online operational)    │          │  /apps/signing-service/              │  │
│  │                          │          │                                      │  │
│  │  Slot 1: firmware        │◄────────►│  - gRPC API, mTLS-only               │  │
│  │  Slot 2: rbac_manifest   │          │  - 2-of-3 FROST orchestration        │  │
│  │  Slot 3: command_root    │          │  - Witness log (signed, append-only) │  │
│  │  Slot 6: program_signing │          │  - Rate limiting per-key             │  │
│  │  Slot 7: provisioning    │          │  - Audit chain to SIEM               │  │
│  │  (semi-air-gap policy)   │          │                                      │  │
│  └──────────────────────────┘          └─────────────────────────────────────┘  │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────── DR REGION (cross-continent) ────────────────────────────┐
│                                                                                  │
│  ┌──────────────────────────┐                                                   │
│  │ AWS KMS + CloudHSM       │   FROST co-signer for slots 1/2/3/6              │
│  │  Multi-region replicated │   Emergency fallback if primary HSM unreachable   │
│  │  Slots 1/2/3/6 co-signer │   Quorum: 1-of-1 (AWS) + 1-of-2 (primary HSM)    │
│  └──────────────────────────┘                                                   │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘

┌───────────────────── OFFLINE ROOT CEREMONY VAULT ───────────────────────────────┐
│                                                                                  │
│  Physical vault (bank safe-deposit + biometric + dual-custodian access)         │
│                                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐      │
│  │ Cold YubiHSM 2 (offline, air-gapped, faraday cage)                    │      │
│  │                                                                        │      │
│  │  Slot 4: rescue_firmware_signing_key                                  │      │
│  │  Slot 5: emergency_policy_signing_key                                 │      │
│  │                                                                        │      │
│  │  Access: 3-of-5 FROST quorum + 4-eye + recorded ceremony               │      │
│  │  Ceremony frequency: initial provisioning + compromise response only  │      │
│  └──────────────────────────────────────────────────────────────────────┘      │
│                                                                                  │
│  Backup keyshares distributed 5 locations (Shamir Secret Sharing 3-of-5):       │
│   - Location 1: Primary ceremony site (Istanbul office safe)                     │
│   - Location 2: Legal counsel notarized envelope                                 │
│   - Location 3: DR ceremony site (air-gapped bunker)                             │
│   - Location 4: International dual-custodian (US-based trusted party)            │
│   - Location 5: Swiss bank safe-deposit                                          │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2. HSM selection rationale

**Primary: YubiHSM 2** (FIPS 140-2 Level 3, Common Criteria EAL5+)
- Native ed25519 + Ed448 + future PQ algorithms (firmware-updatable within same hardware)
- USB-A form factor → air-gap-able (disconnect = offline)
- 32 asymmetric key slots (more than enough for 7-slot map + rotation overlap)
- Per-slot audit log (tamper-resistant)
- Affordable (~€650/unit) → multiple-site distribution feasible
- Open-source SDK (yubihsm-connector, Rust bindings available)

**DR co-signer: AWS KMS + CloudHSM**
- Cross-region replication (us-east-1 + eu-west-1 + ap-southeast-1)
- Integrates with FROST 1-of-1 co-signing path
- Audit via AWS CloudTrail (7-year retention built-in)
- Latency p99 < 100ms (acceptable for daily signing operations)
- AWS KMS envelope encryption for backup keyshares at rest

**Alternative considered: Google Cloud HSM, Azure Key Vault Premium** — REDDET: AWS CloudTrail 7-year retention is industry-baseline for audit; GCP Cloud KMS audit logs retention 400-day default requires custom export pipeline (operational overhead); Azure Key Vault Premium costs roughly 2x AWS per 1k operations.

**Alternative considered: SoftHSM / cloud-only** — REDDET: SoftHSM = software in CI env var = "yaldız güvenlik"; cloud-only removes air-gap path for slots 4/5/7.

### 3. FROST threshold signatures — 2-of-3 online + 3-of-5 factory

**FROST (Flexible Round-Optimized Schnorr Threshold) Ed25519**

Problem ki single-quorum FROST çözer: tek kişi tek HSM ile imzalamayabilir. Threshold signature her key için N-of-M quorum zorunlu.

**Online slots (1, 2, 3, 6, 7):** 2-of-3 quorum
- Participant A: Security engineer 1 (YubiHSM primary)
- Participant B: Security engineer 2 (YubiHSM primary — physically separate device, same datacenter)
- Participant C: AWS KMS + CloudHSM (DR region)
- 2 imza yeterli → primary HSM compromise'da AWS KMS + bir online engineer = sign yapabilir; complete primary loss'ta DR region + cross-site takeover mümkün

**Factory slots (4, 5):** 3-of-5 quorum
- Participant A: Security lead (offline vault access)
- Participant B: Platform owner (offline vault access)
- Participant C: Legal counsel (notarized ceremony witness)
- Participant D: External auditor (signed witness testimony)
- Participant E: Backup custodian (Swiss bank)
- Ceremony rare: initial provisioning + compromise response only → 3 participant physical presence needed → insider threat ×3

**FROST advantages over naive Shamir Secret Sharing:**
- Private key ASLA reconstructed (no single-point exposure)
- Signing participants can be offline + online mix (AWS KMS + physical HSM)
- Signature verification identical to regular Ed25519 (downstream edge code unchanged)

**Implementation note:** Rust crate `frost-ed25519` (ZF Frost, maintained by Zcash Foundation) + YubiHSM 2 firmware 2.4+ supports FROST participant operations.

### 4. Offline root ceremony procedure

**Frequency:** Initial provisioning (once) + compromise response (rare) + slot 4/5 rotation (never scheduled; only post-compromise)

**Procedure:**

```
Pre-ceremony (14 days before):
  1. Schedule ceremony; 3-of-5 custodians confirm availability
  2. External auditor notified; non-disclosure agreement signed
  3. Ceremony room booked (physical vault access)
  4. Hardware prepared:
     - Offline YubiHSM 2 (factory-reset, sealed in tamper-evident bag)
     - Air-gapped laptop (Linux live USB; no persistent storage; no wireless)
     - Faraday cage (ceremony room)
     - Video recording equipment (multiple angles, tamper-evident storage)
  5. Software prepared:
     - signed keygen scripts on USB stick (verified SHA-256 by 2 independent engineers)
     - FROST DKG (Distributed Key Generation) tooling

Day of ceremony:
  T-0       All 3 custodians + external auditor present physically
            Video recording starts; room sealed
  T+0:05    Tamper-evident bags opened on camera; serials read aloud
  T+0:15    Laptop boot from live USB; air-gap verified (no wireless, no bluetooth)
  T+0:30    YubiHSM 2 connected to laptop; factory-reset verified
  T+0:45    FROST DKG ceremony:
            - Each custodian generates their keyshare on their own hardware token
            - 3 participant keyshares combined via FROST DKG (public key derived)
            - Private key NEVER exists in any single device
  T+1:30    Public key exported to ceremony transcript
  T+1:45    Each custodian's keyshare sealed in personal hardware token;
            tokens returned to respective locations immediately post-ceremony
  T+2:00    Ceremony transcript signed by 3 custodians + external auditor
            Video sealed in tamper-evident storage
            Written transcript SHA-256 hashes published cloud-side for 7-year retention
  T+2:30    Room opened; hardware returned to secure transport
  T+24h     Video cross-checked by independent security reviewer
  T+7d      Witness testimony signed (legal counsel notarizes)
  T+30d     Public key baked into firmware v2.0.0 released binary

Post-ceremony:
  - Public key → binary embedded const RESCUE_FIRMWARE_PUBKEY / EMERGENCY_POLICY_PUBKEY
  - Public key fingerprint → technical documentation (public repo OK; transparency)
  - Ceremony artifacts → legal hold (7-year retention, compliance archive)
  - Next ceremony: only on compromise response trigger
```

### 5. Rotation schedule — per-slot lifecycle

| Slot | Rotation period | Rotation procedure | Recovery path |
|------|----------------|---------------------|---------------|
| 1 firmware | 180 gün | Online 4-eye ceremony; 2-week overlap window (both old + new valid) | Rescue firmware (slot 4) |
| 2 rbac_manifest | 180 gün | Online 4-eye ceremony; (signing_key_epoch, version) tuple bumps | Manifest re-sign during overlap |
| 3 command_root | 180 gün | Online 4-eye ceremony; per-operator subkey rotations continuous | Delegation chain regeneration |
| 4 rescue_firmware | NEVER (unless compromised) | Only via full offline ceremony (§4) | Physical re-flash of entire fleet |
| 5 emergency_policy | NEVER (unless compromised) | Only via full offline ceremony (§4) | Physical re-flash |
| 6 program_signing | 180 gün | Online 4-eye; .stbc re-sign deployment wave | Platform re-compile source |
| 7 provisioning | 365 gün | 4-eye ceremony at factory site; re-provisioning wave to active fleet | Re-provisioning ceremony per device |

**Rotation orchestration (online slots 1, 2, 3, 6, 7):**

```
Day T-30  (30 days before planned rotation):
  - New keypair generated (FROST 2-of-3) — new epoch number (e)
  - Public key distributed via signed firmware/RBAC manifest update
  - Dual-signature window starts: artifacts signed with OLD key still accepted
  - Edge telemetry: key_rotation_pending{slot=N, target_epoch=e} counter

Day T-14 (14 days before):
  - 50% of fleet has received new pubkey (rolling update)
  - Alert if < 90% reached by T-7: investigate laggard tenants

Day T-0 (rotation day):
  - New key signs all artifacts going forward
  - Old key revoked at HSM (slot destroyed in primary + AWS KMS + DR)
  - Telemetry: key_rotation_complete{slot=N, epoch=e}
  - 2-week soft-window: old-key-signed-artifacts REJECTED by edge
    (signing_key_epoch check — ADR-018 §6, ADR-019 §3)

Day T+14 (cleanup):
  - All old-epoch artifacts archived per compliance
  - Key ceremony artifacts finalized + retained
  - Next rotation scheduled T+180 days
```

### 6. Compromise response playbook — ≤15-minute revoke propagation SLO

**Trigger events:**
- HSM audit log anomaly
- Insider threat report
- Unauthorized ceremony access detected
- Platform signing service breach detected
- Key share custodian report compromise

**Response tree:**

```
T+0       Incident declared; security lead paged
T+5m      Incident commander assembles response team
          - Security engineers (2): HSM access + signing service logs
          - Platform engineer (1): deploy pipeline freeze
          - Legal counsel (1): regulatory notification prep
          - Communications lead (1): tenant notification prep

T+5..10m  Containment:
          - Signing service disabled (kubectl scale to 0 for /apps/signing-service)
          - YubiHSM 2 physical removal if on-prem compromise suspected
          - AWS KMS CMK disabled via AWS console
          - CI pipeline blocks (GitHub Actions workflow dispatch disabled)

T+10..15m Rescue manifest prepared:
          - Offline ceremony invocation decision (slots 4/5 required? usually YES for slot 1/2/3 compromise)
          - Rescue firmware manifest signed by slot 4 (factory cold HSM in vault)
          - Contains: compromised epoch rejection rule + new-key pubkey + forced rescue_trigger

T+15m     Revoke propagation:
          - rescue_trigger.signed pushed via MQTT broadcast
          - All edge devices boot rescue slot within 5 minutes (auto-detected rescue_trigger)
          - Compromised key epoch rejected fleet-wide
          - SLO: 15-minute full fleet revoke

T+15m..4h Recovery:
          - New ceremony scheduled
          - New keypair generated (not compromised path)
          - New firmware/manifest signed with new key
          - Fleet returns to primary slot with new-key firmware

T+4..48h  Post-incident:
          - Forensics on HSM audit logs
          - Root cause analysis
          - Custodian testimony review
          - Tenant notification (regulatory: GDPR 72-hour breach notification)
          - Incident report signed by security lead + legal counsel

T+7d      Public disclosure (if applicable):
          - Transparent post-mortem (following Anthropic/Cloudflare precedent)
          - Regulatory filings (if data-breach triggers apply)
          - Updated runbook based on learnings

T+30d     Audit certification:
          - Independent auditor reviews compromise response
          - Ceremony re-certification
          - Fleet returns to normal operations
```

**Compromise response runbook:** `docs/runbooks/edge-compromise-response.md` (Faz 10 Plan §5 deliverable; owned by security lead; 7-year retention).

### 7. Rescue path — slot 4 + slot 5 factory keys never compromised simultaneously

**Design invariant:**
- Slot 1-3, 6, 7 (online keys) can be compromised via online attack surface
- Slot 4 + 5 (factory keys) accessible ONLY via physical offline ceremony → online attack surface ZERO
- Rescue = slot 4 signs rescue firmware → edge boots rescue → rejects compromised epoch → re-provisioning wave with new online keys
- Slot 5 signs emergency policy → override fleet into life-safety-only mode (aerator override + safe-state) until re-provisioning

**Double-compromise (catastrophic) scenario:**
- Slot 4 AND slot 5 both compromised simultaneously = fleet physical re-flash (no software recovery path)
- This requires: physical vault access compromise + 3-of-5 custodian compromise + ceremony integrity breach → adversary capability = nation-state OR insider collusion at multiple geographic sites
- Mitigation: custodian geographic diversity (5 locations across 3 continents); annual penetration-test of ceremony procedure; legal counsel + external auditor presence at every ceremony

### 8. Cryptographic agility — Ed25519 → Ed448 → ML-DSA path (STL-008 kapama)

```rust
// WHY: Post-quantum adversary eventuality; ed25519 break timeline unknown but bounded.
// WHAT: Binary supports multiple algorithms; active algorithm selected via key ceremony version.
// INVARIANT: Edge binary NEVER downgrades algorithm; cloud can upgrade via new key ceremony.

pub enum SigningAlgorithm {
    Ed25519,     // current baseline (2026)
    Ed448,       // stronger classical (larger signature, same attack model)
    MlDsa65,     // NIST PQC standard (ML-DSA aka Dilithium, ~2028 target)
}

pub struct EdgeTrustAnchor {
    pub firmware_signing_pubkey: AlgorithmKeyed<VerifyingKey>,
    pub rbac_manifest_signing_pubkey: AlgorithmKeyed<VerifyingKey>,
    // ... (7 slots × 3 algorithms = 21 pubkey slots in binary; acceptable size ~10 KB)
}

pub struct AlgorithmKeyed<T> {
    pub alg: SigningAlgorithm,
    pub key: T,
    pub key_ceremony_version: u32,  // which ceremony established this key
}

// Migration path:
// Phase 1 (2026-2027): Ed25519 baseline
// Phase 2 (2028): Ed25519 + ML-DSA dual-signing (key ceremony v2)
//   - New keys signed with both algorithms
//   - Edge accepts either during transition
// Phase 3 (2030): ML-DSA primary; Ed25519 deprecated
//   - New key ceremony v3 uses ML-DSA only
//   - Old Ed25519 keys revoked
```

**Binary overhead:** 7 slots × 3 algorithms × 96 bytes max (ML-DSA pubkey) = ~2 KB for algorithm-keyed trust anchors. Acceptable.

### 9. Witness testimony + 7-year retention

**Every ceremony (online 4-eye + offline 3-of-5):**

- Video recording (multiple angles; ceremony room tamper-evident storage)
- Signed witness testimony (3 custodians + external auditor + legal counsel)
- Written transcript SHA-256 + published cloud-side (public fingerprint — transparency)
- 7-year retention minimum (compliance baseline; legal-hold extends as needed)
- Annual audit by independent security firm (IEC 62443 SL-2 evidence package contribution)

**Transparency vs secrecy trade-off:**
- PUBLIC: ceremony date, attendees (roles not individuals), public keys, algorithm choices, transcript fingerprint
- PRIVATE: custodian identities, physical location, specific procedural details, video content (legal-hold)
- Rationale: adversary cannot use public info to bypass ceremony; transparency builds regulatory trust

### 10. CI-integrated signed build pipeline

```yaml
# .github/workflows/edge-agent-release.yml (excerpt)
name: Edge Agent Release
on:
  workflow_dispatch:
    inputs:
      version:
        required: true

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<sha>
      - name: Reproducible build
        env:
          SOURCE_DATE_EPOCH: ${{ inputs.source_date_epoch }}
        run: cargo build --release --locked
      # ... cross-compile matrix (aarch64 + armv7 + x86_64)

  sign:
    needs: build
    runs-on: [self-hosted, signing-enclave]  # dedicated runner with HSM access
    steps:
      - name: FROST 2-of-3 sign firmware manifest
        uses: ./.github/actions/frost-sign
        with:
          slot: 1                    # firmware_signing_key
          hsm-connector-primary: ${{ secrets.HSM_CONNECTOR_PRIMARY }}
          hsm-connector-secondary: ${{ secrets.HSM_CONNECTOR_SECONDARY }}
          aws-kms-key-id: ${{ secrets.AWS_KMS_FIRMWARE_KEY_ID }}
          manifest-path: ./target/release/firmware-manifest.json
      # ... witness log + SLSA L3 attestation

  release:
    needs: sign
    steps:
      - name: Publish signed artifacts
        run: |
          gh release create v${{ inputs.version }} \
            --verify-tag \
            --notes-file RELEASE_NOTES.md \
            ./target/release/*.tar.gz \
            ./target/release/*.manifest.sig \
            ./target/release/*.intoto.jsonl    # SLSA provenance
```

**Signing runner security:**
- Self-hosted GitHub Actions runner in dedicated physical location (signing enclave)
- Hardware: YubiHSM 2 + dedicated laptop + faraday cage (for cold operations)
- Network: isolated VLAN; outbound only to signing service + GitHub + AWS KMS
- Access: 2FA + per-engineer audit log
- Build isolation: every build in fresh container; no persistent state between builds
- Witness log: append-only signed by runner's per-machine key (outside the 7 primary slots)

### 11. Disaster recovery — HSM hardware failure

**Primary HSM failure (slots 1, 2, 3, 6, 7):**
- AWS KMS co-signer continues for 2-of-3 FROST (degraded to 1-AWS + manual approval flow)
- Procurement: replacement YubiHSM 2 in 48-72h
- Recovery: offline ceremony NOT required; new HSM provisioned with FROST keyshare regenerated (old keyshare from vault backup)
- SLO: 72h recovery from hardware failure

**Offline HSM failure (slots 4, 5):**
- Rescue firmware + emergency policy keys stored via Shamir 3-of-5 at 5 geographic locations (§1 diagram)
- Recovery: re-constitute keyshare via custodian convocation; physical travel required; 7-14 day SLO
- During recovery: no new rescue firmware possible; existing rescue firmware remains valid

**AWS KMS region-wide outage:**
- FROST 2-of-3 degrades to 2-primary (both YubiHSM 2 online); signing continues
- If primary HSM ALSO compromised/unavailable during AWS outage → signing pause 24-72h
- Mitigation: multi-AWS-region CloudHSM + secondary cloud provider (GCP Cloud KMS as tertiary co-signer — future phase)

---

## Alternatives Considered

### Alt-1 Single-key-per-concern, no threshold
Single point of custody → insider threat × 1 compromises key; REDDET — SL-2 insufficient.

### Alt-2 Shamir Secret Sharing without FROST
Secret reconstruction at signing time exposes full private key momentarily; REDDET — FROST eliminates this.

### Alt-3 Cloud HSM only (no physical air-gap)
Slots 4/5 on cloud = online attack surface ≠ factory air-gap; REDDET — defense-in-depth invariant violated.

### Alt-4 Single-algorithm (Ed25519 only, no PQ migration)
Post-quantum adversary timeline 10-20 years; REDDET — cryptographic agility is steel-grade requirement.

### Alt-5 PKCS#11 generic HSM API without vendor lock
PKCS#11 doesn't expose FROST participant operations natively; custom extensions vendor-specific anyway; REDDET — YubiHSM 2 vendor lock accepted.

### Alt-6 Google Cloud HSM / Azure Key Vault Premium (DR)
Audit retention / cost tradeoffs unfavorable vs AWS; REDDET with re-evaluation trigger (Faz 10 cost review).

---

## Consequences

### Positive
- **True key segregation:** 7 slots on hardware-enforced boundaries; insider threat × 3 needed for any single online slot compromise
- **SL-2 adversarial green:** ceremony procedure + rotation + compromise response + witness testimony = regulatory-grade evidence
- **Compromise response SLO:** ≤15-min revoke fleet-wide via rescue_trigger.signed MQTT broadcast
- **Cryptographic agility:** PQ migration path defined; binary supports 3 algorithms simultaneously
- **Factory air-gap:** slots 4+5 physically inaccessible via online attack surface; catastrophic-compromise requires nation-state + insider collusion at 3+ sites
- **Audit trail:** 7-year retention; video + written + signed witness testimony; annual independent audit
- **Reproducible pipeline:** SOURCE_DATE_EPOCH + signed runner + SLSA L3 attestation chain
- **Disaster recovery:** HSM hardware failure 72h; offline HSM failure 7-14d; cloud region outage 24-72h

### Negative
- **Capital expenditure:** 4× YubiHSM 2 (2 primary + 2 DR) = ~€2600; AWS KMS ongoing ~$200/month; Swiss bank safe-deposit ~$500/year; external auditor ~$15k/year; total Y1 ~$25k
- **Operational complexity:** FROST ceremony orchestration; 4-eye signing for every firmware release; 15-minute sign latency vs previous "developer laptop signs"
- **Ceremony rare but disruptive:** offline ceremony 8-12 hours; travel + physical coordination
- **Custodian overhead:** 5 custodians × annual training + travel + witness responsibility; custodian turnover procedure needed
- **Vendor dependency:** YubiHSM 2 hardware + AWS KMS = 2 vendor dependencies; mitigated by algorithm agility (vendor-independent) + offline ceremony path (vendor-independent)
- **Implementation kod:** `libs/backend-common/src/signing/` ~1500-2000 satır (FROST orchestration + HSM connector + CI integration); `/apps/signing-service/` ~2000-2500 satır

### SL-3 future (ADR-023 scope)
- Post-quantum migration Phase 2 start
- Remote attestation integration (TPM PCR → signing service policy check)
- Secure boot OTP fuse provisioning (factory-only, requires hardware refresh)

---

## 12. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| DEC-008 | HIGH | §1 + §2 + §3 + §4 | Full HSM selection + ceremony + FROST + rotation |
| STL-008 | MEDIUM | §8 | Ed25519 → Ed448 → ML-DSA migration path |
| SEC-002 downstream | CRITICAL | §1 slot 1 + §5 rotation + §6 compromise | Firmware signing key lifecycle |
| SEC-004 downstream | HIGH | §1 slot 7 provisioning + ADR-019 §7 master key | Provisioning chain |
| ADR-017 BLOCKER | — | §1 slot 6 program_signing | Bytecode signing key source |
| ADR-018 BLOCKER | — | §1 slots 1-5 + §7 rescue | RBAC trust root foundation |
| ADR-019 BLOCKER | — | §1 canonical 7-slot map | Firmware + sealed tenant binding |

---

## 13. Implementation Plan (Plan §5 Faz 2 + Faz 0 procurement)

**Faz 0 (procurement kick-off):**
- Sprint 0.1: YubiHSM 2 × 4 orderlı (lead time 2-4 weeks)
- Sprint 0.2: AWS KMS + CloudHSM multi-region setup
- Sprint 0.3: Offline ceremony vault site selection (Istanbul office safe-deposit)
- Sprint 0.4: External auditor contract (annual engagement + compromise-response retainer)
- Sprint 0.5: Legal counsel briefing (ceremony notarization + 7-year retention compliance)

**Faz 2 (key ceremony + signing service):**
- Sprint 6.3: FROST Rust crate integration (`frost-ed25519`)
- Sprint 7.4: Offline ceremony execution — slots 4 + 5 generated (one-time)
- Sprint 8.4: Online ceremony execution — slots 1, 2, 3, 6, 7 generated
- Sprint 8.5: `/apps/signing-service/` implemented (gRPC + mTLS + FROST orchestration)
- Sprint 8.6: CI signing workflow integration (`.github/actions/frost-sign`)
- Sprint 9.1: Compromise response tabletop exercise (security team + external auditor)
- Sprint 9.2: Public key fingerprints published + firmware v2.0.0 binary embedded

**Acceptance criteria (Faz 2 close):**
- All 7 slots keyed + active signing
- FROST 2-of-3 + 3-of-5 ceremonies completed + witness testimonies signed
- First signed firmware + RBAC manifest + bytecode + provisioning blob deployed to pilot tenant
- Compromise response tabletop exercise scored ≥4/5 by external auditor
- SLSA L3 attestation verified on CI artifact
- IEC 62443 SL-2 adversarial re-audit: FR2 + FR3 + FR4 green
- Status → Accepted
- **ADR-017 + ADR-018 + ADR-019 unblocked (their BLOCKER status cleared)**

---

## References

- FROST: Flexible Round-Optimized Schnorr Threshold Signatures — IETF draft-irtf-cfrg-frost
- `frost-ed25519` Rust crate (Zcash Foundation): https://github.com/ZcashFoundation/frost
- YubiHSM 2 product specifications: https://www.yubico.com/products/hardware-security-module/
- AWS KMS: https://aws.amazon.com/kms/ + CloudHSM: https://aws.amazon.com/cloudhsm/
- NIST FIPS 140-2 Level 3 certification process
- Common Criteria EAL5+ evaluation methodology
- NIST PQC Standardization: ML-DSA (Module-Lattice-based Digital Signature Algorithm)
- SLSA (Supply-chain Levels for Software Artifacts) framework
- IEC 62443-3-3 SL-2 FR2/FR3/FR4 controls
- GDPR Article 33 (72-hour breach notification)
- `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §3 R-4, §4.9, §5 Faz 0
- ADR-017 (consumer: slot 6 program_signing)
- ADR-018 (consumer: slots 1-5 for 5-key RBAC segregation)
- ADR-019 (consumer: canonical 7-slot map + slot 7 provisioning)
- ADR-020 (DEC-019 — audit HMAC chain integration for ceremony events)
- ADR-023 (DEC-017 — SL-3 PQ migration + remote attestation)
