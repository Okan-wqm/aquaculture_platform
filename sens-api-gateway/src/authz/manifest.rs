//! # RbacManifest — cloud-signed RBAC manifest wire format (ADR-018 §6)
//!
//! The RBAC manifest is the **flexible** surface of the two-layer RBAC design
//! (ADR-018 §3 Fixed-Vocabulary-Flexible-Roles):
//!
//! - **Edge vocabulary (fixed):** `Permission` enum variants. Changing a
//!   variant requires a new edge binary release. Batch 2 delivered this.
//! - **Cloud mapping (flexible):** `RbacManifest` declares roles and binds
//!   operators to them. Platform RBAC evolution happens here WITHOUT
//!   requiring an edge binary release.
//!
//! The manifest is signed by the `rbac_manifest_signing_key` (ADR-021 slot 2)
//! under the 4-eye operator quorum + HSM ceremony. It is tenant-bound; a
//! manifest signed for tenant A cannot unlock tenant B's edge (enforced by
//! `verify_manifest` tenant equality check).
//!
//! ## Why not directly serialize `RbacManifest` as the wire format?
//!
//! Wire tampering + forgery defense requires separating the SIGNED body
//! from the SIGNATURE. [`SignedRbacManifest`] carries both. `verify_manifest`
//! in `super::verify` takes a `&SignedRbacManifest` and returns a
//! `RbacManifest` ONLY on successful signature + tenant + expiry + version
//! checks. Consumers never parse raw bytes into `RbacManifest` — they go
//! through the verifier.
//!
//! ## Canonical serialization
//!
//! `RbacManifest::canonical_bytes()` uses length-prefix framing (same
//! discipline as Batch 4b `FileBackedAcceptance::canonical_bytes` per
//! EDGE-LOW-101). NUL separators are forbidden because identifier fields
//! are strings that can contain NUL.
//!
//! ## Cross-references
//!
//! - ADR-018 §3 Fixed-vocabulary / flexible-roles two-layer RBAC
//! - ADR-018 §6 Manifest signature + tenant binding + monotonic version
//! - ADR-018 §11 `AuthorizedContext` / `PolicyEngine` consume this manifest
//! - ADR-021 §9 rbac_manifest_signing_key HSM slot 2 ceremony

use serde::{Deserialize, Serialize};

use super::permission::{OperatorId, Permission, TenantId};
use super::policy::{Ed25519SignatureBytes, InvalidSignatureLength};

/// ed25519 public key bytes (32-byte raw curve point). Newtype so call
/// sites become explicit about what kind of key they hold — an
/// [`Ed25519PublicKeyBytes`] is NOT interchangeable with other 32-byte
/// opaque identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Ed25519PublicKeyBytes([u8; 32]);

/// Validation error for [`Ed25519PublicKeyBytes::from_slice`]. EDGE-LOW-003
/// closure — symmetric with `Ed25519SignatureBytes::from_slice` at the
/// parse-boundary validated-newtype pattern.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidPubKeyLength {
    pub got: usize,
}

impl std::fmt::Display for InvalidPubKeyLength {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ed25519 pubkey length {} != 32", self.got)
    }
}

impl std::error::Error for InvalidPubKeyLength {}

impl Ed25519PublicKeyBytes {
    /// Ctor from known 32-byte array (used inside manifest parse paths and
    /// tests where length is already guaranteed).
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Validated parse-boundary ctor (EDGE-LOW-003 symmetry closure). Use
    /// at any raw-byte source — DER extraction, CBOR wire form, HSM import.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, InvalidPubKeyLength> {
        if bytes.len() != 32 {
            return Err(InvalidPubKeyLength { got: bytes.len() });
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes);
        Ok(Self(out))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Binding of an operator to an edge device — carries the operator's
/// verifying key (for command envelope signature verify) and the set of
/// role names the operator holds under this manifest version.
///
/// **Why role NAMES (not Permission sets directly):** allows the cloud to
/// introduce new roles without edge agent releases. Edge vocabulary
/// (`Permission` enum) stays fixed; cloud role→permission mapping is the
/// variable in this manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperatorBinding {
    pub operator_id: OperatorId,
    pub pubkey: Ed25519PublicKeyBytes,
    pub role_names: Vec<String>,
}

/// Custom role definition. A role is a named bundle of permissions with a
/// validity window. Roles can be:
/// - Platform-standard (`Viewer`, `Operator`, `Admin`, `Emergency`) —
///   instantiated from the cloud's canonical role templates
/// - Tenant-custom (`PondSupervisor_Tilapia_Shift2`) — per-tenant-specific
///
/// Edge treats both identically; the distinction is cloud-side only. The
/// edge only cares about the permissions bound to the role name and whether
/// the caller's operator binding lists that name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomRole {
    pub name: String,
    pub permissions: Vec<Permission>,
    /// Wall-clock UNIX seconds — start of the role's validity window.
    pub valid_from_unix_secs: i64,
    /// Wall-clock UNIX seconds — end of validity. Authorization decisions
    /// emit `RoleExpired` past this timestamp.
    pub valid_until_unix_secs: i64,
    /// Optional break-glass flag — if `true`, the role carries an
    /// emergency escalation permission that requires a co-approved
    /// `EmergencyOverrideRequired` path. Per ADR-018 §8 break-glass.
    #[serde(default)]
    pub is_emergency_role: bool,
}

/// The RBAC manifest body — the SIGNED content. Excludes the signature;
/// the signature covers `canonical_bytes(self)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RbacManifest {
    /// Monotonic policy version. Edge persists the highest-seen version and
    /// rejects any inbound manifest with `policy_version <= highest_seen`
    /// (ADR-018 §9 rollback defense).
    pub policy_version: u64,

    /// Tenant binding — must equal the device's provisioning-bound tenant
    /// (`DeviceId → TenantId` per ADR-019 §4 sealed binding).
    pub tenant_id: TenantId,

    /// Whole-manifest validity window — operators cannot exceed this bound
    /// even if their role's valid_until is later.
    pub manifest_valid_from_unix_secs: i64,
    pub manifest_valid_until_unix_secs: i64,

    /// All operator bindings active under this manifest.
    pub operator_bindings: Vec<OperatorBinding>,

    /// All role definitions active under this manifest.
    pub roles: Vec<CustomRole>,
}

/// Signed manifest — the wire format. Carries the signed body + the
/// ed25519 signature produced by the HSM ceremony over
/// `RbacManifest::canonical_bytes()`.
///
/// **Tier-1 make-it-impossible seal:** the `manifest` field is `pub(crate)`.
/// External consumers cannot read the unverified body directly — they MUST
/// go through [`super::verify::verify_manifest`], which returns an owned
/// `RbacManifest` only after passing all 7 verification gates. This closes
/// the audit-flagged path where a downstream consumer could accidentally
/// read `signed.manifest.operator_bindings` without running the verifier.
///
/// **Serde + crate-local access:** `serde::Deserialize` can still populate
/// the private field via the derive (derives bypass visibility). Tests in
/// this crate can still construct `SignedRbacManifest { manifest, ... }`
/// via struct-literal because tests compile inside the crate. External
/// callers get only `from_body_and_signature_bytes` (which itself is for
/// cloud-side signer tooling; edge consumers receive via JSON).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedRbacManifest {
    pub(crate) manifest: RbacManifest,
    /// ed25519 signature (64 bytes, validated at parse boundary).
    pub signature: Ed25519SignatureBytes,
}

impl RbacManifest {
    /// Canonical bytes fed to ed25519 signing/verify. Length-prefix framing
    /// prevents NUL-straddle collisions across variable-length fields
    /// (same defense as Batch 4b `FileBackedAcceptance::canonical_bytes`
    /// per EDGE-LOW-101).
    ///
    /// **Encoding (v1 — first release):**
    ///
    /// ```text
    /// be_u64(policy_version) ||
    /// tenant_id.as_bytes() (fixed 16 bytes) ||
    /// be_i64(manifest_valid_from_unix_secs) ||
    /// be_i64(manifest_valid_until_unix_secs) ||
    /// be_u32(operator_bindings.len()) ||
    ///   for each binding:
    ///     operator_id.as_bytes() (fixed 16 bytes) ||
    ///     pubkey.as_bytes() (fixed 32 bytes) ||
    ///     be_u32(role_names.len()) ||
    ///       for each role_name:
    ///         be_u32(role_name.len()) || role_name.as_bytes() ||
    /// be_u32(roles.len()) ||
    ///   for each role:
    ///     be_u32(name.len()) || name.as_bytes() ||
    ///     be_i64(valid_from_unix_secs) ||
    ///     be_i64(valid_until_unix_secs) ||
    ///     u8(is_emergency_role ? 1 : 0) ||
    ///     be_u32(permissions.len()) ||
    ///       for each permission: bincode-canonical bytes (Permission enum) ||
    /// b"rbac-manifest-v1"
    /// ```
    ///
    /// **Permission bincode encoding:** bincode 1.3.3 is PINNED in
    /// `Cargo.toml` Batch 1 as the wire-stability carrier for audit + rbac
    /// manifest canonical bytes. The Permission enum derives `Serialize` so
    /// bincode round-trips it deterministically.
    ///
    /// **Domain-separation tag:** `b"rbac-manifest-v1"` at the END prevents
    /// cross-protocol signature reuse (e.g. an attacker cannot submit
    /// these bytes as an acceptance token even if they controlled the
    /// rbac_manifest_signing_key, because the acceptance encoding has a
    /// DIFFERENT tag). Bumping to v2 requires ADR + fleet migration.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, CanonicalBytesError> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(&self.policy_version.to_be_bytes());
        out.extend_from_slice(self.tenant_id.as_bytes());
        out.extend_from_slice(&self.manifest_valid_from_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.manifest_valid_until_unix_secs.to_be_bytes());

        out.extend_from_slice(&u32_len(self.operator_bindings.len())?.to_be_bytes());
        for binding in &self.operator_bindings {
            out.extend_from_slice(binding.operator_id.as_bytes());
            out.extend_from_slice(binding.pubkey.as_bytes());
            out.extend_from_slice(&u32_len(binding.role_names.len())?.to_be_bytes());
            for role_name in &binding.role_names {
                let name_bytes = role_name.as_bytes();
                out.extend_from_slice(&u32_len(name_bytes.len())?.to_be_bytes());
                out.extend_from_slice(name_bytes);
            }
        }

        out.extend_from_slice(&u32_len(self.roles.len())?.to_be_bytes());
        for role in &self.roles {
            let name_bytes = role.name.as_bytes();
            out.extend_from_slice(&u32_len(name_bytes.len())?.to_be_bytes());
            out.extend_from_slice(name_bytes);
            out.extend_from_slice(&role.valid_from_unix_secs.to_be_bytes());
            out.extend_from_slice(&role.valid_until_unix_secs.to_be_bytes());
            out.push(if role.is_emergency_role { 1 } else { 0 });
            out.extend_from_slice(&u32_len(role.permissions.len())?.to_be_bytes());
            for perm in &role.permissions {
                let perm_bytes = bincode::serialize(perm)
                    .map_err(|_| CanonicalBytesError::PermissionEncodeFailed)?;
                out.extend_from_slice(&u32_len(perm_bytes.len())?.to_be_bytes());
                out.extend_from_slice(&perm_bytes);
            }
        }

        out.extend_from_slice(b"rbac-manifest-v1");
        Ok(out)
    }
}

/// Helper: convert a `usize` length to `u32` with overflow rejected.
/// Length-prefix framing uses `u32` for 4GB-bounded fields (operator count,
/// role count, permission count). A manifest exceeding `u32::MAX` entries
/// is not a sane input; reject at canonicalization time rather than silently
/// truncating.
fn u32_len(n: usize) -> Result<u32, CanonicalBytesError> {
    u32::try_from(n).map_err(|_| CanonicalBytesError::LengthExceedsU32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanonicalBytesError {
    /// A length field exceeded `u32::MAX`. Cannot happen under sensible
    /// manifest sizes; surfaces only for hostile/fuzz input.
    LengthExceedsU32,
    /// `bincode::serialize(&Permission)` failed. Unexpected — Permission
    /// derives Serialize; this would indicate a serde-ext failure or OOM.
    PermissionEncodeFailed,
}

impl std::fmt::Display for CanonicalBytesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LengthExceedsU32 => f.write_str("length_exceeds_u32"),
            Self::PermissionEncodeFailed => f.write_str("permission_encode_failed"),
        }
    }
}

impl std::error::Error for CanonicalBytesError {}

/// Convenience: wrap a raw 64-byte signature into `Ed25519SignatureBytes`
/// at manifest parse time. Used only at the wire-parse boundary; internal
/// consumers always hold the validated newtype.
impl SignedRbacManifest {
    /// Construct from manifest body + 64-byte signature slice. Bounces back
    /// `InvalidSignatureLength` on wrong slice length. Use at the MQTT/HTTP
    /// manifest publish entrypoint.
    pub fn from_body_and_signature_bytes(
        manifest: RbacManifest,
        signature_bytes: &[u8],
    ) -> Result<Self, InvalidSignatureLength> {
        Ok(Self {
            manifest,
            signature: Ed25519SignatureBytes::from_slice(signature_bytes)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{OperatorId, Permission, TagId};

    fn canned_manifest() -> RbacManifest {
        RbacManifest {
            policy_version: 42,
            tenant_id: TenantId::new_from_verified([0x42u8; 16]),
            manifest_valid_from_unix_secs: 1_700_000_000,
            manifest_valid_until_unix_secs: 1_800_000_000,
            operator_bindings: vec![OperatorBinding {
                operator_id: OperatorId::new_from_verified([0x07u8; 16]),
                pubkey: Ed25519PublicKeyBytes::from_bytes([0xaau8; 32]),
                role_names: vec!["viewer".to_string(), "operator".to_string()],
            }],
            roles: vec![CustomRole {
                name: "viewer".to_string(),
                permissions: vec![Permission::ReadTag],
                valid_from_unix_secs: 1_700_000_000,
                valid_until_unix_secs: 1_800_000_000,
                is_emergency_role: false,
            }],
        }
    }

    /// WHY: canonical_bytes deterministic across calls (signer + verifier
    ///      must produce identical bytes).
    #[test]
    fn canonical_bytes_deterministic() {
        let m = canned_manifest();
        let a = m.canonical_bytes().expect("ok");
        let b = m.canonical_bytes().expect("ok");
        assert_eq!(a, b);
    }

    /// WHY: canonical_bytes ends with the v1 domain-separation tag.
    #[test]
    fn canonical_bytes_embeds_v1_tag() {
        let m = canned_manifest();
        let bytes = m.canonical_bytes().expect("ok");
        let tag = b"rbac-manifest-v1";
        assert!(bytes.ends_with(tag), "missing v1 tag");
    }

    /// WHY (EDGE-LOW-101 regression guard equivalent): length-prefix
    ///      framing prevents a role name containing the tag string from
    ///      colliding with a differently-structured manifest. If two
    ///      manifests A and B differ only in how a role name/tag substring
    ///      is positioned, their canonical bytes must differ.
    #[test]
    fn canonical_bytes_framing_resists_field_boundary_collision() {
        let m1 = {
            let mut m = canned_manifest();
            // Role name contains an embedded "rbac-manifest-v1" string.
            m.roles[0].name = "rbac-manifest-v1".to_string();
            m
        };
        let m2 = {
            let mut m = canned_manifest();
            m.roles[0].name = "rbac-manifest-v1-other".to_string();
            m
        };
        let a = m1.canonical_bytes().expect("ok");
        let b = m2.canonical_bytes().expect("ok");
        assert_ne!(a, b);
    }

    /// WHY: changing any manifest field changes canonical bytes — basic
    ///      sensitivity smoke test across each top-level field.
    #[test]
    fn canonical_bytes_sensitive_to_every_top_level_field() {
        let base = canned_manifest();
        let base_bytes = base.canonical_bytes().expect("ok");

        let mut tweak_version = base.clone();
        tweak_version.policy_version = 43;
        assert_ne!(
            base_bytes,
            tweak_version.canonical_bytes().expect("ok"),
            "policy_version must change canonical bytes"
        );

        let mut tweak_tenant = base.clone();
        tweak_tenant.tenant_id = TenantId::new_from_verified([0x43u8; 16]);
        assert_ne!(
            base_bytes,
            tweak_tenant.canonical_bytes().expect("ok"),
            "tenant_id must change canonical bytes"
        );

        let mut tweak_valid_from = base.clone();
        tweak_valid_from.manifest_valid_from_unix_secs += 1;
        assert_ne!(
            base_bytes,
            tweak_valid_from.canonical_bytes().expect("ok"),
            "valid_from must change canonical bytes"
        );

        let mut tweak_valid_until = base.clone();
        tweak_valid_until.manifest_valid_until_unix_secs += 1;
        assert_ne!(
            base_bytes,
            tweak_valid_until.canonical_bytes().expect("ok"),
            "valid_until must change canonical bytes"
        );

        let mut tweak_role_emergency = base.clone();
        tweak_role_emergency.roles[0].is_emergency_role = true;
        assert_ne!(
            base_bytes,
            tweak_role_emergency.canonical_bytes().expect("ok"),
            "is_emergency_role must change canonical bytes"
        );
    }

    /// WHY: SignedRbacManifest::from_body_and_signature_bytes rejects
    ///      non-64-byte signatures via Ed25519SignatureBytes::from_slice.
    #[test]
    fn signed_manifest_rejects_wrong_signature_length() {
        let m = canned_manifest();
        let err =
            SignedRbacManifest::from_body_and_signature_bytes(m, &[0u8; 63]).expect_err("short");
        assert_eq!(err.got, 63);
    }

    #[test]
    fn signed_manifest_accepts_64_byte_signature() {
        let m = canned_manifest();
        let signed =
            SignedRbacManifest::from_body_and_signature_bytes(m, &[0u8; 64]).expect("valid length");
        assert_eq!(signed.signature.as_bytes(), &[0u8; 64]);
    }

    /// WHY: u32_len overflow guard — reject hostile manifests with absurd
    ///      length fields at canonicalize time.
    #[test]
    fn u32_len_rejects_overflow() {
        // Can't actually allocate a Vec of `usize::MAX` items; test the
        // helper in isolation via a guard check.
        let ok = u32_len(1_000_000).expect("reasonable len");
        assert_eq!(ok, 1_000_000u32);
        // On 64-bit platforms usize > u32::MAX is representable; test with
        // a conceptual oversize value.
        let err = u32_len((u32::MAX as usize) + 1).expect_err("oversize");
        assert_eq!(err, CanonicalBytesError::LengthExceedsU32);
    }

    /// WHY: serde round-trip via JSON — manifest wire format must survive
    ///      JSON (cloud → edge delivery) without shape drift.
    #[test]
    fn signed_manifest_json_roundtrip() {
        let m = canned_manifest();
        let signed = SignedRbacManifest {
            manifest: m,
            signature: Ed25519SignatureBytes::from_array([0x11u8; 64]),
        };
        let json = serde_json::to_string(&signed).expect("serialize");
        let back: SignedRbacManifest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, signed);
    }

    /// WHY: CanonicalBytesError Display format is audit-surface — pin it.
    #[test]
    fn canonical_bytes_error_display_snake_case() {
        assert_eq!(
            format!("{}", CanonicalBytesError::LengthExceedsU32),
            "length_exceeds_u32"
        );
        assert_eq!(
            format!("{}", CanonicalBytesError::PermissionEncodeFailed),
            "permission_encode_failed"
        );
    }

    /// WHY: is_emergency_role defaults to false via #[serde(default)] —
    ///      older manifests without the field still parse.
    #[test]
    fn custom_role_is_emergency_role_defaults_to_false_on_missing_field() {
        // Construct JSON WITHOUT is_emergency_role field.
        let json = r#"{
            "name": "viewer",
            "permissions": [],
            "valid_from_unix_secs": 0,
            "valid_until_unix_secs": 1
        }"#;
        let role: CustomRole = serde_json::from_str(json).expect("deserialize");
        assert!(!role.is_emergency_role);
    }

    /// WHY (EDGE-LOW-005 regression guard): a manifest JSON that OMITS
    ///      `is_emergency_role` must produce IDENTICAL canonical bytes to
    ///      the same manifest with `"is_emergency_role": false` explicit.
    ///      If they diverge, a forged older manifest could silently disable
    ///      emergency semantics at signature-verify time.
    #[test]
    fn canonical_bytes_stable_across_is_emergency_role_default_vs_explicit() {
        let json_implicit = r#"{
            "policy_version": 42,
            "tenant_id": [66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66],
            "manifest_valid_from_unix_secs": 1700000000,
            "manifest_valid_until_unix_secs": 1800000000,
            "operator_bindings": [],
            "roles": [{
                "name": "viewer",
                "permissions": [],
                "valid_from_unix_secs": 0,
                "valid_until_unix_secs": 1
            }]
        }"#;
        let json_explicit = r#"{
            "policy_version": 42,
            "tenant_id": [66,66,66,66,66,66,66,66,66,66,66,66,66,66,66,66],
            "manifest_valid_from_unix_secs": 1700000000,
            "manifest_valid_until_unix_secs": 1800000000,
            "operator_bindings": [],
            "roles": [{
                "name": "viewer",
                "permissions": [],
                "valid_from_unix_secs": 0,
                "valid_until_unix_secs": 1,
                "is_emergency_role": false
            }]
        }"#;
        let m1: RbacManifest = serde_json::from_str(json_implicit).expect("implicit parse");
        let m2: RbacManifest = serde_json::from_str(json_explicit).expect("explicit parse");
        assert_eq!(
            m1.canonical_bytes().expect("ok1"),
            m2.canonical_bytes().expect("ok2"),
            "canonical bytes must be identical whether is_emergency_role is \
             absent (serde default) or explicitly false — otherwise an old \
             manifest could smuggle emergency-disable without re-signature"
        );
    }

    /// WHY (EDGE-LOW-003 closure): Ed25519PublicKeyBytes::from_slice rejects
    ///      non-32-byte input with structured error, parallel to
    ///      Ed25519SignatureBytes::from_slice.
    #[test]
    fn ed25519_public_key_bytes_rejects_wrong_length() {
        let err = Ed25519PublicKeyBytes::from_slice(&[0u8; 31]).expect_err("short");
        assert_eq!(err, InvalidPubKeyLength { got: 31 });
        let err = Ed25519PublicKeyBytes::from_slice(&[0u8; 33]).expect_err("long");
        assert_eq!(err, InvalidPubKeyLength { got: 33 });
        let err = Ed25519PublicKeyBytes::from_slice(&[]).expect_err("empty");
        assert_eq!(err, InvalidPubKeyLength { got: 0 });
    }

    #[test]
    fn ed25519_public_key_bytes_accepts_32_byte_slice() {
        let input = [0xabu8; 32];
        let k = Ed25519PublicKeyBytes::from_slice(&input).expect("valid length");
        assert_eq!(k.as_bytes(), &input);
    }

    #[test]
    fn invalid_pub_key_length_display_format() {
        assert_eq!(
            format!("{}", InvalidPubKeyLength { got: 31 }),
            "ed25519 pubkey length 31 != 32"
        );
    }
}
