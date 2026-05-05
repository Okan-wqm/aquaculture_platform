# Cryptography Inventory — `sens-api-gateway` v1.6.0

**Source of truth:** HEAD `3413db47`, tag `v1.6.0`, date `2026-04-24`.
**FIPS 140-3 status:** NOT CERTIFIED — the agent uses FIPS-approved algorithms with compliant parameters. A formal FIPS validation is tracked as ROADMAP-Q4 (no certificate in hand).
**Scope:** every symmetric, asymmetric, MAC, KDF and hash primitive compiled into the release binary. Each algorithm cites a `Cargo.toml:line` (crate pin) AND a `src/*.rs:line` (call site / type declaration).

---

## 1. Canonical algorithm table

| Algorithm | Use case | Key / param size | Parameters | Crate | Version | `Cargo.toml` pin | FIPS 140-3 status |
|-----------|----------|-----------------|------------|-------|---------|------------------|-------------------|
| Ed25519 | Signature (firmware manifest, RBAC manifest, command envelope, ST bytecode, audit daily anchor, file-backed acceptance token) | 256-bit key, 64-byte signature | RFC 8032, deterministic, `verify_strict` only | `ed25519-dalek` | `2.1` | `Cargo.toml:145` | FIPS-approved primitive (FIPS 186-5) |
| HKDF-SHA256 | Master → purpose-scoped derived key hierarchy | 256-bit output | Extract-then-Expand per RFC 5869; salt + info both required; info = `KeyPurpose::hkdf_info()` domain string | `hkdf` | `0.12` | `Cargo.toml:158` | FIPS-approved (SP 800-56C) |
| Argon2id | Tier-3 file-backed keystore passphrase derivation | 256-bit output | `m = 256 MiB`, `t = 3`, `p = 4`; salt = `HKDF(device_id, provisioning_nonce, "keystore-salt-v2")`; passphrase entropy floor = 128 bits | `argon2` | `0.5` | `Cargo.toml:171` | Not in FIPS SP 800-132 short-list (NIST currently evaluates memory-hard KDFs); use is gated by operator-signed acceptance token per ADR-018 §5 |
| HMAC-SHA256 | Audit HMAC chain entry MAC; SQLCipher database-key derivation (machine-id binding) | 256-bit tag | RFC 2104; chain key = HKDF(master, salt="audit-hmac-chain-v2", info=`KeyPurpose::AuditHmacChain.hkdf_info()`) | `hmac` + `sha2` | `0.12` + `0.10` | `Cargo.toml:116`, `Cargo.toml:130` | FIPS-approved (FIPS 198-1) |
| SHA-256 | Certificate DER fingerprint (leaf-cert pinning); audit entry canonical-bytes digest; MAC-address pseudonymization; `DerivedKeyId` identifier digest | 256-bit output | FIPS 180-4 | `sha2` | `0.10` | `Cargo.toml:130` | FIPS-approved (FIPS 180-4) |
| AES-256-CBC (SQLCipher default) | At-rest encryption of offline queue + replay-cache + RETAIN persistence SQLite databases | 256-bit key, 128-bit IV | SQLCipher v4 defaults (PBKDF2 wrapped around PRAGMA key; we bypass PBKDF2 by passing a pre-derived 32-byte hex key via `PRAGMA key = "x'...'"`) | `rusqlite` with `bundled-sqlcipher-vendored-openssl` | `0.34` | `Cargo.toml:94` | AES-256-CBC core primitive FIPS-approved (FIPS 197 + SP 800-38A); SQLCipher bundled OpenSSL build not validated under FIPS |
| ChaCha20-Poly1305 | TLS 1.3 AEAD (preferred on ARM without AES-NI) | 256-bit key | IANA `TLS_CHACHA20_POLY1305_SHA256` = `0x1303`; allowlisted | `rustls` (via `rumqttc` + `reqwest`) | transitive | `Cargo.toml:30,32` (`rumqttc`, `reqwest` with rustls), primitive allowlisted `src/mtls/cipher.rs:23` | FIPS-approved (SP 800-38D companion — ChaCha20-Poly1305 added FIPS 140-3 annex 2024); rustls build may not be FIPS module |
| AES-256-GCM | TLS 1.3 AEAD (preferred on x86_64 with AES-NI) | 256-bit key | IANA `TLS_AES_256_GCM_SHA384` = `0x1302`; allowlisted | `rustls` (transitive) | transitive | `src/mtls/cipher.rs:25` | FIPS-approved (FIPS 197 + SP 800-38D) |
| AES-128-GCM | TLS 1.3 AEAD (constrained-client fallback) | 128-bit key | IANA `TLS_AES_128_GCM_SHA256` = `0x1301`; allowlisted | `rustls` (transitive) | transitive | `src/mtls/cipher.rs:27` | FIPS-approved |
| X25519 | TLS 1.3 key-exchange (ECDHE) | 256-bit | RFC 7748 | `rustls` (transitive) | transitive | `rumqttc` `Cargo.toml:32`; `reqwest` `Cargo.toml:30` (rustls-tls-manual-roots) | FIPS-approved (SP 800-186 Rev-1) |
| AES-128-CMAC (LoRaWAN MIC) | LoRaWAN uplink / join MIC verification | 128-bit key | LoRaWAN 1.0.x/1.1 network session key; verified in constant time via `subtle` | `aes` + `cmac` | `0.8` + `0.7` | `Cargo.toml:287,288` | FIPS-approved (SP 800-38B) |
| Constant-time byte comparison | LoRaWAN MIC + PIN verify | n/a | Resists timing side channels | `subtle` | `2` | `Cargo.toml:291` | Not a cryptographic primitive per se; required by FIPS implementation guidance for MAC verification |
| CSPRNG (`getrandom` → kernel `getrandom(2)`) | Nonces (OPC UA, acceptance salt, UUIDv4), DB secret-key generation | 256-bit entropy | Linux kernel `getrandom(2)` uses ChaCha20-CSPRNG on mainline ≥ 5.4 | `getrandom`, `rand` | `0.2`, `0.9` | `Cargo.toml:113,117` | FIPS-approved DRBG class (kernel-side) |
| EdDSA verification via `ring` backend | JWT license claim verification | Ed25519 | `Validation::new(Algorithm::EdDSA)` pinned; `Validation::default()` FORBIDDEN per CI invariant `tests/invariants/jwt_alg_pinning.rs` | `jsonwebtoken` (feature-gated `license-enforce`) | `9` | `Cargo.toml:252` | FIPS-approved (FIPS 186-5) |
| SHA-256 (TPM PCR binding) | Tier-1 master-key sealing, PCR[0..7] policy | 256-bit | TPM 2.0 via `tss-esapi` bindings; feature-gated `tpm`, default-off | `tss-esapi` | `8` | `Cargo.toml:284` | FIPS-approved if TPM module itself is FIPS 140-3 validated (hardware-vendor responsibility, e.g. Infineon SLB 9670 / OPTIGA SLM) |

---

## 2. Key-derivation hierarchy (ADR-019 §7 / ADR-020 §2)

```
Master (32 B, HKDF-SHA256 PRK)
    │  source: Tier-1 TPM NV seal | Tier-2 systemd-creds | Tier-3 Argon2id(passphrase, salt)
    │  sealed in MasterKeyMaterial — Zeroize + Secret wrapper (src/keystore/secret.rs:38)
    │
    └── HKDF-Expand(info = KeyPurpose::hkdf_info())
        ├── sql_cipher_offline_queue     info "suderra:sqlcipher:offline-queue:v2"      (src/keystore/purpose.rs:71)
        ├── sql_cipher_retain_persist    info "suderra:sqlcipher:retain-persistence:v1" (src/keystore/purpose.rs:72)
        ├── audit_hmac_chain             info "suderra:audit:hmac-chain:v1"             (src/keystore/purpose.rs:73)
        ├── replay_cache                 info "suderra:replay-cache:v1"                 (src/keystore/purpose.rs:74)
        ├── dek_escrow                   info "suderra:dek-escrow:v1"                   (src/keystore/purpose.rs:75)
        └── config_verify                info "suderra:config-verify:v1"                (src/keystore/purpose.rs:76)
```

Domain-separation invariant: no two `KeyPurpose` variants share an `hkdf_info()` string. Enforced by `hkdf_info_strings_pairwise_distinct` unit test (`src/keystore/purpose.rs:146`).

---

## 3. Deprecated / forbidden algorithms

These primitives are NOT present in the binary and MUST NOT be added:

| Algorithm | Reason | Enforcement |
|-----------|--------|-------------|
| MD5 | Collision-broken since 2004 | Not in `Cargo.toml`; no call site |
| SHA-1 | Collision-practical since 2017 (SHAttered) | Not in `Cargo.toml`; `sha2` is the only hash crate |
| 3DES | 64-bit block, Sweet32 birthday attack at 2^32 blocks | Not present; SQLCipher uses AES-256 by default |
| RC4 | Biased keystream (RFC 7465) | Not present |
| TLS 1.0 / TLS 1.1 | Deprecated RFC 8996 | `rustls` refuses sub-TLS 1.3 by construction in current version |
| TLS 1.2 | Rejected under SL-2 adversarial baseline to eliminate downgrade surface | `CipherSuite` allowlist is TLS 1.3 only (`src/mtls/cipher.rs:26-28`); plan §5 Faz 2 item 7 + SL-2 mandate |
| Static IV / nonce reuse | Catastrophic for GCM and ChaCha20-Poly1305 | Nonces are protocol-library managed (rustls) or kernel CSPRNG (`getrandom`) |
| `Validation::default()` (JWT) | Equivalent to HS256 — classic `alg=none` / `alg=HS256` key-confusion CVE class | CI invariant `tests/invariants/jwt_alg_pinning.rs` rejects any caller that omits `Algorithm::EdDSA` pin (`Cargo.toml:246-251`) |
| `openssl` subprocess for X.509 parsing | PATH dependency, fragile string parsing | Replaced by in-process `x509-parser` (`src/security.rs:287` call site; `Cargo.toml:126-127`) |

---

## 4. Random-number sources

- **Kernel CSPRNG** — all security-relevant randomness (UUIDv4, DB-secret bytes, LoRaWAN session nonce scratch, acceptance-token salt) is sourced via `getrandom` → Linux `getrandom(2)` syscall. Never uses `/dev/urandom` via read() (avoids FD-exhaustion DoS and early-boot entropy-starvation edge cases).
- **Non-cryptographic RNG (`rand::rng()`)** — used only for non-security-sensitive choices (retry jitter). Seeded from `getrandom`.

---

## 5. Algorithm count

Total distinct primitives enumerated: **14** (Ed25519, HKDF-SHA256, Argon2id, HMAC-SHA256, SHA-256, AES-256-CBC, ChaCha20-Poly1305, AES-256-GCM, AES-128-GCM, X25519, AES-128-CMAC, constant-time compare, CSPRNG, EdDSA-JWT-verify). TPM-PCR SHA-256 is counted under SHA-256 row as a reuse, not a separate primitive.

---

## 6. Cross-references

- `docs/security/pki-hierarchy.md` — how X.509 certs are issued + rotated using the Ed25519/X25519 pair above.
- `docs/security/credentials-handling.md` — 6-layer defense-in-depth around Master key material.
- `docs/security/audit-log.md` — HMAC chain + Ed25519 daily anchor detail.
- ADR-018 Master key hierarchy, ADR-019 Firmware keys, ADR-020 Audit HMAC path, ADR-021 HSM slot map.
