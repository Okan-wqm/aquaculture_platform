# Audit Log Architecture — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**Scope:** the HMAC-chained append-only audit log described in ADR-020, its tamper-evidence guarantees, and the Ed25519 daily anchor that extends tamper-evidence across the cloud boundary.

---

## 1. Design at a glance

```
┌───────────────────────────────────┐
│ Every regulated action            │
│  → 2 audit entries (Pre + Post)   │
│    AuditEntry (src/audit/entry.rs)│
└───────┬───────────────────────────┘
        │ canonical_bytes() (length-prefix framed + domain tag b"audit-entry-v1")
        ▼
┌──────────────────────────────────────┐
│ HMAC chain — src/audit/chain.rs      │
│                                       │
│ prev_hmac || entry_bytes →            │
│   HMAC-SHA256(chain_key, …)           │
│   = current_hmac                      │
│                                       │
│ chain_key = keystore.derive_key(      │
│   KeyPurpose::AuditHmacChain, b"")    │
└───────┬──────────────────────────────┘
        │ fsync durable write
        ▼
┌──────────────────────────────────────┐
│ SQLCipher sink — ROADMAP Sprint 6.2  │
│ /var/lib/suderra/audit/*.jsonl       │
└───────┬──────────────────────────────┘
        │ daily Ed25519 signature over last entry's current_hmac
        ▼
┌──────────────────────────────────────┐
│ Cloud SIEM — anchor publish          │
│ (ADR-020 §4 daily_anchor topic)      │
└──────────────────────────────────────┘
```

Algorithm + code trace:

- **HMAC primitive:** HMAC-SHA256 via `hmac = "0.12"` + `sha2 = "0.10"` (`Cargo.toml:116, 130`). Closure-injected into `append_entry` (`src/audit/chain.rs:171`), to keep Batch 6 dep-graph free of direct crypto until Sprint 6.2.
- **Chain key:** HKDF-SHA256 domain-separated, info = `b"suderra:audit:hmac-chain:v1"` (`src/keystore/purpose.rs:73`).
- **Ed25519 daily anchor:** signing key = `device_audit_attestation_keypair`, HKDF-derived per-epoch from master per ADR-020 §2 (`src/audit/...`, runtime wired Sprint 6.2).

---

## 2. Entry shape

`AuditEntry` (`src/audit/entry.rs:328-360`) carries:

- `timestamp_unix_secs: i64` — monotonic-safe wall clock (NTS-authenticated per plan D-7).
- `timestamp_nanos: u32` — 0..=999_999_999 enforced in `canonical_bytes`.
- `correlation_id: String` — UUIDv4, REQUIRED, bounded to `MAX_CORRELATION_ID_BYTES = 128`.
- `phase: AuditPhase` — `Pre` (intent, pre-handler) | `Post` (outcome, post-handler).
- `actor: AuditActor` — redacted label (`op:<operator>` or `svc:<cn>`), bounded to `MAX_ACTOR_LABEL_BYTES = 256`.
- `tenant: TenantId` — sealed newtype, 16 bytes.
- `policy_version: u64` — RBAC manifest version active at decision time.
- `two_person_integrity_verified: bool` — set by `AuthorizedContext` when quorum rule satisfied.
- `action: AuditAction` — exhaustive enum with stable `wire_tag` byte discriminators (`src/audit/entry.rs:114-164`).
- `resource: AuditResource` — Tag / Permission / Program / FirmwareImage / PolicyManifestVersion / Keystore / Tenant / Other, each with stable `wire_tag` (`src/audit/entry.rs:226-254`).
- `outcome: AuditOutcome` — Success / Failure / AuthorizationDenied.
- `detail: String` — bounded to `MAX_DETAIL_BYTES = 4096`.

Two-phase invariant: every mutating action emits Pre BEFORE the handler executes. If the handler crashes, the Pre entry survives — the log reflects INTENT even when the outcome is unknown. This closes the "crash covers tracks" class of attack.

---

## 3. Canonical-bytes encoding

`AuditEntry::canonical_bytes` (`src/audit/entry.rs:443-512`) produces deterministic bytes for HMAC input:

```
be_i64(timestamp_unix_secs) ||
be_u32(timestamp_nanos) ||
be_u32(correlation_id.len()) || correlation_id.as_bytes() ||
u8(phase.wire_tag()) ||
be_u32(actor.label.len()) || actor.label.as_bytes() ||
tenant.as_bytes()           (fixed 16 bytes) ||
be_u64(policy_version) ||
u8(two_person_integrity_verified ? 1 : 0) ||
u8(action.wire_tag()) ||
<resource canonical bytes>  (manual wire_tag per AuditResource variant) ||
u8(outcome.wire_tag()) ||
be_u32(detail.len()) || detail.as_bytes() ||
b"audit-entry-v1"
```

Design invariants:

- **Length-prefix framing** prevents field-boundary collision attacks (EDGE-HIGH-001 closure evidence, `src/audit/entry.rs:636-650`).
- **Domain tag `b"audit-entry-v1"`** prevents cross-protocol signature reuse — a signer on rbac-manifest-v1 cannot have their signature replayed here.
- **Stable `wire_tag` bytes** — adding an enum variant appends at the next integer; renaming or reordering is a breaking change. Pinned by unit tests (`src/audit/entry.rs:664-700`).

Tier-1 input-validation guards inside `canonical_bytes` reject negative timestamps, nanos ≥ 1e9, empty correlation_id, empty actor label, oversized detail / correlation_id / actor label (`src/audit/entry.rs:447-473`).

---

## 4. HMAC chain

The chain (`src/audit/chain.rs`) stores two hash pointers per entry:

```rust
pub struct HmacChainEntry {
    sequence: u64,
    prev_hmac: PrevHmac,   // 32 B — previous entry's current_hmac, or all-zero for first
    current_hmac: CurrentHmac, // 32 B
    entry: AuditEntry,
}
```

`append_entry` (`src/audit/chain.rs:171-193`):

1. `sequence = prev_sequence.checked_add(1)` — explicit overflow rejection.
2. `hmac_input = prev_hmac (32 B) || entry.canonical_bytes()` — fixed 32 B prefix, no variable-length boundary ambiguity.
3. `current_hmac = compute_hmac(hmac_input)` — closure-injected `HMAC-SHA256(chain_key, hmac_input)`.

Chain-start convention: first entry uses `PrevHmac::ZERO` and `sequence = 1`. Unit test `first_entry_uses_zero_prev_hmac_and_sequence_one` pins this (`src/audit/chain.rs:241`).

### 4.1 Tamper-evidence property

Regression-tested at `src/audit/chain.rs:383-419` (`tamper_e1_detail_invalidates_e2_prev_hmac_link`):

Any modification to entry E_N's bytes changes its canonical_bytes, which changes the HMAC input to its `current_hmac`, which becomes E_{N+1}'s `prev_hmac`. Since E_{N+1} stores the ORIGINAL prev_hmac, the walk from E_N to E_{N+1} via recomputed HMAC fails — the chain is broken at N+1. Any `audit-verify` CLI walk detects this.

Properties detectable:

- **Tamper of entry content** — any field change cascades HMAC mismatch.
- **Insertion of new entry** — would need the attacker to hold the chain key; `chain_key = HKDF(master, info="suderra:audit:hmac-chain:v1")` — master is TPM-sealed.
- **Deletion of entry** — leaves a gap in `sequence` + broken prev_hmac link on the next entry.

Properties NOT detectable by chain alone:

- **Truncation of recent entries.** The last N entries could be deleted without the HMAC-only walk catching it — the remaining tail is still valid. Mitigation: Ed25519 daily anchor (§5).
- **Wholesale log replacement after compromise of chain key.** Mitigation: daily anchor is signed by `device_audit_attestation_keypair` which is HKDF-derived per-epoch and also TPM-sealed transitively.

---

## 5. Ed25519 daily anchor

Per ADR-020 §4:

- End of each day, the agent signs `last_entry.current_hmac` with `device_audit_attestation_keypair` (Ed25519; primitive from `ed25519-dalek = "2.1"`, `Cargo.toml:145`).
- Signature + timestamp + device_id published to cloud SIEM under the anchor topic.
- Cloud-side the signature is verified against the per-device attestation pubkey (rotated per epoch).

What the anchor adds:

- **Detects truncation.** Cloud has a tamper-evident cursor forward of which no entry can be quietly deleted — because the cursor's HMAC is ceremony-anchored.
- **Bridges the trust boundary.** Edge-side chain ends at cloud-side anchor; a compromised edge cannot forge an anchor without the attestation key.

---

## 6. Runtime sink status today

**NOT WIRED** per agent spec load-bearing label. Details:

- Types + pure function (`append_entry`, `AuditEntry::canonical_bytes`) are live and fully tested (`src/audit/chain.rs`, `src/audit/entry.rs`; `#[allow(dead_code)]` at `src/main.rs:65`).
- SQLCipher-backed sink (`/var/lib/suderra/audit/*.jsonl`) writer with fsync + logrotate + fcntl F_SETLK advisory lock (`nix` fs feature, `Cargo.toml:220`) is ROADMAP-Faz 2 Sprint 6.2.
- Runtime audit events today flow only through `tracing-journald` (`Cargo.toml:234`) — tamper-resistant via systemd FSS (Forward Secure Sealing) but NOT HMAC-chained.
- `audit-verify` CLI that walks the chain from entry 0 is ROADMAP-Sprint 6.2.
- Daily anchor publisher is ROADMAP-Sprint 6.2.

Orphan ID: ORPHAN-EDGE-004 (umbrella for Faz 2 type-only → runtime promotion).

---

## 7. Export path to cloud SIEM

- **Initial transport (v1.6.0):** journald entries shipped via `tracing-journald` → operator's log-forwarding stack (Fluent Bit / Vector / journald → OpenSearch).
- **Post-Sprint 6.2 transport:** HMAC-chained `.jsonl` files rotated daily; cloud-side ingestor verifies the chain + daily anchor and drops malformed segments.
- **Retention:** 7 years edge-local for SQLCipher sink; longer in cloud SIEM per ADR-020 §10a (SOC 2 evidence).
- **Filtering / redaction at source:** actor labels already redacted via `ActorIdentity::audit_label()`; tenant IDs are 16-byte sealed newtypes (not PII in the threat model); `detail` is operator-facing and 4 KiB bounded.

---

## 8. Append-only enforcement

Per ADR-020 §3a:

- **fcntl F_SETLK advisory lock** during logrotate to block concurrent writers.
- **CAP_LINUX_IMMUTABLE capability drop** on the agent process — once dropped, agent cannot flip the `i` attribute on log files. Operator sets `chattr +i` on the historical JSONL shards; this makes any in-process re-write `EPERM` even if attacker somehow becomes the suderra user.
- **Capability drops are irreversible within the process lifetime** — `tests/invariants/cap_drop_persistent.rs` fuzzes regain attempts (referenced in `Cargo.toml:216-219`).

---

## 9. Logging boundary

What goes in the audit log (HMAC-chained):

- Command authorization + execution.
- Tag read + write (ADR-024 actuator-class aware).
- Force-value apply + revoke.
- RBAC manifest receive / apply / reject.
- Firmware + program deploy request / apply / rollback.
- Safe-state trigger / clear / watchdog trip / emergency override.
- Master key rotation / derived-key request / acceptance-token accept.
- Tenant provision / deprovision.
- MQTT reconnect / cert rotation (incl. rollback).
- Boot / shutdown.

What does NOT go in the audit log:

- Operational telemetry (latency, cpu, mem) — that is the `tracing` side.
- Sensor readings — telemetry stream; not an audit event per ADR-020.
- Debug logs for non-regulated code paths.

Boundary enforced at the call-site level — each `AuditAction` variant (`src/audit/entry.rs:116-164`) has a specific handler pair.

---

## 10. Today-vs-roadmap summary

| Component | Today | ROADMAP | Orphan ID |
|-----------|-------|---------|-----------|
| `AuditEntry` data model + canonical_bytes | Live + tested | — | None |
| HMAC chain `append_entry` | Live (closure-injected HMAC) | — | None |
| SQLCipher audit sink (fsync + logrotate + fcntl lock) | NOT WIRED | Faz 2 Sprint 6.2 | ORPHAN-EDGE-004 |
| `audit-verify` CLI | NOT WIRED | Faz 2 Sprint 6.2 | ORPHAN-EDGE-004 |
| Ed25519 daily anchor publisher | NOT WIRED | Faz 2 Sprint 6.2 | ORPHAN-EDGE-004 |
| `CAP_LINUX_IMMUTABLE` drop | NOT WIRED | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Runtime audit via `tracing-journald` | Live | Complement to chain sink, not replacement | None |

---

## 11. Cross-references

- `credentials-handling.md` — chain key derivation (KeyPurpose::AuditHmacChain) + master sealing.
- `threat-model.md` — Trust boundary 6; attack tree "offline-queue tamper".
- `crypto-inventory.md` — HMAC-SHA256 and Ed25519 primitive references.
- ADR-020 audit HMAC chain; ADR-021 slot 5 daily-anchor signing.
