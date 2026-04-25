# Credentials Handling — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**Scope:** the full lifecycle of sensitive material on-edge — generation, sealing, use, rotation, zeroization — together with the 6-layer defense-in-depth matrix from `src/keystore/mod.rs:22-31`.

---

## 1. Secret taxonomy

| Secret | Source | Lifecycle | Where sealed |
|--------|--------|-----------|---------------|
| Keystore master (32 B) | Generated at first provisioning (or re-generated on rotation) | Per-device; survives reboot; rotates on master-rotation event (180 d default, 0 s on compromise) | Tier-1 TPM NV; Tier-2 systemd-creds; Tier-3 Argon2id-wrapped file |
| Derived keys (32 B each) | HKDF-Expand(master, info=KeyPurpose::hkdf_info()) at point-of-use | Ephemeral in-memory; zeroize on drop | `KeyMaterial` struct (`src/keystore/secret.rs:92-127`) |
| SQLCipher DB key (`offline_queue.db`) | HMAC-SHA256(machine_id, /etc/suderra/db.key) | Per-reboot; stable across reboots as long as machine-id and db.key unchanged | In-memory via `PRAGMA key = "x'...'"` (`src/offline_queue.rs:121`) |
| `/etc/suderra/db.key` | 32 B kernel CSPRNG at first agent start | Persistent on disk; mode 0400 | Filesystem perms only (TODAY); TPM-sealed (ROADMAP Sprint 6.3) |
| MQTT username + password | Delivered by cloud provisioning API (`ActivationResponse` / `SelfRegisterResponse`) | Rotates on each re-activation | `secrecy::Secret<String>` in config (`Cargo.toml:47`, `src/provisioning.rs:230-246`) |
| Provisioning / tenant token | Operator-issued, single-use | 24 h typical | `secrecy::Secret<String>`; masked in logs (`src/provisioning.rs:33-46`) |
| mTLS private keys (TLS to broker / cloud) | Generated on-device (ROADMAP Sprint 6.4 CSR flow); today file-provisioned | Leaf validity: 60/90/398 days per mTLS mode (`src/mtls/mode.rs:8-22`) | Filesystem 0400 permissions (`src/security.rs:72-98`); TPM-sealed ROADMAP |
| LoRaWAN session keys (AppSKey, NwkSKey) | LoRaWAN join-accept | Per-join-session | In-memory only; zeroize on drop via `zeroize = "1"` with `derive` feature (`Cargo.toml:296`) |
| License JWT | Cloud-issued, signed by slot 6 | Tier-specific (e.g. annual) | `secrecy`-wrapped at rest; feature-gated `license-enforce` (`Cargo.toml:392`) |

---

## 2. Six-layer defense-in-depth matrix (from `src/keystore/mod.rs:22-31`)

The matrix captures how master key material is protected. Each layer is independent; compromise of one layer does not trivially cascade. Layers 1–3 are backend choices (exactly one is active per deployment); Layers A–F are hardening levels that stack.

| Layer | Mechanism | What it protects against | Where wired | TODAY status |
|-------|-----------|-------------------------|-------------|--------------|
| 1 | TPM NV seal (`KeyBackend::Tpm`) | Physical SD-card extraction; attacker who obtains the storage medium | `src/keystore/mod.rs:62-64`; runtime ROADMAP-Sprint 6.3 via `tss-esapi` (`Cargo.toml:284`) | Feature `tpm` default-OFF; runtime not wired — ORPHAN-EDGE-004 |
| 2 | systemd-creds (`KeyBackend::SystemdCreds`) | Same-host DAC boundary — non-suderra process on the device | `src/keystore/mod.rs:66-71`; runtime ROADMAP-Sprint 6.3 | Runtime not wired — ORPHAN-EDGE-004 |
| 3 | Argon2id file-backed (`KeyBackend::FileBacked`) | Brute-force of passphrase-derived key on extracted media | `src/keystore/mod.rs:73-76`; `src/keystore/acceptance.rs` + `Cargo.toml:171` (`argon2 = "0.5"`). Params: `m = 256 MiB`, `t = 3`, `p = 4`; 128-bit passphrase entropy floor | Types only; signed acceptance path active (`src/keystore/acceptance.rs:189-238`); runtime not wired — ORPHAN-EDGE-004 |
| A | systemd `LimitCORE=0` | Coredump file containing key bytes | systemd unit file under `sens-api-gateway/systemd/` | Live today |
| B | `prctl(PR_SET_DUMPABLE, 0)` | In-process coredump attempt; ptrace attach | `src/keystore/hardening.rs` (ROADMAP-Sprint 6.3 via `libc` `Cargo.toml:206`) | Not wired today — ORPHAN-EDGE-004 |
| C | `mlock` on master-key bytes | Swap-to-disk leak | `src/keystore/hardening.rs` ROADMAP | Not wired today — ORPHAN-EDGE-004 |
| D | Panic-hook zeroize + `process::abort()` | Stack bytes surviving unwind | ROADMAP-Sprint 6.3 + release profile `panic = "abort"` (`Cargo.toml:425`) already eliminates the unwind path | `panic = "abort"` live; custom panic hook NOT wired |
| E | `ZeroizeOnDrop` on `KeyMaterial` / `MasterKeyBytes` | Drop-time memory scrub | `src/keystore/secret.rs:42-43,97-98` — `#[derive(Zeroize, ZeroizeOnDrop)]` | Live today |
| F | `secrecy::Secret<T>` wrapper | Accidental `Debug` / `Display` leak | `src/keystore/secret.rs:38-40,92-95` — `Secret<MasterKeyBytes>`; custom `Debug` prints `<REDACTED 32 bytes>` only (`src/keystore/secret.rs:54-61,100-107`) | Live today |

Layer summary per the agent spec's "Defense-in-depth 6 layers TYPE-ONLY" label (`src/main.rs:60-99`): **Layers A, E, F are live today. Layers B, C, D (runtime parts) are ROADMAP — ORPHAN-EDGE-004**. Backend layers 1, 2, 3 are type-only today; one will be selected by `KeyBackend::select()` once Sprint 6.3 lands.

---

## 3. Lifecycle phases

### 3.1 Generation

- **Master key** — 32 B from kernel CSPRNG via `getrandom` (`Cargo.toml:113`). Generated at first provisioning; never stored unsealed. `MasterKeyMaterial::from_bytes` is the single entry point (`src/keystore/secret.rs:68`), crate-private.
- **Derived keys** — produced on demand via `Keystore::derive_key(purpose, context)` (`src/keystore/mod.rs:98-102`). HKDF-Expand with master as IKM, `purpose.hkdf_info()` as info, context varies by purpose.
- **DB secret (`/etc/suderra/db.key`)** — 32 B from `rand::rng().fill_bytes` sourced through CSPRNG (`src/offline_queue.rs:104`). Atomic create with 0400 perms (`src/offline_queue.rs:94`) — no read-then-write TOCTOU race.

### 3.2 Sealing

- **Tier 1 (TPM):** master sealed to PCR[0..7] via TPM NV. Unseal fails if firmware / kernel / initrd measurement changes.
- **Tier 2 (systemd-creds):** master encrypted by systemd under the host's TPM-sealed credential key; decrypted when the unit starts.
- **Tier 3 (File-backed Argon2id):** master encrypted by `Argon2id(passphrase, salt)` wrapping key. Passphrase entropy ≥ 128 bits. Salt = `HKDF(device_id, provisioning_nonce, "keystore-salt-v2")`. Requires signed `FileBackedAcceptance` (`src/keystore/acceptance.rs:73-77`) — unsigned file backend is unreachable by construction (Tier-1 make-it-impossible).

### 3.3 Use

Every consumer requests a derived key with a declared purpose:

```rust
let key = keystore.derive_key(KeyPurpose::AuditHmacChain, b"").await?;
assert_eq!(key.purpose(), KeyPurpose::AuditHmacChain); // typestate guard
hmac_sha256(key.expose_secret(), &message);
```

`expose_secret()` is greppable — every call site is reviewable (`src/keystore/secret.rs:124-126`). `KeyMaterial` carries its purpose as a field (`src/keystore/secret.rs:93`) so mismatched use is detectable at construction.

### 3.4 Rotation

- **Master:** `Keystore::rotate_master()` (`src/keystore/mod.rs:117-118`). 180-day default cadence (ADR-018 §6). Compromise response shortens to 0 s with mandatory offline sync. After rotation: new derivations use new master; old derivations honor a grace window; SQLCipher DBs are re-keyed via `PRAGMA rekey`.
- **Derived keys:** rotate implicitly when master rotates. Purpose-scoped rotation (single purpose rotated without master) is NOT supported — would multiply TPM NV index pressure (`src/keystore/purpose.rs:21-27`).
- **DB secret (`/etc/suderra/db.key`):** rotates on agent reprovisioning or on operator-initiated rotation. Under normal rotation, the old file is written once to the audit log (encrypted-envelope) before being overwritten — preserves offline-queue DB re-key trail.
- **mTLS leaf cert:** rotation cadence depends on mTLS mode (60 d Legacy, 90 d Warn, 398 d Strict). Two-phase rotation state machine in `src/mtls/pinning.rs` (type-only today, runtime Sprint 6.8).

### 3.5 Zeroization

- **On drop:** `ZeroizeOnDrop` on `MasterKeyBytes` + `DerivedKeyBytes` + `RawSecret32` (`src/keystore/secret.rs:42,97,137`). Compile-time unit test `inner_byte_types_implement_zeroize_on_drop` (`src/keystore/secret.rs:175`) is a regression guard.
- **On panic (ROADMAP):** Sprint 6.3 custom panic hook zeroizes key bytes before `process::abort()`. Today `panic = "abort"` (`Cargo.toml:425`) eliminates unwind paths but does not proactively zeroize — defense-in-depth gap tracked under ORPHAN-EDGE-004.
- **On process exit:** kernel zeroes the page anyway; `mlock` ensures it wasn't swapped.

### 3.6 Redaction

- `MasterKeyMaterial::Debug` → `MasterKeyMaterial { bytes: "<REDACTED 32 bytes>" }` (`src/keystore/secret.rs:54-61`).
- `KeyMaterial::Debug` → shows purpose but redacts bytes (`src/keystore/secret.rs:100-107`).
- `ActivationResponse::Debug` / `SelfRegisterResponse::Debug` redact `mqtt_password` to `[REDACTED]` (`src/provisioning.rs:127-139,192-205`).
- `mask_secret` (`src/security.rs:32-43`) and `mask_token` (`src/provisioning.rs:33-46`) redact logs with UTF-8-safe char handling.
- `sanitize_for_log` (`src/security.rs:49-57`) strips control chars + caps length at 1000 chars to block log-injection + log-flooding.

---

## 4. Grep-auditable call sites

A short grep inventory any reviewer can run:

```bash
# Every master-key exposure point — must be inside src/keystore/
grep -rn 'expose_secret_crate' sens-api-gateway/src/
# Every derived-key use site
grep -rn '\.expose_secret()' sens-api-gateway/src/
# Every Zeroize derive
grep -rn 'Zeroize\|ZeroizeOnDrop' sens-api-gateway/src/
# Every Secret<T> construction
grep -rn 'Secret::new\|secrecy::Secret' sens-api-gateway/src/
```

Expected invariants (from `src/keystore/secret.rs` docs):

- `expose_secret_crate` appears ONLY in `src/keystore/*.rs`. Any other hit is a review defect.
- `Secret::new` constructions are auditable and finite.

---

## 5. Operator-acceptance ceremony for Tier-3 file-backed

`src/keystore/acceptance.rs:189-238` implements `try_from_parts`. Gates in order:

1. Identity non-empty (`EmptyIdentity`).
2. Token operator_id + device_id match expected (`IdentityMismatch`).
3. `expires_at_unix_secs` > `now_unix_secs` (`Expired`).
4. Signature length exactly 64 (`InvalidSignatureLength`).
5. Ed25519 verify via closure (`InvalidSignature`).

Only after all gates pass is `FileBackedAcceptance` constructible. The struct has all-private fields (`src/keystore/acceptance.rs:73-77`) — consumers CANNOT fabricate one without a signed token. Canonical-bytes format is length-prefix framed with domain tag `b"file-backed-acceptance-v2"` (`src/keystore/acceptance.rs:157-173`) to prevent NUL-straddle collisions across fields.

---

## 6. Logging + telemetry hygiene

- `console.*` forbidden (ESLint in the monorepo; Rust side uses `tracing` exclusively per `Cargo.toml:441-442` `print_stdout = "deny"`, `print_stderr = "deny"`).
- Structured JSON logs via `tracing-subscriber` + `tracing-journald` (`Cargo.toml:40, 234`).
- PII masking: MAC addresses hashed with SHA-256 before any log or telemetry serialization (`src/provisioning.rs:468-472`); operator UUIDs redacted to `op:<operator>` in audit events (`src/authz/ActorIdentity::audit_label()`, referenced by `src/audit/entry.rs:101-103`).

---

## 7. Today-vs-roadmap summary for credentials

| Control | Today (v1.6.0) | ROADMAP milestone | Orphan ID |
|---------|----------------|-------------------|-----------|
| Layer 1 TPM sealing | Feature-gated off | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer 2 systemd-creds | Types only | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer 3 Argon2id file-backed | Types + acceptance ctor active | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer A LimitCORE=0 | Live | — | None |
| Layer B PR_SET_DUMPABLE | Not wired | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer C mlock | Not wired | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer D panic-hook zeroize | `panic=abort` live; hook not wired | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |
| Layer E ZeroizeOnDrop | Live | — | None |
| Layer F Secret<T> | Live | — | None |
| MQTT user/pass → X.509 | user/pass today (`src/mqtt.rs:237`) | Faz 2 Sprint 6.4 | ORPHAN-EDGE-003 |
| Master rotation | Runtime not wired | Faz 2 Sprint 6.3 | ORPHAN-EDGE-004 |

---

## 8. Cross-references

- `crypto-inventory.md` — primitives underpinning key derivation and sealing.
- `audit-log.md` — HMAC chain key is one of the derived keys tracked here.
- `pki-hierarchy.md` — mTLS key lifecycle.
- `docs/adr/018-*.md` (ADR-018 master-key hierarchy).
