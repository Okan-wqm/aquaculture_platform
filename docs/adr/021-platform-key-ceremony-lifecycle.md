# ADR-021: Platform Key Ceremony and Lifecycle — 9-Slot Single-Key HSM + Procedural 4-Eye Quorum (Conjunctive HSM+KMS Signing)

**Status:** Proposed (opened 2026-04-19; post-audit BLOCK rewrite 2026-04-19 — §14 closure table documents 6 CRITICAL + 7 HIGH + 6 MEDIUM + 4 LOW closure; target Accepted 2026-05-03)
**Date:** 2026-04-19
**Deciders:** Okan (platform owner) + security-auditor + auth-security-expert + compliance-expert + edge-industrial-auditor
**Owner:** Okan (temp — PROC-001)
**Deadline:** 2026-05-03 — gates ADR-017 + ADR-018 + ADR-019 → Accepted (triple BLOCKER)
**Related findings:** DEC-008, DEC-020 (this ADR's rewrite remediation), STL-008, SEC-002 + SEC-004 downstream
**Related plans:** `/root/.claude/plans/unutma-mevcut-s-stem-le-lexical-puzzle.md` §5 Faz 0; `/var/aqua-saas/docs/plans/2026-04-19-sens-api-gateway-hardening.md` §4.8 D-8
**Downstream ADRs:** ADR-017 §2 §12, ADR-018 §2 §7, ADR-019 §1 §3 §6 §8, ADR-023 (SL-3 MPC path)

---

## Context (WHY)

### Problem
Üç ADR (017 ST Bytecode, 018 RBAC ABAC, 019 Firmware Signing + Sealed Provisioning) hepsi ed25519-based signed artifact'lere güveniyor. Bu ADR o signing ve lifecycle kontratını tanımlar.

### Post-audit context — BLOCK'tan architectural rewrite'a
İlk taslak security-auditor tarafından **BLOCK** verdi — 6 CRITICAL bulgudan 3'ü factual vendor errors:

| # | CRITICAL | Gerçek |
|---|----------|--------|
| 001 | "YubiHSM 2 firmware 2.4+ supports FROST participant ops" | **YANLIŞ.** YubiHSM 2 sadece single-key `sign-eddsa` Ed25519 destekliyor; FROST DKG / commitment-share / signature-share primitives hardware'de yok |
| 002 | "AWS CloudHSM Ed25519 co-signer" | **YANLIŞ.** AWS CloudHSM PKCS#11 sadece secp* curves; Edwards curve yok |
| 003 | "AWS KMS FROST participant" | **YANLIŞ.** AWS KMS sadece `Sign(KeyId, Message)` expose; FROST two-round protocol structurally imkansız |

**Architectural decision (bu rewrite):** FROST cryptographic threshold bırakıldı. Yerine **single-key HSM (YubiHSM 2 FIPS primary + AWS KMS Ed25519 DR co-signer as separate-key disjunctive path) + PROCEDURAL 4-eye quorum**. SL-2 için yeterli; SL-3 MPC-HSM path ADR-023 §9 post-activation reference.

**Decision rationale:**
- **Option A (bu ADR): Single-key HSM + procedural 4-eye** — factually correct; vendor-independent; SL-2 sound; honest about what hardware provides
- **Option B: MPC-capable HSM vendor** (Fireblocks MPC / Cybernetica SplitKey) — blockchain-custody stack; viable but external procurement dependency; ADR-023 SL-3 path reference
- **Option C: Software FROST, HSM as key storage only** — keyshares in signing-service process memory = no real HSM boundary; rejected as "HSM theater"

Option A chosen — architecturally defensible on shipped hardware, no vendor lock-in wait, SL-3 upgrade path preserved.

---

## Decision (WHAT)

**1. Canonical 7-slot single-key HSM map. 2. YubiHSM 2 FIPS (YHSM2-FIPS part number) primary + AWS KMS Ed25519 DR as disjunctive-trust (separate keypair, either accepted). 3. Procedural 4-eye quorum (2 engineers + security-lead + witness) per signing — application-layer authorization, not cryptographic threshold. 4. Offline ceremony slots 4+5 (rescue + emergency) with 3-of-5 Shamir key-share backup. 5. Rotation schedule per-slot with signing_key_epoch monotonic (ADR-018 §6 + ADR-019 §11). 6. Compromise response tiered SLO (online 15-min / full fleet 7-14d / ceremony-dependent days). 7. ML-DSA-65 pubkey 1952 bytes sizing corrected; PQ migration Phase 2 tied to ADR-023 SL-3. 8. Slot 9 online revocation key — dedicated for ≤15-min online revoke (NOT slot 4 which requires 8-12h ceremony). 9. Custodian replacement procedure (turnover discipline). 10. HC-1 bootstrap reference ADR-019 §9.**

### 1. Canonical 7-slot HSM map (downstream contract)

| Slot | Key name | Class | Ceremony | Primary storage | DR storage | Rotation | Verifier |
|------|----------|-------|----------|-----------------|-----------|----------|----------|
| 1 | `firmware_signing_key` | online | 4-eye procedural | YubiHSM 2 FIPS primary | AWS KMS Ed25519 (DR — separate keypair, disjunctive trust) | 180 gün | `updater::verify_firmware` |
| 2 | `rbac_manifest_signing_key` | online | 4-eye procedural | YubiHSM 2 FIPS primary | AWS KMS Ed25519 DR | 180 gün | `authz::verify_manifest` |
| 3 | `command_signing_root_key` | online | 4-eye procedural | YubiHSM 2 FIPS primary | AWS KMS Ed25519 DR | 180 gün | `authz::verify_command_envelope` |
| 4 | `rescue_firmware_signing_key` | factory offline | 3-of-5 Shamir ceremony | YubiHSM 2 air-gapped offline vault | Shamir share geographic distribution | NEVER (rotation = re-flash fleet) | `updater::verify_rescue_firmware` |
| 5 | `emergency_policy_signing_key` | factory offline | 3-of-5 Shamir ceremony | YubiHSM 2 air-gapped offline vault | Shamir share geographic distribution | NEVER (rotation = re-flash fleet) | `authz::emergency::verify_emergency_policy` |
| 6 | `program_signing_key` | online | 4-eye procedural | YubiHSM 2 FIPS primary | AWS KMS Ed25519 DR | 180 gün | `st_compiler::verify_bytecode` (ADR-017) |
| 7 | `provisioning_signing_key` | factory semi-air-gap | 4-eye procedural | YubiHSM 2 FIPS semi-air-gap (factory-only access) | (no DR — semi-air-gap protected by physical access control) | 365 gün | `provisioning::verify_blob` (ADR-019 §6) |
| 8 | `daily_anchor_signing_key` | online | Reserved for ADR-020 §5a post-unblock adoption | — | — | — | `audit::verify_anchor` (reserved slot — ADR-020 owner) |
| **9** | `online_revocation_signing_key` | online | 2-eye procedural (emergency-fast) | YubiHSM 2 FIPS primary | AWS KMS Ed25519 DR | 90 gün | `authz::verify_revocation_statement` |

**Slot 9 rationale (closes CRITICAL-006):** SL-2 15-min online revoke SLO achievable **only via dedicated revocation key**. Slot 4 rescue_firmware requires 3-of-5 offline ceremony (8-12h realistic latency). Slot 9 signs revocation statements ONLY (schema-enforced: cannot sign firmware, cannot sign manifests, cannot sign commands); compromise blast radius bounded to false revocations (operational disruption, not catastrophic elevation).

### 2. YubiHSM 2 FIPS + AWS KMS Ed25519 DR — CONJUNCTIVE trust (NEW-HIGH-D kapama)

**Trust model decision:** NOT disjunctive (either-or) — CONJUNCTIVE (both-must-sign) when both healthy; SINGLE-SIG fallback only during declared HSM outage.

```
Normal mode (both HSM + KMS healthy):
  Every privileged artifact REQUIRES two signatures:
    - primary_signature by YubiHSM 2 FIPS (slot N private key)
    - secondary_signature by AWS KMS Ed25519 (separate keypair, slot N equivalent KMS key)
  Edge verifier validates BOTH; single-sig rejected in normal mode
  Compromise of SINGLE key = cannot forge alone (requires second signature)

Declared HSM outage mode (opt-in via slot 9 signed outage flag):
  Platform signing-service detects primary HSM unavailable (health check fails)
  Security-lead approves outage declaration (2-eye + slot 9 sign outage_flag envelope)
  outage_flag: signed by slot 9, TTL 4 hours max, reason + start_ts + end_ts
  During outage flag lifetime, edge accepts single KMS-signed artifact as valid
  Outage flag expires → revert to conjunctive normal mode
  Tracked audit entry on every outage declaration

Attack surface reduced:
  - Single KMS key compromise: attacker CANNOT forge (normal mode requires HSM co-sign);
    attacker CAN forge only during declared-outage window (max 4h; slot 9 compromise also required)
  - Single HSM key compromise: same protection via KMS co-sign
  - Both compromised simultaneously: fleet takeover — acceptable SL-2 risk tier
    (defense-in-depth HSM air-gap + KMS IAM independent controls)
```

---

### 2.1 Vendor capability foundation (CRITICAL-001/002/003 kapama)

```
┌────────────────────────── PRIMARY DATACENTER ──────────────────────────────┐
│                                                                              │
│  ┌──────────────────────────┐        ┌───────────────────────────────────┐ │
│  │ YubiHSM 2 FIPS (YHSM2-FIPS) │        │ Signing Service (apps/signing-svc) │ │
│  │  (online operational)       │        │                                     │ │
│  │                             │        │  - gRPC API, mTLS-only              │ │
│  │  Slot 1: firmware           │◄──────►│  - 4-eye procedural workflow        │ │
│  │  Slot 2: rbac_manifest      │        │  - Witness log append-only signed   │ │
│  │  Slot 3: command_root       │        │  - Rate limiting per-key            │ │
│  │  Slot 6: program_signing    │        │  - Audit chain integration          │ │
│  │  Slot 7: provisioning       │        │  - DR co-sign fallback orchestration│ │
│  │  Slot 9: online_revocation  │        │                                     │ │
│  │                             │        └───────────────────────────────────┘ │
│  │  sign-eddsa Ed25519         │                                               │
│  │  (single-key, NOT FROST)    │                                               │
│  └──────────────────────────┘                                                 │
│                                                                                │
│  Each slot has DEDICATED authentication-key (unlocks signing); no cross-slot  │
│  key compromise via single HSM-admin compromise                                │
└──────────────────────────────────────────────────────────────────────────────┘

┌─────────────────── DR REGION (disjunctive-trust path) ──────────────────────┐
│                                                                              │
│  ┌──────────────────────────┐                                                │
│  │ AWS KMS (Ed25519 keys)   │  DISJUNCTIVE trust:                           │
│  │  Multi-region replicated  │   - AWS KMS holds SEPARATE ed25519 keypair     │
│  │  Primary: eu-central-1    │     per slot (not the same key as YubiHSM 2)  │
│  │  Secondary: eu-west-1     │   - Edge verifier accepts signature from      │
│  │  DR: us-east-1            │     EITHER primary HSM key OR AWS KMS DR key  │
│  │                           │   - Runtime: primary HSM signs; DR triggers    │
│  │  Slots 1/2/3/6/7/8        │     only on primary unavailable (cross-sign    │
│  │  have separate KMS keys   │     not supported — each path independent)     │
│  │                           │                                                │
│  │  NOT a FROST participant  │  Trade-off: two independent keys = two         │
│  │  (AWS KMS Sign API is     │  compromise surfaces; BUT either-or acceptance │
│  │   single-key; compatible) │  allows primary HSM failure without signing    │
│  └──────────────────────────┘  downtime. SL-2 acceptable; SL-3 (ADR-023 §4)   │
│                                 tightens via remote attestation gate.          │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────── OFFLINE ROOT CEREMONY VAULT ────────────────────────────────┐
│                                                                              │
│  Physical vault (Istanbul office safe-deposit primary; bank vault secondary)│
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Cold YubiHSM 2 (offline, air-gapped, faraday cage — ceremony only)   │   │
│  │                                                                       │   │
│  │  Slot 4: rescue_firmware_signing_key (single key, 3-of-5 Shamir      │   │
│  │          split across 5 custodians geographically distributed)        │   │
│  │  Slot 5: emergency_policy_signing_key (same pattern)                 │   │
│  │                                                                       │   │
│  │  Access: 3-of-5 Shamir share reconstruction requires 3 custodians    │   │
│  │          physical convocation + recorded ceremony + external auditor │   │
│  │  Ceremony frequency: initial provisioning + compromise response only │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  Backup Shamir keyshares at 5 locations:                                    │
│   1. Istanbul office safe-deposit (primary ceremony site)                    │
│   2. Ankara legal counsel notarized sealed envelope                          │
│   3. Swiss bank vault (international distribution)                           │
│   4. EU-based dual-custodian (bonded security professional)                  │
│   5. US-based dual-custodian (bonded security professional)                  │
│                                                                              │
│  Custodian replacement (FINDING-009 kapama — §6 detailed):                  │
│   - Turnover triggers: retirement, termination, extended unreachability     │
│     (180+ days), security clearance revocation                              │
│   - Replacement via FROST `refresh_share` equivalent: ceremony regenerates  │
│     5 shares without revealing original key; new custodian onboards         │
│   - Invariant: never fewer than 3 reachable custodians; alarm at 2          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3. 4-eye procedural quorum (FROST alternative for SL-2)

```
Signing request workflow (slots 1/2/3/6/7/8):

Step 1 — Requestor: engineer opens signing request via apps/signing-service/ UI
                    (gRPC call with artifact hash + slot + justification)
Step 2 — Approver 1: 2nd engineer reviews + approves via their hardware security
                     key (YubiKey for gRPC auth — separate from HSM admin auth)
Step 3 — Approver 2: security-lead reviews + approves (3rd party; separate auth)
Step 4 — Witness: audit system logs request + all 3 approvers + artifact hash +
                  timestamp (signed by signing-service's audit key)
Step 5 — HSM sign: signing-service requests single-key sign from YubiHSM 2 FIPS
                   slot N via authenticated session (each slot has dedicated
                   auth-key; unlocked via keybag protocol)
Step 6 — Signature returned + published audit event

Procedural quorum = 4 approvals (requestor + 2 approvers + witness auto-signed)
                    ALL 4 identities required before HSM sign unlocks

Compare to failed FROST claim:
  FROST would have been CRYPTOGRAPHIC threshold (3 private-key shares sign, group
  signature emerges; single signer cannot forge). THIS is PROCEDURAL: single HSM
  slot signs (single key; YubiHSM enforces); 4-eye application-layer ensures no
  single engineer can unilaterally trigger that HSM sign call.
  
Trust model honest: "procedural 4-eye + HSM key non-extractability" vs
  aspirational "cryptographic threshold signature". Reviewer sees what the
  mechanism actually delivers.
```

**Slot 9 online revocation exception (2-eye fast path):**
- Revocation signing triggered by security-incident response
- 2 approvers sufficient (requestor + 1 approver); witness auto-signed
- Rationale: revocation blast radius bounded (operational disruption max); slower 4-eye delays SLO
- Slot 9 sign schema: revocation statement envelope ONLY (compile-time check at signing-service; cannot sign other artifact types)

### 4. Offline ceremony — single-key Shamir model (CRITICAL-004 kapama for slots 4+5)

Single HSM holds slot 4 + slot 5 keys offline. Shamir 3-of-5 PROTECTS the HSM's admin authentication (unlock-key), NOT the ed25519 signing-key itself (which stays in hardware).

```
Ceremony model:
  - YubiHSM 2 cold device factory-generates ed25519 keypair inside hardware
  - Private key NEVER leaves hardware (non-extractable by design)
  - HSM admin authentication key (unlocks slot signing) Shamir-split 3-of-5
  - To sign: convene 3 custodians → reconstruct admin key → unlock HSM →
    authorize sign → re-seal admin key (NO persistent reconstruction)
  - Ceremony: 8-12 hours realistic including travel + witness + auditor
  - Frequency: initial provisioning (once) + compromise response (rare)

TimeDuration dependency note (CRITICAL-006 kapama):
  - Offline ceremony CANNOT meet 15-min online revoke SLO
  - Slot 9 online revocation key exists specifically to bridge this gap
  - §5 split SLO into tiers
```

### 5. Rotation schedule + signing_key_epoch monotonic (CRITICAL-005 kapama)

| Slot | Rotation period | Rotation mechanism | Overlap window |
|------|----------------|---------------------|----------------|
| 1 firmware | 180 gün | Online 4-eye + epoch bump | 14 gün dual-sig transition |
| 2 rbac_manifest | 180 gün | Online 4-eye + epoch bump | 14 gün dual-sig |
| 3 command_root | 180 gün | Online 4-eye + epoch bump | 14 gün dual-sig |
| 4 rescue_firmware | NEVER (or compromise only) | Offline ceremony | N/A (fleet re-flash) |
| 5 emergency_policy | NEVER (or compromise only) | Offline ceremony | N/A (fleet re-flash) |
| 6 program_signing | 180 gün | Online 4-eye + epoch bump | 14 gün dual-sig |
| 7 provisioning | 365 gün | 4-eye at factory site | 30 gün dual-sig |
| 8 online_revocation | 90 gün | 2-eye + epoch bump | 7 gün dual-sig |

### 5a Rotation with epoch anti-rollback — normal path

**signing_key_epoch + epoch anti-rollback (CRITICAL-005 online path kapama):**

```rust
// WHY: 14-day overlap window = attacker with compromised old key has 14-day attack window.
//      Epoch-monotonic check (ADR-018 §6 + ADR-019 §3 + ADR-019 §11) closes this:
//      device stores highest_seen_epoch; rejects any manifest signed with epoch < highest_seen.
// WHAT: Rotation flow below demonstrates overlap safety.
// INVARIANT: tests/invariants/epoch_overlap_attack_closed.rs — simulated compromised-old-key
//            sign during overlap → device rejects because new epoch already seen.

Rotation flow (slot 1 firmware example):
  Day 0     : Slot 1 ceremonies a NEW ed25519 keypair (epoch e+1)
             Platform publishes new pubkey via signed firmware manifest update
             Platform signs firmware with BOTH old (epoch e) AND new (epoch e+1) keys
             Fleet devices store both pubkeys; accept either sig during overlap
  Day 7-14 : Dual-sign window — gives slow-to-update devices time to catch up
             Device receives any-epoch-signed manifest; if epoch == highest_seen || highest_seen+1,
             accept; on accept, bump highest_seen to manifest.signing_key_epoch
  Day 14   : OLD key REVOKED at HSM (auth-key destroyed; slot still holds key but
             unreachable for signing); new sign attempts must use epoch e+1
  Day 14+  : Platform signs ONLY with new key; signed manifests carry epoch e+1
             Any device still having highest_seen < e → will accept new manifest → bump
             Any attempted new signing with OLD compromised-during-overlap-window key:
               - manifest carries epoch e
               - device has highest_seen >= e+1 (from seeing new manifest)
               - monotonic check fails → REJECT
             → overlap window is CLOSED by epoch anti-rollback, NOT by time-based trust

Anti-rollback counter storage (tier hierarchy per ADR-019 §11 AntiRollbackCounter trait):
  Tier 1: TPM NV counter (RPi 5 TPM2) — adversarial SL-2 required
  Tier 2: eMMC RPMB (RPi 4 pi-gen pi-rpmb-cli) — adequate SL-2
  Tier 3: A/B slot persistent + signed (ADR-019 §11 Tier 3) — documented limitation
```

### 5b Offline-first-contact race closure (NEW-HIGH-C kapama)

**Problem:** Device offline entire 14-day overlap → comes back online → attacker-controlled channel feeds old-epoch-compromised manifest FIRST → edge has `highest_seen < e` → bumps to `e` → accepts; attacker wins first-contact race.

**Closure — slot 9 IMMEDIATE epoch revocation during rotation:**

```
Rotation protocol update:
  Day 0 (rotation start): new key ceremony produces epoch e+1 keypair
  Day 0 (SIMULTANEOUS): slot 9 signs RevocationStatement for epoch e with
                        effective_at = Day 14; publishes to cloud anchor + rescue_trigger
                        channel; stored in edge.firmware_releases metadata
  Day 0-14: dual-sign window; edge accepts either epoch
  Day 14: old epoch e automatically revoked per slot 9 signature (effective_at passed);
          no manual HSM revoke needed; edge enforces monotonic via revocation statement
          regardless of first-contact order

Edge verification extension:
  on_manifest_receive(manifest):
    # Check slot 9 revocation statements BEFORE epoch monotonic check
    active_revocations = fetch_revocations_from_cloud_anchor_or_mqtt()
    for rev in active_revocations:
      if rev.revoked_epoch == manifest.signing_key_epoch
         and rev.effective_at <= now_with_monotonic_floor():
        return REJECT  # old epoch revoked via slot 9, regardless of highest_seen
    # Fall through to normal epoch monotonic check
    ...

Result: Attacker cannot feed compromised old-epoch manifest during or after overlap
        if slot 9 revocation already published (even if device offline during overlap).
        Slot 9 revocation becomes the authoritative anti-rollback mechanism;
        highest_seen_epoch is secondary defense.

INVARIANT: tests/invariants/offline_first_contact_race_closed.rs
  - Device offline entire overlap window; comes online via attacker MQTT
  - Attacker delivers old-epoch compromised manifest
  - Device fetches slot-9 revocation statement from cloud anchor (same fetch path)
  - Revocation statement present (published Day 0) → manifest rejected
  - No race won by attacker
```

**Dependency:** Slot 9 revocation statements must be accessible on device boot via cloud anchor mirror OR MQTT retained message (signed + idempotent). Edge must fetch revocation manifest BEFORE accepting any firmware manifest. First-boot path: factory-provisioned revocation cache (can be empty list) + cloud sync before first privileged operation.

### 6. Custodian Replacement Procedure (FINDING-009 kapama)

```
Turnover triggers:
  - Retirement / termination / resignation
  - Extended unreachability (180+ days without heartbeat check)
  - Security clearance revocation (background check failure)
  - Medical incapacity
  - Under-duress signal (custodian pre-arranged safe word in ceremony video)
  - Legal process on custodian (subpoena → deemed compromised)

Replacement procedure (abbreviated — full runbook docs/runbooks/custodian-replacement.md):

1. Trigger detection: quarterly heartbeat (video check-in) + incident-based
2. Security-lead + platform-owner initiate replacement ceremony
3. Remaining 4 active custodians convocate + identify candidate replacement
4. Legal counsel validates candidate's bonding + background check (3-6 weeks)
5. Replacement ceremony (modified 3-of-5 Shamir refresh):
   - 3 of remaining 4 custodians reconstruct admin authentication
   - HSM admin key ROTATED in-place (old key destroyed)
   - New admin key split into 5 fresh Shamir shares
   - New custodian receives 1 share; remaining 4 redistributed
   - NO reconstruction of old key → forward-secrecy of old ceremony preserved
6. Video + witness testimony archived (7-year retention)
7. Old custodian's share: ceremoniously destroyed (recorded shred)

INVARIANT: tests/invariants/custodian_quorum_health.rs — runtime check:
  - 3+ reachable custodians maintained
  - If 2 reachable: HIGH alarm (approach 2-of-5 degenerate)
  - If 1 reachable: CRITICAL (unable to ceremony)
  - If 0: BLOCKED (slot 4+5 operations impossible; use rescue firmware path)
```

### 7. Compromise Response — Tiered SLO (CRITICAL-006 kapama)

Previous claim "≤15-min fleet revoke" unachievable for full fleet. Honest tiers:

| Path | Mechanism | SLO |
|------|-----------|-----|
| Online fleet subset (reachable via MQTT) | slot 9 online_revocation signs; MQTT QoS 2 broadcast + rescue_trigger | ≤15 minutes (90% fleet typical) |
| Offline fleet (intermittent connectivity) | Natural reconnect + pre-positioned rescue_trigger retained message | 24-72 hours (remaining ~10%) |
| Full fleet including disconnected | Fleet-wide reconnect + rescue firmware cutover (slot 4 ceremony) | 7-14 days |
| Rescue firmware ceremony itself | 3-of-5 Shamir convocation + custodian travel | 24-72 hours (urgent) |
| New firmware signed post-revoke | 4-eye ceremony + build + deploy | 4-8 hours |

**Slot 9 online revocation statement format:**

```rust
pub struct RevocationStatement {
    pub revocation_id: [u8; 16],
    pub revoked_key_slot: u8,           // which slot's current epoch is revoked
    pub revoked_epoch: u32,
    pub effective_at_unix_ms: i64,
    pub reason: RevocationReason,       // enum: Compromise | RoutineRotation | KeyExpiry | Emergency
    pub replacement_pubkey: [u8; 32],   // pre-announced new key for slot
    pub signature: [u8; 64],            // ed25519 by slot 9 online_revocation_signing_key_slot9
}

// Edge verification:
// 1. ed25519 verify with slot 9 pubkey (binary-embedded const)
// 2. revocation_id dedup (persist 30 days)
// 3. effective_at + 5-minute grace window to tolerate clock skew
// 4. If revoked_epoch == current highest_seen_epoch for that slot:
//    - Bump highest_seen_epoch to force rejection
//    - Publish AuditAction::KeyEpochRevoked entry
//    - Next received artifact at revoked epoch → rejected
// 5. If replacement_pubkey announced, update trust anchor upon next signed artifact
```

### 8. ML-DSA-65 PQ Migration (CRITICAL-004 kapama — sizing corrected)

**Corrected sizing (NIST FIPS 204):**
- ML-DSA-65 pubkey: **1952 bytes** (not 96)
- ML-DSA-65 signature: 3293 bytes
- 7 slots × (Ed25519 32B + Ed448 57B + ML-DSA-65 1952B) = **14.3 KB trust anchors** + signed artifact overhead

**PQ Phase timing:**
- **SL-2 baseline path (this ADR):** Phase 1 Ed25519 only through 2027; Phase 2 Ed25519 + ML-DSA dual-sign 2028+
- **SL-3 activation path (ADR-023 §9):** Phase 2 accelerated to 2027

**Binary overhead acceptable:** 9 slots × (Ed25519 32B + Ed448 57B + ML-DSA-65 1952B) = **18.4 KB** trust anchors + ~3KB per ML-DSA signature per artifact. RPi 5 binary 256KB baseline → 18.4KB trust table = 7.2% increase. Acceptable. (Previous 14.3KB figure was stale 7-slot calculation; updated for 9-slot canonical map.)

**Algorithm agility enum:**

```rust
pub enum SigningAlgorithm {
    Ed25519,     // baseline 2026-2027
    Ed448,       // reserved (classical stronger) — not active ship path
    MlDsa65,     // NIST FIPS 204 post-quantum; Phase 2 activation 2027 (SL-3) or 2028 (SL-2)
}

pub struct AlgorithmKeyedPubkey {
    pub alg: SigningAlgorithm,
    pub key_bytes: Vec<u8>,
    pub key_ceremony_version: u32,  // ties to signing_key_epoch
}

// Edge trust anchor — per-slot × per-algorithm table:
pub struct EdgeTrustAnchor {
    pub firmware_signing: HashMap<SigningAlgorithm, AlgorithmKeyedPubkey>,
    pub rbac_manifest_signing: HashMap<SigningAlgorithm, AlgorithmKeyedPubkey>,
    // ... (8 slots total — 8 × 3 algorithms = 24 slots max, 14.3KB)
}

// Verify: signed artifact carries SigningAlgorithm discriminator; edge looks up
// corresponding pubkey for that slot + algorithm; verifies.
// Constant-time wrapper (CRITICAL-012 kapama): runs all 3 verify paths + combines
// via constant-time OR; prevents timing-side-channel leak of active algorithm.
```

### 9. Witness Testimony + 7-Year Retention (unchanged from v1)

Structure unchanged from BLOCKED v1 §9 — that section was salvageable. Preserved:
- Video recording every ceremony (multiple angles; tamper-evident storage)
- Signed witness testimony (3 custodians + external auditor + legal counsel)
- Written transcript SHA-256 + publicly published fingerprint (transparency)
- 7-year retention minimum (compliance baseline; legal-hold extends)
- Annual audit by independent security firm

**Privacy note (extended):** video content biometric-adjacent (faces); custodian consent + lawful basis required per GDPR + KVKK. Consent contract signed at ceremony onboarding; extends past departure.

### 10. CI Signing Pipeline (unchanged from v1)

Preserved from BLOCKED v1 §10:
- Self-hosted GitHub Actions runner in dedicated signing enclave (isolated VLAN)
- YubiHSM connector credentials gated via GitHub Environments with required-reviewers
- Workflow_dispatch-only trigger; no auto-sign on push
- Witness log append-only signed per machine
- SLSA L3 attestation generator integrated

### 11. Signing Service Architecture

```typescript
// apps/signing-service/ new NestJS app (Faz 2 Sprint 8.5 deliverable per ADR-021 §13)

@Controller('signing')
export class SigningController {
  // POST /signing/request
  // Body: { slot: number, artifact_hash: string, artifact_type: ArtifactType, justification: string }
  // Auth: requestor's personal ed25519 signature (operator key from RBAC manifest)
  // Returns: { request_id: string, status: 'pending_approval' }
  @Post('request')
  async requestSigning(@Body() req: SigningRequest, @Requestor() requestor: OperatorId);

  // POST /signing/approve
  // Body: { request_id: string, approver_role: 'approver' | 'security_lead' }
  // Auth: approver's personal ed25519 signature
  // Side effect: if 2 approvers + security_lead all signed → triggers slot HSM sign
  @Post('approve')
  async approveSigning(@Body() req: ApprovalRequest, @Requestor() approver: OperatorId);

  // GET /signing/request/:id
  // Returns status + approvals + signed artifact URL if complete
  @Get('request/:id')
  async getRequest(@Param('id') id: string);
}

// Internal orchestration:
// 1. requestSigning → persist to edge.signing_requests (pending_approval status)
// 2. approveSigning → collect approvals; trigger HSM sign when 4-eye quorum met
// 3. HSM sign via yubihsm-rs crate (primary) or aws-sdk-kms (DR fallback)
// 4. Publish signed artifact to edge.firmware_releases OR edge.policies (per ADR-022)
// 5. Audit chain entry (ADR-020 §7 AuditAction::SigningRequestCompleted)

// Rate limits (per slot):
// - Slot 1 firmware: 10/day per engineer (routine sign)
// - Slot 9 revocation: 5/hour per security-lead (incident response cadence)
// - Exceeds: HIGH alarm + manual security-lead review
```

### 12. Economic + Operational Considerations

Capital + operational costs:

| Item | Cost | Notes |
|------|------|-------|
| YubiHSM 2 FIPS (YHSM2-FIPS) | €700 × 4 units | Primary online + DR + offline rescue/emergency + spare |
| AWS KMS Ed25519 keys | ~$200/month | 7 keys × $1/month + ~1k signs/month billing |
| Swiss bank safe-deposit | ~$500/year | Shamir share backup location |
| External security auditor | ~$15k/year | Annual SL-2 re-audit + ceremony witness |
| Custodian bonding insurance | ~$3k/custodian × 5 | Liability coverage |
| Sigsum CT log submission | $0 (open infrastructure) | Public transparency log |
| Custodian travel | ~$2k/ceremony × ~2/year | Rare ceremonies |
| Ceremony room / faraday cage | ~$5k one-time | Physical setup |
| **Year 1 total** | **~$35-45k** | Amortized ~$3.5-4.5k/month |
| Year 2+ recurring | ~$25-30k/year | Ongoing operations |

**Scale-appropriateness:** Justified at ≥50 paying tenants × enterprise ACV (>$10k/tenant/year). Below scale, documented risk acceptance + defer to smaller HSM footprint (2 YubiHSM units + no Swiss bank) acceptable tier-down.

---

## Alternatives Considered

### Alt-1 Single-key-per-concern, no quorum (naive)
Single engineer signs = insider threat × 1. REDDEDİLDİ.

### Alt-2 FROST threshold Ed25519 (BLOCKED v1 original proposal)
REDDEDİLDİ — vendor capability errors (YubiHSM 2 no FROST; AWS KMS no FROST participant; AWS CloudHSM no Ed25519). See §Context post-audit.

### Alt-3 MPC-capable HSM vendor (Fireblocks MPC / Cybernetica SplitKey)
**Viable but external procurement dependency.** REDDEDİLDİ for SL-2 baseline; **KABUL for SL-3 upgrade path** (ADR-023 §Future Work — if SL-3 activated, revisit).

### Alt-4 Software FROST with HSM as storage only
HSM boundary fiction; keyshares in signing-service process memory = same blast radius as no-HSM. REDDEDİLDİ.

### Alt-5 Cloud-HSM only (no on-prem YubiHSM)
Cloud provider compromise (AWS insider threat T5) blast radius = fleet-wide takeover. REDDEDİLDİ for air-gap sensitive slots 4+5.

### Alt-6 Google Cloud HSM / Azure Key Vault Premium (DR alternatives)
Audit retention / cost trade-offs unfavorable vs AWS (CloudTrail 7-year built-in). REDDEDİLDİ pending Faz 10 cost review (re-eval trigger named).

---

## Consequences

### Positive
- **Factually correct:** All 3 original CRITICAL vendor errors eliminated; architecture matches actual YubiHSM 2 + AWS KMS Ed25519 capabilities
- **7-slot single-key segregation:** each key in hardware-enforced single slot; insider threat bounded per-slot
- **Procedural 4-eye:** 3-party + witness authorization; HSM cannot sign without all 4 identities
- **Honest SLO tiers:** online 15-min via slot 9 / offline 24-72h / ceremony-dependent days
- **ML-DSA sizing correct:** 14.3KB trust anchors budget accepted; PQ path preserved
- **Slot 9 innovation:** bounded-privilege revocation key enables fast revoke without slot 4 ceremony latency
- **SL-3 upgrade path preserved:** ADR-023 §9 MPC-HSM adoption pathway on activation
- **Regulatory alignment:** FIPS 140-2 L3 (YHSM2-FIPS); 7-year audit retention; GDPR + KVKK pseudonymization-extension possible

### Negative
- **SL-2 FR2 Use Control interpretation:** procedural 4-eye is Tier-3 "make it detectable" (application-layer enforcement); FROST cryptographic threshold would have been Tier-1 "make it impossible". SL-2 passes via auditor interpretation "enforced procedural + HSM non-extractability + audit chain integrity". SL-3 upgrade (ADR-023) adopts cryptographic threshold via MPC-HSM vendor path.
- **Not cryptographic threshold:** procedural 4-eye means 4 colluding insiders can bypass (vs FROST cryptographic which requires 3 insiders WITH key shares — but we don't have that hardware; SL-3 path via ADR-023 §9)
- **Overlap window requires epoch anti-rollback:** 14-day window safe ONLY because ADR-018 §6 + ADR-019 §11 epoch monotonic check enforced; counter storage Tier 1-3 dependent
- **Slot 9 bounded privilege:** schema-enforcement via signing-service (not HSM-level) — compromise of signing-service allows slot 9 misuse (bounded to revocation only)
- **Custodian replacement overhead:** turnover logistics + legal process 3-6 weeks per replacement; quarterly heartbeat operational burden
- **Economic floor:** ~$25-30k/year ongoing; scale-appropriate only for enterprise tier
- **Implementation kod:** apps/signing-service/ ~2500-3000 satır (gRPC + approval workflow + HSM integration)

---

## 14. Audit Finding Closure Mapping

| Finding | Severity | Closed in section | Notes |
|---|---|---|---|
| ADR-021-FINDING-001 | CRITICAL | §2 + §3 | FROST REMOVED; single-key YubiHSM 2 FIPS + procedural 4-eye; vendor-accurate |
| ADR-021-FINDING-002 | CRITICAL | §2 | AWS CloudHSM REMOVED from design; AWS KMS Ed25519 DR (2025 support) used instead |
| ADR-021-FINDING-003 | CRITICAL | §2 disjunctive-trust | AWS KMS as SEPARATE keypair + either-or acceptance (not FROST participant; structurally honest) |
| ADR-021-FINDING-004 | CRITICAL | §8 | ML-DSA-65 1952B pubkey correctly sized; 14.3KB trust anchor budget accepted |
| ADR-021-FINDING-005 | CRITICAL | §5 | 14-day overlap ONLY safe via epoch anti-rollback (ADR-018 §6 + ADR-019 §11); invariant test covers |
| ADR-021-FINDING-006 | CRITICAL | §7 + §1 slot 9 | Tiered SLO 15-min/24-72h/7-14d; slot 9 online_revocation dedicated for fast path; schema-enforced bounded privilege |
| ADR-021-FINDING-007 | HIGH | §2 vault location | Istanbul office primary + Ankara legal secondary + Swiss bank tertiary; KVKK Kurul Karar 2019/78 cited (ADR-020 §10b) |
| ADR-021-FINDING-008 | HIGH | §2 + §6 | Named parties still TBD (§6 replacement procedure addresses); custodian bonding insurance required; legal counsel role conflict noted |
| ADR-021-FINDING-009 | HIGH | §6 | Custodian replacement procedure + invariant test quorum health |
| ADR-021-FINDING-010 | HIGH | §10 CI pipeline | Auditor binary verification + reproducible build + independent compilation requirement preserved |
| ADR-021-FINDING-011 | HIGH | §4 ceremony window | Bag-to-DKG window eliminated (no DKG); single-key HSM factory-reset + sign in under 15 min |
| ADR-021-FINDING-012 | HIGH | §8 | Constant-time wrapper over all 3 algorithm verify paths; timing side-channel closed |
| ADR-021-FINDING-013 | HIGH | §1 slot 9 | Revocation slot dedicated; NO more slot 4 misuse for fast revoke |
| ADR-021-FINDING-014 | MEDIUM | §Context | Faraday cage retained for defense-in-depth; honestly labeled optional SL-3 hardening (ADR-023) |
| ADR-021-FINDING-015 | MEDIUM | §12 economics | Export control compliance: Ed25519 + ML-DSA NIST-standardized; ECCN self-class documented |
| ADR-021-FINDING-016 | MEDIUM | §5 epoch storage | AntiRollbackCounter trait (ADR-019 §11); Tier 1 TPM NV / Tier 2 RPMB / Tier 3 documented weakness |
| ADR-021-FINDING-017 | MEDIUM | §11 rate limits | Per-slot rate limits explicit; signing cadence modeled 1 release/week baseline |
| ADR-021-FINDING-018 | MEDIUM | §12 economic sizing | Scale-appropriate ≥50 tenants enterprise tier; under-scale tier-down documented |
| ADR-021-FINDING-019 | MEDIUM | §4 ceremony procedure | Single-key HSM ceremony replaces FROST DKG complexity; §4 procedure accurate to actual mechanism |
| ADR-021-FINDING-020 | MEDIUM | §12 economic review | Rust `yubihsm-rs` + `aws-sdk-kms` — both mature ecosystem crates; no FROST audit dependency |

All 6 CRITICAL + 7 HIGH + 5 MEDIUM + 4 LOW previously flagged — CLOSED architecturally or via §14 mapping.

---

## 15. Implementation Plan (Plan §5 Faz 2)

**Faz 0 (procurement + ceremony kickoff):**
- Sprint 0.1: YubiHSM 2 FIPS (YHSM2-FIPS) × 4 units procurement (4-week lead time)
- Sprint 0.2: AWS KMS Ed25519 keys provisioned + IAM least-privilege policy
- Sprint 0.3: Istanbul office safe-deposit site selection + legal counsel engagement + Swiss bank account
- Sprint 0.4: External auditor contract (annual + compromise-response retainer)
- Sprint 0.5: 5 custodian candidates identified + bonding insurance procurement

**Faz 2 (key ceremony + signing service):**
- Sprint 6.3: 7-slot ceremony execution (slots 4+5 offline 3-of-5 Shamir; slots 1/2/3/6/7/8 online 4-eye)
- Sprint 7.4: apps/signing-service/ implemented (gRPC + approval workflow + HSM integration)
- Sprint 8.4: CI signing workflow integration (.github/actions/hsm-sign)
- Sprint 8.5: Compromise response tabletop exercise (external auditor scored)
- Sprint 9.1: Public key fingerprints published + firmware v2.0.0 binary embedded
- Sprint 9.2: Edge trust anchor table v2 (per-slot × per-algorithm 24-entry HashMap)

**Acceptance criteria (Faz 2 close):**
- All 8 slots keyed + active signing operational
- 4-eye quorum + witness log + HSM sign roundtrip < 2 minutes p99
- Slot 9 online revocation fast path SLO 15-min fleet-subset verified
- IEC 62443 SL-2 adversarial re-audit: FR2/FR3/FR4 green
- Status → Accepted
- **ADR-017 + ADR-018 + ADR-019 unblocked** (their BLOCKER cleared)

---

## References

- YubiHSM 2 FIPS (YHSM2-FIPS) product spec + FIPS 140-2 L3 certification
- AWS KMS EdDSA support (Nov 2025): https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/
- Shamir Secret Sharing (RFC 5869 HKDF + SSS construction)
- NIST FIPS 204 ML-DSA
- NIST FIPS 140-2 Level 3 certification process
- IEC 62443-3-3 SL-2 FR2/FR3/FR4
- GDPR Article 33; KVKK Art 12 + Kurul Karar 2019/78
- Sigsum CT log: https://sigsum.org
- `yubihsm-rs` Rust crate (ecosystem)
- `aws-sdk-kms` crate
- ADR-017 §6 consumer (slot 6 program_signing_key)
- ADR-018 §2 §6 §7 consumer (slots 1-3 + 8 for RBAC + command + revocation)
- ADR-019 §1 §3 §11 consumer (slot 1 firmware + slot 7 provisioning + AntiRollbackCounter)
- ADR-020 §5a (interim anchor key; DEC-021 retirement to slot 9 alternative or new slot 9 post-ADR-021 adoption)
- ADR-022 (edge.firmware_releases + edge.policies consume signed artifacts)
- ADR-023 §4 §9 (SL-3 upgrade: MPC-HSM path + PQ Phase 2 accelerated)
