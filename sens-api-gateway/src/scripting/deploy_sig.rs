//! Deploy-artifact signature envelope — ed25519 verification for
//! cloud→edge SCADA package + process deploys (enterprise plan Faz 4).
//!
//! ## Why this module exists
//!
//! Pre-Faz-4 the edge verified ed25519 signatures ONLY for ST
//! bytecode (`bytecode_sig`, domain tag `st-bytecode-v3`) and raw
//! ST source (`st_source_sig`, domain tag `st-source-v1`). SCADA
//! package deploys (`cmd_deploy_scada_package`) and process deploys
//! (`cmd_deploy_process`) were accepted UNSIGNED — an asymmetry:
//! the least-privileged artifact class (a display definition) and
//! the process graph that drives control mappings had weaker
//! integrity guarantees than a script.
//!
//! Faz 4 closes the asymmetry. The cloud (sensor-service
//! `DeploySigningService`) signs `tenant_id + artifact_sha256_hex`
//! under a per-kind domain tag; the edge recomputes the canonical
//! bytes and verifies against the SAME trust anchor already used
//! for bytecode/source (`firmware_signing_pubkey`). No new key
//! material, no new trust relationship — one anchor, four domain
//! tags.
//!
//! ## What is signed (and what is not — Faz 5 boundary)
//!
//! The signature binds the artifact's content hash
//! (`artifact_sha256_hex`, computed cloud-side over the canonical
//! key-sorted JSON stored in `deploy_artifacts.content_sha256`) and
//! the tenant binding. Edge-side recomputation of the content hash
//! over the received params requires the bundle staging area
//! (artifacts land as opaque staged blobs before apply) — that is
//! the Faz 5 `deploy_bundle` two-phase apply, a tracked plan phase
//! (docs/plans: gentle-waddling-rabbit Faz 5). In Faz 4 the edge
//! verifies signature-over-claimed-hash; Faz 5 adds
//! staged-content-hash == claimed-hash before apply.
//!
//! ## Wire shape (v1 — Faz 4)
//!
//! ```text
//!   magic               "SDEP" (4 bytes)
//!   wire_version        u16 big-endian = 1
//!   tenant_id           u8 presence + u32 len + bytes (len=0 when None)
//!   artifact_sha256_hex u32 len + 64 lowercase-hex ASCII bytes
//!   domain_tag          b"scada-pkg-v1" | b"process-v1" (no length prefix; trailing)
//! ```
//!
//! Position rationale mirrors `st_source_sig`:
//! - `tenant_id` leads so the deploy-side tenant-binding gate runs
//!   on the same shape the signature covers.
//! - `artifact_sha256_hex` is fixed-width (validated 64 lowercase
//!   hex) so no unbounded field precedes the domain tag.
//! - Per-kind trailing domain tag makes a signature minted for a
//!   process artifact structurally unable to verify a SCADA package
//!   (and vice versa), and both structurally distinct from
//!   `st-source-v1` / `st-bytecode-v3`.

/// Magic prefix — distinct from `SSRC` (st source) and `STBC`
/// (bytecode) so a stream parser fails fast on cross-format
/// payload confusion BEFORE running crypto.
const MAGIC: &[u8; 4] = b"SDEP";

/// Wire-format version bumped in lockstep with the domain tags
/// when the encoding changes. v1 = Faz 4 initial.
const WIRE_VERSION_V1: u16 = 1;

/// Domain-separation tag for SCADA package deploy signatures.
const DOMAIN_TAG_SCADA_PKG_V1: &[u8] = b"scada-pkg-v1";

/// Domain-separation tag for process deploy signatures.
const DOMAIN_TAG_PROCESS_V1: &[u8] = b"process-v1";

/// Domain-separation tag for release-bundle manifest signatures
/// (Faz 5 two-phase apply). Signs `tenant + manifestSha256`; the
/// manifest in turn pins each member artifact's content sha256, so
/// one signature transitively covers the whole bundle.
const DOMAIN_TAG_BUNDLE_V1: &[u8] = b"bundle-v1";

/// Artifact kind under signature. Selects the trailing domain tag —
/// the ONLY encoding difference between kinds, which is exactly the
/// cross-kind confusion mitigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeployArtifactKind {
    /// A `deploy_scada_package` params document (ScadaPackageDocV2
    /// + deploy meta) snapshotted in `deploy_artifacts`.
    ScadaPackage,
    /// A `deploy_process` params document (process graph + resolved
    /// tag mappings) snapshotted in `deploy_artifacts`.
    Process,
    /// A `deploy_bundle` release manifest (Faz 5): the sha256 under
    /// signature is the manifest's hash, not a single artifact's.
    Bundle,
}

impl DeployArtifactKind {
    fn domain_tag(self) -> &'static [u8] {
        match self {
            Self::ScadaPackage => DOMAIN_TAG_SCADA_PKG_V1,
            Self::Process => DOMAIN_TAG_PROCESS_V1,
            Self::Bundle => DOMAIN_TAG_BUNDLE_V1,
        }
    }
}

/// The signature-bound payload. Carries the tenant binding and the
/// content-address of the deployed artifact — everything the Faz 4
/// deploy gate enforces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploySigBody {
    /// Which artifact class this signature covers (selects the
    /// domain tag).
    pub kind: DeployArtifactKind,
    /// Tenant binding. None = pre-provisioning bootstrap (test
    /// only); Some(tenant) = production. Deploy gate enforces
    /// equality with the edge's bound tenant.
    pub tenant_id: Option<String>,
    /// Lowercase-hex sha256 of the canonical key-sorted JSON
    /// artifact content (`deploy_artifacts.content_sha256`
    /// cloud-side). Validated to exactly 64 lowercase hex chars
    /// before encoding.
    pub artifact_sha256_hex: String,
}

/// Verification failure taxonomy. Diagnosable without leaking
/// sensitive material (no key bytes, no signature bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeploySigError {
    /// Canonical encoding failed — unencodable field length.
    CanonicalEncoding { what: &'static str },
    /// `artifact_sha256_hex` is not exactly 64 lowercase hex chars.
    InvalidArtifactSha256,
    /// ed25519 signature verification returned false.
    InvalidSignature,
}

impl std::fmt::Display for DeploySigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CanonicalEncoding { what } => {
                write!(f, "deploy_sig canonical encoding failed: {}", what)
            }
            Self::InvalidArtifactSha256 => {
                write!(
                    f,
                    "deploy_sig artifact sha256 must be 64 lowercase hex chars"
                )
            }
            Self::InvalidSignature => {
                write!(f, "deploy_sig signature verification failed")
            }
        }
    }
}

impl std::error::Error for DeploySigError {}

/// Produce the canonical byte representation of a `DeploySigBody`
/// for signing / verification. Encoding documented in the
/// module-level docstring. The cloud-side signer
/// (`DeploySigningService.canonicalBytes`) MUST mirror this
/// byte-for-byte — pinned by the cross-language test vector below.
pub fn canonical_bytes(body: &DeploySigBody) -> Result<Vec<u8>, DeploySigError> {
    if !is_valid_sha256_hex(&body.artifact_sha256_hex) {
        return Err(DeploySigError::InvalidArtifactSha256);
    }

    let domain_tag = body.kind.domain_tag();
    let mut out = Vec::with_capacity(
        4 + 2
            + 1
            + 4
            + body.tenant_id.as_ref().map(|t| t.len()).unwrap_or(0)
            + 4
            + body.artifact_sha256_hex.len()
            + domain_tag.len(),
    );

    // Magic + wire version
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&WIRE_VERSION_V1.to_be_bytes());

    // tenant_id (Option<String>) — presence byte + length-prefixed
    // bytes, len=0 when None (same unambiguous pair shape as
    // st_source_sig).
    match &body.tenant_id {
        Some(t) => {
            out.push(1u8);
            write_str(&mut out, t, "tenant_id_too_long")?;
        }
        None => {
            out.push(0u8);
            out.extend_from_slice(&0u32.to_be_bytes());
        }
    }

    // artifact sha256 (validated fixed-width hex above)
    write_str(
        &mut out,
        &body.artifact_sha256_hex,
        "artifact_sha256_too_long",
    )?;

    // Trailing per-kind domain tag (no length prefix — binds the
    // schema version + artifact kind into the signed transcript).
    out.extend_from_slice(domain_tag);

    Ok(out)
}

/// Verify a deploy-artifact signature. Gate order:
///
/// 1. Canonical bytes recompute (structural — fails fast on sha
///    format / encoding errors before touching the verify closure).
/// 2. ed25519 signature verify (closure-injected so the caller
///    plugs `firmware_signing_pubkey` — same shape as
///    `verify_signed_st_source` / `verify_signed_bytecode`).
///
/// Tenant equality vs the edge's bound tenant is checked at the
/// deploy-command layer (`cmd_deploy_scada_package` /
/// `cmd_deploy_process`) — this function's contract is strictly
/// "did the signature match the canonical bytes?".
pub fn verify_deploy_signature(
    body: &DeploySigBody,
    signature: &[u8; 64],
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<(), DeploySigError> {
    let canonical = canonical_bytes(body)?;
    if !verify_signature(&canonical, signature) {
        return Err(DeploySigError::InvalidSignature);
    }
    Ok(())
}

/// Strict sha256-hex shape check: exactly 64 chars, each in
/// `[0-9a-f]`. Uppercase is REJECTED — the cloud canonicalizer
/// emits lowercase and accepting both would make two different
/// canonical transcripts verify the same artifact.
fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Parse a 128-char lowercase-hex ed25519 signature (the wire
/// representation the cloud `DeploySigningService` emits) into the
/// raw 64-byte array. None on any shape violation — the caller
/// maps that to a deploy rejection, never a silent skip.
pub fn parse_signature_hex(s: &str) -> Option<[u8; 64]> {
    if s.len() != 128 {
        return None;
    }
    let mut out = [0u8; 64];
    for (slot, chunk) in out.iter_mut().zip(s.as_bytes().chunks_exact(2)) {
        let &[hi, lo] = chunk else { return None };
        *slot = (hex_nibble(hi)? << 4) | hex_nibble(lo)?;
    }
    Some(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

// ============================================================
// Internal helpers
// ============================================================

fn write_u32_len(out: &mut Vec<u8>, len: usize, what: &'static str) -> Result<(), DeploySigError> {
    let as_u32 = u32::try_from(len).map_err(|_| DeploySigError::CanonicalEncoding { what })?;
    out.extend_from_slice(&as_u32.to_be_bytes());
    Ok(())
}

fn write_str(out: &mut Vec<u8>, s: &str, what: &'static str) -> Result<(), DeploySigError> {
    let bytes = s.as_bytes();
    write_u32_len(out, bytes.len(), what)?;
    out.extend_from_slice(bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, Verifier};

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn make_body(kind: DeployArtifactKind) -> DeploySigBody {
        DeploySigBody {
            kind,
            tenant_id: Some("tenant-42".to_string()),
            artifact_sha256_hex: SHA_A.to_string(),
        }
    }

    /// Pin canonical bytes shape — magic + version + trailing
    /// per-kind domain tag. Any future encoding change MUST update
    /// this assertion AND bump WIRE_VERSION_V1 + both domain tags.
    #[test]
    fn canonical_bytes_starts_with_magic_and_version() {
        let bytes = canonical_bytes(&make_body(DeployArtifactKind::ScadaPackage)).expect("ok");
        let mut expected_prefix = MAGIC.to_vec();
        expected_prefix.extend_from_slice(&WIRE_VERSION_V1.to_be_bytes());
        assert!(bytes.starts_with(&expected_prefix));
    }

    #[test]
    fn canonical_bytes_ends_with_per_kind_domain_tag() {
        let scada = canonical_bytes(&make_body(DeployArtifactKind::ScadaPackage)).expect("ok");
        assert!(scada.ends_with(DOMAIN_TAG_SCADA_PKG_V1));

        let process = canonical_bytes(&make_body(DeployArtifactKind::Process)).expect("ok");
        assert!(process.ends_with(DOMAIN_TAG_PROCESS_V1));
    }

    /// **Cross-kind confusion mitigation.** The SAME tenant + sha
    /// under different kinds produce DIFFERENT canonical bytes, so
    /// a signature minted for a process artifact can never verify a
    /// SCADA package. Tags are also distinct from the ST family.
    #[test]
    fn kind_change_changes_canonical_bytes() {
        let scada = canonical_bytes(&make_body(DeployArtifactKind::ScadaPackage)).unwrap();
        let process = canonical_bytes(&make_body(DeployArtifactKind::Process)).unwrap();
        let bundle = canonical_bytes(&make_body(DeployArtifactKind::Bundle)).unwrap();
        assert_ne!(scada, process);
        assert_ne!(scada, bundle);
        assert_ne!(process, bundle);

        assert_ne!(DOMAIN_TAG_SCADA_PKG_V1, DOMAIN_TAG_PROCESS_V1);
        assert_ne!(DOMAIN_TAG_SCADA_PKG_V1, DOMAIN_TAG_BUNDLE_V1);
        assert_ne!(DOMAIN_TAG_PROCESS_V1, DOMAIN_TAG_BUNDLE_V1);
        assert_ne!(DOMAIN_TAG_SCADA_PKG_V1, b"st-source-v1" as &[u8]);
        assert_ne!(DOMAIN_TAG_PROCESS_V1, b"st-source-v1" as &[u8]);
        assert_ne!(DOMAIN_TAG_BUNDLE_V1, b"st-source-v1" as &[u8]);
        assert_eq!(MAGIC, b"SDEP");
        assert_ne!(MAGIC, b"SSRC");
        assert_ne!(MAGIC, b"STBC");
    }

    #[test]
    fn canonical_bytes_ends_with_bundle_domain_tag() {
        let bundle = canonical_bytes(&make_body(DeployArtifactKind::Bundle)).expect("ok");
        assert!(bundle.ends_with(DOMAIN_TAG_BUNDLE_V1));
    }

    /// **Architectural invariant.** Every field participates in the
    /// signed transcript — no field can be silently swapped
    /// post-signature.
    #[test]
    fn each_field_change_changes_canonical_bytes() {
        let baseline = make_body(DeployArtifactKind::ScadaPackage);
        let baseline_bytes = canonical_bytes(&baseline).unwrap();

        let mut alt_tenant = baseline.clone();
        alt_tenant.tenant_id = Some("tenant-99".to_string());
        assert_ne!(canonical_bytes(&alt_tenant).unwrap(), baseline_bytes);

        let mut alt_none_tenant = baseline.clone();
        alt_none_tenant.tenant_id = None;
        assert_ne!(canonical_bytes(&alt_none_tenant).unwrap(), baseline_bytes);

        let mut alt_sha = baseline.clone();
        alt_sha.artifact_sha256_hex = SHA_B.to_string();
        assert_ne!(canonical_bytes(&alt_sha).unwrap(), baseline_bytes);
    }

    #[test]
    fn parse_signature_hex_roundtrip_and_rejections() {
        let sig = [0xabu8; 64];
        let hex = hex_encode(&sig);
        assert_eq!(parse_signature_hex(&hex), Some(sig));

        // Wrong length, uppercase, non-hex all rejected.
        assert_eq!(parse_signature_hex(""), None);
        assert_eq!(parse_signature_hex(&hex[..126]), None);
        assert_eq!(parse_signature_hex(&hex.to_uppercase()), None);
        let mut bad = hex.clone();
        bad.replace_range(0..1, "z");
        assert_eq!(parse_signature_hex(&bad), None);
    }

    #[test]
    fn invalid_sha256_hex_rejected_before_crypto() {
        for bad in [
            "",                                                                   // empty
            "abc",                                                                // short
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",   // uppercase
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",   // non-hex
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // long
        ] {
            let body = DeploySigBody {
                kind: DeployArtifactKind::ScadaPackage,
                tenant_id: Some("tenant-42".to_string()),
                artifact_sha256_hex: bad.to_string(),
            };
            assert_eq!(
                canonical_bytes(&body),
                Err(DeploySigError::InvalidArtifactSha256),
                "expected rejection for sha {:?}",
                bad
            );
            let mut closure_ran = false;
            let result = verify_deploy_signature(&body, &[0u8; 64], |_, _| {
                closure_ran = true;
                true
            });
            assert_eq!(result, Err(DeploySigError::InvalidArtifactSha256));
            assert!(!closure_ran, "crypto closure must not run on bad sha");
        }
    }

    #[test]
    fn verify_succeeds_when_closure_accepts() {
        let body = make_body(DeployArtifactKind::Process);
        let mut received_canonical: Option<Vec<u8>> = None;
        let result = verify_deploy_signature(&body, &[7u8; 64], |canonical, sig| {
            received_canonical = Some(canonical.to_vec());
            assert_eq!(sig, &[7u8; 64]);
            true
        });
        assert!(result.is_ok());
        assert_eq!(received_canonical.unwrap(), canonical_bytes(&body).unwrap());
    }

    #[test]
    fn verify_fails_when_closure_rejects() {
        let body = make_body(DeployArtifactKind::ScadaPackage);
        let result = verify_deploy_signature(&body, &[0u8; 64], |_, _| false);
        assert_eq!(result, Err(DeploySigError::InvalidSignature));
    }

    /// Real ed25519 roundtrip with the deterministic test key
    /// (same fixture pattern as bytecode_sig): sign the canonical
    /// bytes, verify through the closure the deploy handlers use.
    #[test]
    fn ed25519_roundtrip_with_real_keys() {
        let signing_key = SigningKey::from_bytes(&[1u8; 32]);
        let verifying_key = signing_key.verifying_key();

        let body = make_body(DeployArtifactKind::ScadaPackage);
        let canonical = canonical_bytes(&body).unwrap();
        let signature = signing_key.sign(&canonical);

        let result = verify_deploy_signature(&body, &signature.to_bytes(), |msg, sig| {
            verifying_key
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig))
                .is_ok()
        });
        assert!(result.is_ok());

        // Tampered sha → different canonical bytes → verify fails.
        let mut tampered = body.clone();
        tampered.artifact_sha256_hex = SHA_B.to_string();
        let result = verify_deploy_signature(&tampered, &signature.to_bytes(), |msg, sig| {
            verifying_key
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig))
                .is_ok()
        });
        assert_eq!(result, Err(DeploySigError::InvalidSignature));
    }

    /// **Cross-language pinned vector.** The cloud-side signer
    /// (sensor-service `DeploySigningService`, Node `crypto`
    /// ed25519) and this module MUST produce byte-identical
    /// canonical transcripts and (ed25519 being deterministic)
    /// byte-identical signatures for the same seed. The TS test
    /// (`deploy-signing.service.spec.ts`) pins the SAME constants —
    /// if either side changes its encoding, exactly one side's pin
    /// breaks and the drift is caught at build time.
    ///
    /// Vector: seed = [0x01; 32], kind = ScadaPackage,
    /// tenant_id = "tenant-42", sha256 = "aa…aa" (64×'a').
    #[test]
    fn cross_language_pinned_vector() {
        let body = make_body(DeployArtifactKind::ScadaPackage);
        let canonical = canonical_bytes(&body).unwrap();

        let expected_canonical_hex = concat!(
            // magic "SDEP" + wire version 1
            "534445500001",
            // tenant presence 01 + len 9 + "tenant-42"
            "0100000009",
            "74656e616e742d3432",
            // sha len 64 + 64×'a' (0x61)
            "00000040",
            "6161616161616161616161616161616161616161616161616161616161616161",
            "6161616161616161616161616161616161616161616161616161616161616161",
            // domain tag "scada-pkg-v1"
            "73636164612d706b672d7631",
        );
        assert_eq!(hex_encode(&canonical), expected_canonical_hex);

        let signing_key = SigningKey::from_bytes(&[1u8; 32]);
        let signature = signing_key.sign(&canonical);
        assert_eq!(
            hex_encode(&signature.to_bytes()),
            PINNED_SIGNATURE_HEX,
            "cross-language signature pin drifted — cloud signer and edge verifier no longer agree"
        );
    }

    /// Deterministic ed25519 signature over the pinned canonical
    /// transcript, seed [0x01; 32]. The TS spec pins the identical
    /// constant.
    const PINNED_SIGNATURE_HEX: &str = "cf5e386d472b0d2af37a04093d670f75e96e46c548df9574c4dabb27ae605573b0e0de262f62fbbe5f947136b4ce300478a8247b9c1cfa9737fac2a16d79be06";
}
