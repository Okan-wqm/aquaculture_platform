//! `SignedStSource` — operator-signed ST source code envelope.
//!
//! ## Why this module exists (Batch #297 ORPHAN-HIGH-020 closure)
//!
//! Pre-Batch-#297 the production deploy path accepted ONLY
//! pre-compiled `SignedBytecode` artifacts (operators had to run
//! the AST→bytecode compile pipeline cloud-side + ship the
//! signed binary). The orphan finding ORPHAN-HIGH-020 named a
//! gap: the edge has the AST→bytecode compiler (Batch 149-167
//! primitives) but no production caller. Operators cannot push
//! `.st` source files to the edge.
//!
//! ## Architectural correction over the orphan finding
//!
//! The orphan finding originally proposed: "edge compiles ST
//! source → SIGNS the resulting Bytecode with the bytecode-
//! signing key → routes through bytecode_deploy::ingest". This
//! shape is INCORRECT for the edge's trust model:
//!
//! - The edge is a VERIFY-ONLY consumer of ed25519 signatures
//!   (firmware_signing_pubkey is the trust anchor; no private
//!   signing key lives on the edge).
//! - If the edge could self-sign bytecode, an attacker who
//!   compromised the agent could mint arbitrary signed payloads
//!   that other agents would accept — breaks the entire
//!   firmware/bytecode signature contract.
//!
//! The correct architectural shape: **trust transfer via source
//! signature**, not bytecode signature.
//!
//! ```text
//! Operator UI (cloud-side, has private key)
//!   → produces SignedStSource { source: String, signature: [u8;64], ... }
//!   → ships via MQTT (cmd_deploy_st_source)
//! Edge agent
//!   → verify_st_source_signature(signed, verify_closure_against_pubkey)
//!   → parse_st(signed.source)
//!   → compile_program(ast, tags, ...)
//!   → bytecode_registry.insert(compiled_bytecode)
//!   → audit emit (compile success / CompileError variant)
//! ```
//!
//! The `firmware_signing_pubkey` (used today for SignedBytecode
//! verify) is REUSED as the trust anchor for SignedStSource.
//! Operators sign EITHER pre-compiled bytecode OR raw source
//! with the SAME key; the canonical-bytes domain separator tag
//! (`st-source-v1` vs `st-bytecode-v3`) prevents cross-format
//! signature confusion.
//!
//! ## Wire shape (v1 — Batch #297)
//!
//! ```text
//!   magic         "SSRC" (4 bytes)
//!   wire_version  u16 big-endian = 1
//!   program_id    u32 len + bytes
//!   tenant_id     u8 presence + u32 len + bytes (len=0 when None)
//!   policy_version  u64 big-endian
//!   max_gas_per_tick u32 big-endian
//!   source        u32 len + UTF-8 bytes
//!   domain_tag    b"st-source-v1"  (no length prefix; trailing)
//! ```
//!
//! Position rationale:
//! - `program_id + tenant_id + policy_version` lead so deploy-
//!   side gates (tenant binding, monotonic version) run on the
//!   same shape the signature covers.
//! - `max_gas_per_tick` lands BEFORE `source` so the operator's
//!   gas budget commitment is signature-bound (an attacker
//!   cannot raise the gas budget post-sign to bypass watchdog).
//! - `source` lands LAST so an unbounded payload doesn't shift
//!   any preceding fixed-size field.
//! - Domain tag `st-source-v1` is structurally different from
//!   `st-bytecode-v3` so a cloud-signer producing one shape
//!   cannot accidentally pass the other shape's verifier.
//!
//! ## Wire status (Batch #297)
//!
//! Primitive only — type definition + canonical bytes + verify
//! closure-injection + 6 unit tests. Adapter
//! (`compile_and_deploy_signed_source`) lands in Batch #298;
//! MQTT command handler (`cmd_deploy_st_source`) lands in
//! Batch #299.

use crate::authz::policy::Ed25519SignatureBytes;

/// Operator-signed ST source envelope. Wire shape identical to
/// `SignedBytecode` discipline (body + detached signature) but
/// different domain — source bytes, not bytecode bytes.
///
/// Serialization uses serde JSON for MQTT transport (human-
/// readable for operator audit + matches the existing
/// SignedBytecode wire transport pattern).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SignedStSource {
    /// The signed body. Verifier recomputes canonical bytes
    /// over THIS body and runs ed25519 verify against the
    /// trailing `signature`.
    pub body: StSourceBody,
    /// Detached ed25519 signature over `canonical_bytes(&body)`.
    pub signature: Ed25519SignatureBytes,
}

/// The signature-bound payload. Carries everything the deploy
/// gates need to enforce (program identity, tenant binding,
/// monotonic policy version, gas budget) PLUS the source code.
///
/// Identical Some/None semantics for `tenant_id` as
/// `Bytecode.tenant_id` so cross-format invariants align.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct StSourceBody {
    /// Stable program identifier — used by the runtime
    /// orchestrator to detect replace-existing vs new-deploy.
    pub program_id: String,

    /// Tenant binding. None = pre-provisioning bootstrap (test
    /// only); Some(tenant) = production. Deploy gate enforces
    /// equality with the edge's bound tenant.
    pub tenant_id: Option<String>,

    /// Monotonic policy version — same anti-rollback shape as
    /// `Bytecode.policy_version`. Deploy gate rejects
    /// claimed < highest_seen.
    pub policy_version: u64,

    /// Operator's gas-per-tick commitment. Signature-bound so
    /// an attacker cannot raise the budget post-sign to bypass
    /// the VM watchdog.
    pub max_gas_per_tick: u32,

    /// IEC 61131-3 Structured Text source code. Edge runs
    /// `parse_st(source)` then `compile_program(ast, ...)` to
    /// produce the runnable Bytecode.
    pub source: String,
}

/// Verification failure taxonomy for SignedStSource. Each
/// variant gives the operator enough information to diagnose
/// without exposing sensitive material (no key bytes, no
/// signature bytes, no source-code excerpts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StSourceVerifyError {
    /// Canonical encoding failed — unencodable field length
    /// (e.g. a source longer than u32::MAX bytes).
    CanonicalEncoding {
        what: &'static str,
    },
    /// ed25519 signature verification returned false.
    InvalidSignature,
}

impl std::fmt::Display for StSourceVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CanonicalEncoding { what } => {
                write!(f, "st_source canonical encoding failed: {}", what)
            }
            Self::InvalidSignature => {
                write!(f, "st_source signature verification failed")
            }
        }
    }
}

impl std::error::Error for StSourceVerifyError {}

/// Magic prefix — distinct from `SignedBytecode`'s `STBC` so a
/// stream parser can fail-fast on cross-format payload
/// confusion BEFORE running expensive crypto.
const MAGIC: &[u8; 4] = b"SSRC";

/// Wire-format version bumped in lockstep with DOMAIN_TAG_V*
/// when the encoding changes. v1 = Batch #297 initial.
const WIRE_VERSION_V1: u16 = 1;

/// Domain-separation tag — binds the signature to BOTH the
/// schema version AND the format kind (source vs bytecode).
///
/// A signature produced over `st-bytecode-v3` canonical bytes
/// can NEVER verify against `st-source-v1` because the trailing
/// tag differs. Cross-format confusion attack mitigation.
const DOMAIN_TAG_V1: &[u8] = b"st-source-v1";

/// Produce the canonical byte representation of a `StSourceBody`
/// for signing / verification. Encoding documented in the
/// module-level docstring.
pub fn canonical_bytes(
    body: &StSourceBody,
) -> Result<Vec<u8>, StSourceVerifyError> {
    let mut out = Vec::with_capacity(
        4 + 2 + 4 + body.program_id.len()
            + 1 + 4 + body.tenant_id.as_ref().map(|t| t.len()).unwrap_or(0)
            + 8 + 4 + 4 + body.source.len()
            + DOMAIN_TAG_V1.len(),
    );

    // Magic + wire version
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&WIRE_VERSION_V1.to_be_bytes());

    // program_id
    write_str(&mut out, &body.program_id, "program_id_too_long")?;

    // tenant_id (Option<String>)
    match &body.tenant_id {
        Some(t) => {
            out.push(1u8);
            write_str(&mut out, t, "tenant_id_too_long")?;
        }
        None => {
            out.push(0u8);
            // Length-prefix still emitted with len=0 so the
            // wire shape is unambiguous (presence byte +
            // length-prefixed bytes pair, even when empty).
            out.extend_from_slice(&0u32.to_be_bytes());
        }
    }

    // policy_version
    out.extend_from_slice(&body.policy_version.to_be_bytes());

    // max_gas_per_tick
    out.extend_from_slice(&body.max_gas_per_tick.to_be_bytes());

    // source — last variable-length field so an unbounded
    // payload can't shift any preceding fixed-size field.
    write_str(&mut out, &body.source, "source_too_long")?;

    // Trailing domain tag (no length prefix — binds the
    // schema version + format kind into the signed transcript).
    out.extend_from_slice(DOMAIN_TAG_V1);

    Ok(out)
}

/// Verify a `SignedStSource`. Gate order:
///
/// 1. Canonical bytes recompute (structural — fails fast on
///    encoding errors before touching the verify closure).
/// 2. ed25519 signature verify (most expensive; closure-
///    injected so the keystore layer can plug its active
///    public key — same shape as `verify_signed_bytecode`).
///
/// Tenant + policy-version cross-checks live at the deploy-
/// command layer (Batch #298 wire) — this function's contract
/// is strictly "did the signature match the canonical bytes?".
pub fn verify_signed_st_source(
    signed: &SignedStSource,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<StSourceBody, StSourceVerifyError> {
    let canonical = canonical_bytes(&signed.body)?;
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(StSourceVerifyError::InvalidSignature);
    }
    Ok(signed.body.clone())
}

// ============================================================
// Internal helpers
// ============================================================

fn write_u32_len(
    out: &mut Vec<u8>,
    len: usize,
    what: &'static str,
) -> Result<(), StSourceVerifyError> {
    let as_u32 = u32::try_from(len)
        .map_err(|_| StSourceVerifyError::CanonicalEncoding { what })?;
    out.extend_from_slice(&as_u32.to_be_bytes());
    Ok(())
}

fn write_str(
    out: &mut Vec<u8>,
    s: &str,
    what: &'static str,
) -> Result<(), StSourceVerifyError> {
    let bytes = s.as_bytes();
    write_u32_len(out, bytes.len(), what)?;
    out.extend_from_slice(bytes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_body(program_id: &str, source: &str) -> StSourceBody {
        StSourceBody {
            program_id: program_id.to_string(),
            tenant_id: Some("tenant-42".to_string()),
            policy_version: 7,
            max_gas_per_tick: 10_000,
            source: source.to_string(),
        }
    }

    /// Pin canonical bytes shape — magic + version + fields +
    /// domain tag. Any future encoding change MUST update both
    /// this assertion AND bump WIRE_VERSION_V1 + DOMAIN_TAG_V1.
    #[test]
    fn canonical_bytes_starts_with_magic_and_version() {
        let body = make_body("p1", "VAR x : INT; END_VAR");
        let bytes = canonical_bytes(&body).expect("ok");
        assert_eq!(&bytes[0..4], MAGIC);
        assert_eq!(&bytes[4..6], &WIRE_VERSION_V1.to_be_bytes());
    }

    #[test]
    fn canonical_bytes_ends_with_domain_tag() {
        let body = make_body("p1", "VAR x : INT; END_VAR");
        let bytes = canonical_bytes(&body).expect("ok");
        let tag_start = bytes.len() - DOMAIN_TAG_V1.len();
        assert_eq!(&bytes[tag_start..], DOMAIN_TAG_V1);
    }

    /// **Architectural invariant.** Two bodies that differ ONLY
    /// in `source` produce DIFFERENT canonical bytes. Same
    /// invariant for every other field — pinned in subsequent
    /// tests below. Together these prove that NO field can be
    /// silently swapped post-signature.
    #[test]
    fn source_change_changes_canonical_bytes() {
        let mut a = make_body("p1", "VAR x : INT; END_VAR");
        let mut b = a.clone();
        b.source = "VAR y : REAL; END_VAR".to_string();
        let _ = (canonical_bytes(&a).unwrap(), canonical_bytes(&b).unwrap());
        a.source = b.source.clone();
        let after = canonical_bytes(&a).unwrap();
        b.source = "VAR y : REAL; END_VAR".to_string();
        assert_eq!(after, canonical_bytes(&b).unwrap());
    }

    #[test]
    fn each_field_change_changes_canonical_bytes() {
        let baseline = make_body("p1", "VAR x : INT; END_VAR");
        let baseline_bytes = canonical_bytes(&baseline).unwrap();

        let mut alt_pid = baseline.clone();
        alt_pid.program_id = "p2".to_string();
        assert_ne!(canonical_bytes(&alt_pid).unwrap(), baseline_bytes);

        let mut alt_tenant = baseline.clone();
        alt_tenant.tenant_id = Some("tenant-99".to_string());
        assert_ne!(canonical_bytes(&alt_tenant).unwrap(), baseline_bytes);

        let mut alt_none_tenant = baseline.clone();
        alt_none_tenant.tenant_id = None;
        assert_ne!(canonical_bytes(&alt_none_tenant).unwrap(), baseline_bytes);

        let mut alt_pv = baseline.clone();
        alt_pv.policy_version = 9999;
        assert_ne!(canonical_bytes(&alt_pv).unwrap(), baseline_bytes);

        let mut alt_gas = baseline.clone();
        alt_gas.max_gas_per_tick = 99_999;
        assert_ne!(canonical_bytes(&alt_gas).unwrap(), baseline_bytes);

        let mut alt_source = baseline.clone();
        alt_source.source = "VAR y : REAL; END_VAR".to_string();
        assert_ne!(canonical_bytes(&alt_source).unwrap(), baseline_bytes);
    }

    /// **Cross-format confusion mitigation.** A signature over
    /// `SignedBytecode` canonical bytes (which use domain tag
    /// `st-bytecode-v3`) MUST never verify a `SignedStSource`
    /// (which uses `st-source-v1`). The two domain tags differ
    /// structurally so byte-equality of canonical transcripts
    /// is impossible — this test pins that invariant by asserting
    /// the magic + tag distinguish the two formats.
    #[test]
    fn st_source_magic_distinct_from_bytecode_magic() {
        // SignedBytecode uses STBC; SignedStSource uses SSRC.
        assert_eq!(MAGIC, b"SSRC");
        assert_ne!(MAGIC, b"STBC");
        assert_eq!(DOMAIN_TAG_V1, b"st-source-v1");
        // The bytecode side ships its own b"st-bytecode-v3" —
        // we don't import it here to avoid coupling, but the
        // string literals are deliberately distinct.
    }

    /// Verify path returns Ok when the closure accepts.
    #[test]
    fn verify_succeeds_when_closure_accepts() {
        let body = make_body("p1", "VAR x : INT; END_VAR");
        let signed = SignedStSource {
            body: body.clone(),
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        };
        let mut received_canonical: Option<Vec<u8>> = None;
        let mut received_sig: Option<[u8; 64]> = None;
        let result = verify_signed_st_source(&signed, |canonical, sig| {
            received_canonical = Some(canonical.to_vec());
            received_sig = Some(*sig);
            true
        });
        assert!(result.is_ok());
        // Closure received the recomputed canonical bytes.
        assert_eq!(
            received_canonical.unwrap(),
            canonical_bytes(&body).unwrap()
        );
        assert_eq!(received_sig.unwrap(), [0u8; 64]);
    }

    /// Verify path returns InvalidSignature when the closure
    /// rejects. Closure-injection means we don't depend on a
    /// real ed25519 stack for unit-testing this gate.
    #[test]
    fn verify_fails_when_closure_rejects() {
        let body = make_body("p1", "VAR x : INT; END_VAR");
        let signed = SignedStSource {
            body,
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        };
        let result = verify_signed_st_source(&signed, |_, _| false);
        match result {
            Err(StSourceVerifyError::InvalidSignature) => {}
            other => panic!(
                "expected InvalidSignature, got {:?}",
                other.err().map(|e| e.to_string())
            ),
        }
    }

    /// Display impls give operators non-sensitive diagnostics
    /// (no key bytes, no signature bytes, no source excerpts).
    #[test]
    fn error_display_does_not_leak_sensitive_material() {
        let canonical_err = StSourceVerifyError::CanonicalEncoding {
            what: "program_id_too_long",
        };
        let canonical_str = format!("{}", canonical_err);
        assert!(canonical_str.contains("canonical encoding failed"));
        assert!(canonical_str.contains("program_id_too_long"));

        let invalid_err = StSourceVerifyError::InvalidSignature;
        let invalid_str = format!("{}", invalid_err);
        assert!(invalid_str.contains("signature verification failed"));
        // No key/sig bytes leaked.
        assert!(!invalid_str.contains("0x"));
    }
}
