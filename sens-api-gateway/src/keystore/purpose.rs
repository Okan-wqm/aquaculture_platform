//! # KeyPurpose — typestate domain separation for derived keys
//!
//! **WHY:** Every derived key must be bound to a single purpose. A key used for
//! audit HMAC MUST NOT accidentally be passed to SQLCipher rekey. The type
//! system enforces this by threading [`KeyPurpose`] through the HKDF `info`
//! parameter (domain separation) AND by tagging the returned `KeyMaterial`
//! with its purpose at the type level (typestate pattern, Batch 5).
//!
//! **Architectural root cause addressed:**
//! - Tier-1 `make-it-impossible` — two separate HKDF outputs for the same
//!   master are IMPOSSIBLE to derive with the same `info` bytes, so key reuse
//!   across purposes is cryptographically impossible.
//! - Tier-3 `make-it-detectable` — [`DerivedKeyId`] lets the audit trail record
//!   which key was used without logging the material itself.

use serde::{Deserialize, Serialize};

/// Declared purpose for a derived key. Each variant is a distinct HKDF `info`
/// string; adding a variant is an ADR-level decision because the derivation
/// domain is part of the compatibility contract (changing an existing variant's
/// HKDF info would invalidate every previously-derived key on-fleet).
///
/// **Invariant (audit-verifiable):** for a given master + purpose + context,
/// the derived key bytes are deterministic. Rotating the master changes every
/// derived key; rotating a single purpose (without master rotation) is not
/// supported — purpose-scoped rotation would require a per-purpose master,
/// which would multiply the TPM NV index pressure (already scarce on RPi).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyPurpose {
    /// SQLCipher master key for the `offline_queue` database.
    /// Context bytes: deployment-instance UUID (not machine-id; see plan HC-5
    /// v1→v2 migration closes the machine-id coupling leak).
    SqlCipherOfflineQueue,

    /// SQLCipher master key for the ST VM RETAIN persistence database.
    /// Context bytes: program artifact SHA-256 (so a re-deployed program
    /// with new bytecode loses retain access — intentional, ADR-017 §7).
    SqlCipherRetainPersistence,

    /// SQLCipher master key for the license-tier cache database
    /// (ADR-031, Batch #341).
    /// Context bytes: deployment-instance UUID. The license cache is bound
    /// to the device, NOT to any program artifact — same context shape as
    /// `SqlCipherOfflineQueue`. Adding this variant unblocks the PR-195
    /// per-consumer migration arc for `src/license_cache.rs`.
    SqlCipherLicenseCache,

    /// SQLCipher master key for the ST VM bytecode-retain persistence
    /// database (ADR-031, Batch #341). Distinct from
    /// `SqlCipherRetainPersistence` (which covers `scripting/persistence.rs`
    /// — the runtime VM state). This variant covers
    /// `scripting/bytecode_retain.rs` — the bytecode artifact retention
    /// store.
    /// Context bytes: program artifact SHA-256 (program-bound lifecycle
    /// matches `SqlCipherRetainPersistence` per ADR-017 §7).
    SqlCipherBytecodeRetain,

    /// SQLCipher master key for the SCADA-display store (`scada_db.rs`
    /// — trends, `alarm_history`, `calibration_log`, `audit_log`),
    /// EDGE-CRITICAL-002. Context bytes: deployment-instance UUID
    /// (device-bound, same shape as `SqlCipherOfflineQueue` — the
    /// SCADA store is bound to the device, not to any program
    /// artifact). Replaces the prior machine-id-only `derive_db_key`
    /// (readable off a stolen SD card) + its universal
    /// `"default-machine-id"` fallback with the keystore/TPM-aware
    /// consumer-key resolver.
    SqlCipherScadaDisplay,

    /// HMAC-SHA256 chain key for the append-only audit log (ADR-020 §2).
    /// Context bytes: `b"audit-hmac-chain-v1"` (constant; rotation happens at
    /// master level). Rotation closes the old chain and opens a new one with
    /// an explicit chain-boundary entry so `audit-verify` CLI can follow both.
    AuditHmacChain,

    /// Replay-cache persistence key (JTI dedup database under `moka` + SQLCipher).
    /// Context bytes: `b"replay-cache-v1"`.
    ReplayCache,

    /// DEK escrow wrapping key — wraps the master for cloud-side operator-key
    /// recovery (ADR-018 §6 DEK escrow). The wrapped payload is stored in
    /// operator-controlled cloud backup, never on-device.
    DekEscrow,

    /// Config file signature verify context (ADR-020 config integrity D-13).
    /// Context bytes: factory-provisioned device UUID. NOT used to sign —
    /// only to verify; signing key is factory-only.
    ConfigVerify,
}

impl KeyPurpose {
    /// HKDF `info` parameter bytes — the domain-separation label.
    ///
    /// **Stability contract:** these byte strings are part of the cross-version
    /// compatibility surface. Changing any value invalidates every deployed
    /// derived key for that purpose; such a change requires an ADR + a
    /// fleet-wide migration window (HC-5 master-key rotation precedent).
    pub const fn hkdf_info(self) -> &'static [u8] {
        match self {
            Self::SqlCipherOfflineQueue => b"suderra:sqlcipher:offline-queue:v2",
            Self::SqlCipherRetainPersistence => b"suderra:sqlcipher:retain-persistence:v1",
            Self::SqlCipherLicenseCache => b"suderra:sqlcipher:license-cache:v2",
            Self::SqlCipherBytecodeRetain => b"suderra:sqlcipher:bytecode-retain:v1",
            Self::SqlCipherScadaDisplay => b"suderra:sqlcipher:scada-display:v1",
            Self::AuditHmacChain => b"suderra:audit:hmac-chain:v1",
            Self::ReplayCache => b"suderra:replay-cache:v1",
            Self::DekEscrow => b"suderra:dek-escrow:v1",
            Self::ConfigVerify => b"suderra:config-verify:v1",
        }
    }

    /// True iff this `KeyPurpose` is a SQLCipher key
    /// derivation target — i.e., usable as input to
    /// SQLCipher `PRAGMA key`/`PRAGMA rekey`. Today this
    /// is `SqlCipherOfflineQueue` + `SqlCipherRetainPersistence`;
    /// adding a future SqlCipher* variant requires extending
    /// this match arm AND an ADR-driven rollout per the
    /// `hkdf_info` stability contract above.
    ///
    /// ## Why a method on `KeyPurpose` (not a free function
    /// in `db_migration::v2_keystore_key`)
    ///
    /// Pre-Batch-#337 the predicate lived as a private
    /// `is_sqlcipher_purpose` function in
    /// `db_migration::v2_keystore_key`. The
    /// audit-flagged LOW-006 finding (edge-industrial-auditor)
    /// observed that this fragmentation undermined the
    /// SSoT claim — a future module needing the same
    /// predicate (e.g., a key-rotation orchestrator that
    /// filters SqlCipher purposes) would reimplement the
    /// match arm, and the SSoT would quietly stop being
    /// true. Promoting the predicate to a method on the
    /// enum places the match arm next to the variant
    /// definitions — the natural SSoT location.
    ///
    /// `const` so it's usable in const contexts (e.g.,
    /// future static lookup tables).
    pub const fn is_sqlcipher_variant(self) -> bool {
        matches!(
            self,
            Self::SqlCipherOfflineQueue
                | Self::SqlCipherRetainPersistence
                | Self::SqlCipherLicenseCache
                | Self::SqlCipherBytecodeRetain
                | Self::SqlCipherScadaDisplay
        )
    }
}

/// Opaque identifier for a derived key — a 16-byte digest of
/// `SHA-256(purpose.hkdf_info() || context || 0x01)`. Suitable for audit
/// correlation ("the write used key X") without exposing the derivation
/// inputs. NOT reversible by observation.
///
/// **Why 16 bytes:** SHA-256 output is 32 bytes; we truncate to 16 because
/// (a) uniqueness across the plausible purpose+context space is ~2^63 before
/// collision under the birthday bound, (b) 16 bytes fits in a UUIDv4 shape
/// for log/metric readability, (c) full 32 bytes would pressure the audit
/// log size budget unnecessarily.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DerivedKeyId(pub [u8; 16]);

impl DerivedKeyId {
    /// Hex-encoded lowercase representation suitable for Prometheus labels
    /// (NOTE: per-key label is a cardinality risk — use only for dashboards
    /// showing "last N keys used", not per-request histograms).
    pub fn as_hex(&self) -> String {
        let mut out = String::with_capacity(32);
        for byte in self.0 {
            out.push(hex_nibble(byte >> 4));
            out.push(hex_nibble(byte & 0x0f));
        }
        out
    }
}

#[inline]
const fn hex_nibble(n: u8) -> char {
    match n {
        0..=9 => (b'0' + n) as char,
        10..=15 => (b'a' + n - 10) as char,
        _ => '?',
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHY: Info byte strings are a stability contract. Golden-pin prevents
    ///      an accidental edit from silently invalidating every deployed key.
    #[test]
    fn hkdf_info_strings_golden_pinned() {
        assert_eq!(
            KeyPurpose::SqlCipherOfflineQueue.hkdf_info(),
            b"suderra:sqlcipher:offline-queue:v2"
        );
        assert_eq!(
            KeyPurpose::SqlCipherRetainPersistence.hkdf_info(),
            b"suderra:sqlcipher:retain-persistence:v1"
        );
        // Batch #341 — ADR-031 additions.
        assert_eq!(
            KeyPurpose::SqlCipherLicenseCache.hkdf_info(),
            b"suderra:sqlcipher:license-cache:v2"
        );
        assert_eq!(
            KeyPurpose::SqlCipherBytecodeRetain.hkdf_info(),
            b"suderra:sqlcipher:bytecode-retain:v1"
        );
        // EDGE-CRITICAL-002 — SCADA-display store.
        assert_eq!(
            KeyPurpose::SqlCipherScadaDisplay.hkdf_info(),
            b"suderra:sqlcipher:scada-display:v1"
        );
        assert_eq!(
            KeyPurpose::AuditHmacChain.hkdf_info(),
            b"suderra:audit:hmac-chain:v1"
        );
        assert_eq!(
            KeyPurpose::ReplayCache.hkdf_info(),
            b"suderra:replay-cache:v1"
        );
        assert_eq!(KeyPurpose::DekEscrow.hkdf_info(), b"suderra:dek-escrow:v1");
        assert_eq!(
            KeyPurpose::ConfigVerify.hkdf_info(),
            b"suderra:config-verify:v1"
        );
    }

    /// WHY: Every distinct KeyPurpose must map to a distinct info string.
    ///      Collision = domain separation broken.
    #[test]
    fn hkdf_info_strings_pairwise_distinct() {
        let purposes = [
            KeyPurpose::SqlCipherOfflineQueue,
            KeyPurpose::SqlCipherRetainPersistence,
            KeyPurpose::SqlCipherLicenseCache,
            KeyPurpose::SqlCipherBytecodeRetain,
            KeyPurpose::SqlCipherScadaDisplay,
            KeyPurpose::AuditHmacChain,
            KeyPurpose::ReplayCache,
            KeyPurpose::DekEscrow,
            KeyPurpose::ConfigVerify,
        ];
        for (i, a) in purposes.iter().enumerate() {
            for b in &purposes[i + 1..] {
                assert_ne!(
                    a.hkdf_info(),
                    b.hkdf_info(),
                    "info collision: {:?} vs {:?}",
                    a,
                    b
                );
            }
        }
    }

    /// WHY: Serde variant names must use snake_case so audit log / metrics have
    ///      the canonical form regardless of where the enum surfaces.
    #[test]
    fn key_purpose_serde_snake_case() {
        let j = serde_json::to_string(&KeyPurpose::SqlCipherOfflineQueue).expect("ok");
        assert_eq!(j, r#""sql_cipher_offline_queue""#);
        let j = serde_json::to_string(&KeyPurpose::AuditHmacChain).expect("ok");
        assert_eq!(j, r#""audit_hmac_chain""#);
    }

    /// WHY: DerivedKeyId hex encoding lowercase; must be exact byte mapping.
    #[test]
    fn derived_key_id_hex_encoding() {
        let id = DerivedKeyId([
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54,
            0x32, 0x10,
        ]);
        assert_eq!(id.as_hex(), "0123456789abcdeffedcba9876543210");
    }

    /// WHY: transparent serde on DerivedKeyId — wire format is the raw 16-byte
    ///      array, not `{"0": [...]}`.
    #[test]
    fn derived_key_id_serde_transparent() {
        let id = DerivedKeyId([0xaa; 16]);
        let j = serde_json::to_string(&id).expect("ok");
        // serde_json represents [u8; 16] as JSON array of ints.
        assert!(j.starts_with("[170,170,170"), "shape: {}", j);
    }
}
