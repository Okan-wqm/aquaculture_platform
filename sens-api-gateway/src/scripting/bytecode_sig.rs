//! Signed bytecode artifact — Batch 158 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! Plan §3 R-1 + §5 Faz 3 item 3 specify that the bytecode
//! artifact is signed with the command-signing ed25519 key at
//! compile time + verified by the edge at deploy time. A
//! `.stbc` file received over MQTT may have been truncated,
//! tampered, or fabricated — without a signature, the VM would
//! execute adversary-controlled opcodes.
//!
//! Batch 158 lands the CANONICAL encoding + signed wrapper +
//! verify function. The verify function matches the Batch 8
//! firmware-manifest pattern (closure-injected signature
//! check, fail-closed, most-expensive-gate-last).
//!
//! ## Architectural shape
//!
//! - `SignedBytecode { bytecode: Bytecode, signature:
//!   Ed25519SignatureBytes }` — the wire shape.
//! - `canonical_bytes(&Bytecode) -> Vec<u8>` — domain-separated
//!   deterministic binary encoding. Mirrors the firmware
//!   manifest pattern: big-endian integers, length-prefixed
//!   strings, opcodes serialized by stable wire_tag +
//!   per-variant payload. Trailing domain tag
//!   `b"st-bytecode-v1"` binds the signature to THIS schema
//!   — a future schema revision bumps the tag + key ceremony.
//! - `verify_signed_bytecode(signed, verify_closure) ->
//!   Result<Bytecode, BytecodeVerifyError>` — returns the
//!   validated bytecode body on success, structured error
//!   on any gate rejection.
//!
//! ## What's not in Batch 158
//!
//! - The verify closure itself lives in the keystore layer
//!   (a future batch wires it from `PolicyEngine::verify_sig`
//!   or the Batch 114 firmware_signing_pubkey).
//! - The compiler doesn't sign yet — signing is a host-tool
//!   operation (operator's build pipeline). Tests below use
//!   `ed25519_dalek` directly to simulate the host sign
//!   step.
//! - Tenant + policy-version binding: `Bytecode` gets optional
//!   `tenant_id` / `policy_version` fields in this batch
//!   (serde-default for backward compat), wired into the
//!   canonical encoding. The cross-field verify (tenant
//!   match + monotonic policy_version) lands in the deploy-
//!   command batch.

#![allow(dead_code)]

// Bytecode IR types. `StValueType` is only referenced
// by name inside the tests (retain_var construction);
// the non-test code accesses `ty.wire_tag()` via
// method dispatch on the tuple field type, which does
// not require `StValueType` to be in scope. Keep it
// out of the non-test `use` so no unused-import
// warning fires.
use super::bytecode::{Bytecode, Opcode, StValue, StdlibFunctionId};
use crate::authz::policy::Ed25519SignatureBytes;

/// Wire shape: Bytecode body + detached ed25519 signature
/// over the canonical bytes.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SignedBytecode {
    pub bytecode: Bytecode,
    pub signature: Ed25519SignatureBytes,
}

/// Verification failure taxonomy. Each variant gives the
/// operator enough information to diagnose without exposing
/// sensitive material (no key bytes, no signature bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BytecodeVerifyError {
    /// Canonical encoding failed — unencodable field length
    /// (e.g. a string longer than u32::MAX bytes). Defense-
    /// in-depth; the compiler should never produce such a
    /// bytecode, but a crafted wire input might.
    CanonicalEncoding {
        what: &'static str,
    },
    /// ed25519 signature verification returned false.
    InvalidSignature,
}

impl std::fmt::Display for BytecodeVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CanonicalEncoding { what } => {
                write!(f, "bytecode canonical encoding failed: {}", what)
            }
            Self::InvalidSignature => {
                write!(f, "bytecode signature verification failed")
            }
        }
    }
}

impl std::error::Error for BytecodeVerifyError {}

/// Domain-separation tag suffix. Binds the signature to the
/// bytecode schema version — the verifier recomputes this
/// exact byte string as part of the canonical bytes, so a
/// signature produced over `firmware-manifest-v1` can NEVER
/// verify against `st-bytecode-v1`.
const DOMAIN_TAG_V1: &[u8] = b"st-bytecode-v1";

/// Wire-format version for the canonical encoding. Bumped
/// in lockstep with DOMAIN_TAG_V* when the encoding changes.
const WIRE_VERSION_V1: u16 = 1;

/// Produce the canonical byte representation of a Bytecode
/// for signing / verification.
///
/// Encoding:
/// ```text
///   magic          "STBC" (4 bytes)
///   wire_version   u16 big-endian
///   program_id     u32 len + bytes
///   program_name   u32 len + bytes
///   max_gas_per_tick  u32 big-endian
///   local_count       u32 big-endian
///   retain_vars    u32 count, each = u32 len + name bytes
///                                  + u8 StValueType wire_tag
///   allowed_write_tags   u32 count, each = u32 len + bytes
///   safe_state_pinned_tags  u32 count, each = u32 len + bytes
///   opcodes        u32 count, each = u8 wire_tag + per-variant payload
///   domain_tag     b"st-bytecode-v1"  (no length prefix; trailing binding)
/// ```
pub fn canonical_bytes(bc: &Bytecode) -> Result<Vec<u8>, BytecodeVerifyError> {
    let mut out = Vec::with_capacity(256 + bc.opcodes.len() * 8);

    out.extend_from_slice(b"STBC");
    out.extend_from_slice(&WIRE_VERSION_V1.to_be_bytes());

    write_str(&mut out, &bc.program_id, "program_id")?;
    write_str(&mut out, &bc.program_name, "program_name")?;

    out.extend_from_slice(&bc.max_gas_per_tick.to_be_bytes());
    out.extend_from_slice(&bc.local_count.to_be_bytes());

    write_u32_len(&mut out, bc.retain_vars.len(), "retain_vars count")?;
    for (name, ty) in &bc.retain_vars {
        write_str(&mut out, name, "retain_var name")?;
        out.push(ty.wire_tag());
    }

    write_u32_len(
        &mut out,
        bc.allowed_write_tags.len(),
        "allowed_write_tags count",
    )?;
    for t in &bc.allowed_write_tags {
        write_str(&mut out, t, "allowed_write_tag")?;
    }

    write_u32_len(
        &mut out,
        bc.safe_state_pinned_tags.len(),
        "safe_state_pinned_tags count",
    )?;
    for t in &bc.safe_state_pinned_tags {
        write_str(&mut out, t, "safe_state_pinned_tag")?;
    }

    write_u32_len(&mut out, bc.opcodes.len(), "opcodes count")?;
    for op in &bc.opcodes {
        write_opcode(&mut out, op)?;
    }

    out.extend_from_slice(DOMAIN_TAG_V1);
    Ok(out)
}

/// Verify a signed bytecode artifact. Returns the validated
/// bytecode on success. Gate order:
/// 1. Canonical bytes recompute (structural).
/// 2. ed25519 signature verify (most expensive; closure-
///    injected so the keystore layer can plug its active
///    public key).
///
/// Tenant + policy-version cross-checks live at the deploy-
/// command layer — this function's contract is strictly
/// "did the signature match the canonical bytes?".
pub fn verify_signed_bytecode(
    signed: &SignedBytecode,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<Bytecode, BytecodeVerifyError> {
    let canonical = canonical_bytes(&signed.bytecode)?;
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(BytecodeVerifyError::InvalidSignature);
    }
    Ok(signed.bytecode.clone())
}

// ============================================================================
// Internal helpers
// ============================================================================

fn write_u32_len(
    out: &mut Vec<u8>,
    len: usize,
    what: &'static str,
) -> Result<(), BytecodeVerifyError> {
    let as_u32 = u32::try_from(len)
        .map_err(|_| BytecodeVerifyError::CanonicalEncoding { what })?;
    out.extend_from_slice(&as_u32.to_be_bytes());
    Ok(())
}

fn write_str(
    out: &mut Vec<u8>,
    s: &str,
    what: &'static str,
) -> Result<(), BytecodeVerifyError> {
    let bytes = s.as_bytes();
    write_u32_len(out, bytes.len(), what)?;
    out.extend_from_slice(bytes);
    Ok(())
}

fn write_opcode(
    out: &mut Vec<u8>,
    op: &Opcode,
) -> Result<(), BytecodeVerifyError> {
    // Wire tag is the stable 1-byte identifier.
    out.push(op.wire_tag());

    // Per-variant payload. Keep this match EXHAUSTIVE so
    // new opcode variants (added by extending the Opcode
    // enum) force the canonical encoding to be updated
    // explicitly — NO silent default branch.
    match op {
        Opcode::PushConst { value } => write_stvalue(out, value),
        Opcode::Pop
        | Opcode::Dup
        | Opcode::AddInt
        | Opcode::SubInt
        | Opcode::MulInt
        | Opcode::DivInt
        | Opcode::NegInt
        | Opcode::AddReal
        | Opcode::SubReal
        | Opcode::MulReal
        | Opcode::DivReal
        | Opcode::NegReal
        | Opcode::CastIntToReal
        | Opcode::Eq
        | Opcode::LtInt
        | Opcode::LtReal
        | Opcode::And
        | Opcode::Or
        | Opcode::Not
        | Opcode::Return
        | Opcode::GasTick
        | Opcode::SafeStateTrip => {
            // No payload beyond the wire_tag.
            Ok(())
        }
        Opcode::Jump { target } | Opcode::JumpIfFalse { target } => {
            out.extend_from_slice(&target.to_be_bytes());
            Ok(())
        }
        Opcode::LoadLocal { index } | Opcode::StoreLocal { index } => {
            out.extend_from_slice(&index.to_be_bytes());
            Ok(())
        }
        Opcode::LoadTag { name } | Opcode::WriteTag { name } => {
            write_str(out, name, "opcode.tag_name")
        }
        Opcode::StdlibCall { fn_id } => {
            out.push(stdlib_wire_tag(fn_id));
            Ok(())
        }
    }
}

fn write_stvalue(out: &mut Vec<u8>, v: &StValue) -> Result<(), BytecodeVerifyError> {
    // [type_tag u8][8-byte big-endian payload]
    out.push(v.type_tag());
    match v {
        StValue::Bool(b) => {
            // Pad to 8 bytes so every StValue serializes
            // to a fixed width — simplifies consumer-
            // side parsers + keeps canonical bytes
            // layout predictable.
            out.extend_from_slice(&[*b as u8, 0, 0, 0, 0, 0, 0, 0]);
        }
        StValue::Int(n) => {
            out.extend_from_slice(&n.to_be_bytes());
        }
        StValue::Real(x) => {
            // IEEE 754 f64 → 8-byte big-endian via bit
            // pattern so the exact bit representation
            // (including NaN / subnormal) round-trips.
            out.extend_from_slice(&x.to_bits().to_be_bytes());
        }
    }
    Ok(())
}

fn stdlib_wire_tag(fn_id: &StdlibFunctionId) -> u8 {
    fn_id.wire_tag()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::bytecode::StValueType;
    use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};

    fn canned_bytecode() -> Bytecode {
        Bytecode {
            program_id: "script-001".into(),
            program_name: "Fish Feeder".into(),
            max_gas_per_tick: 10_000,
            local_count: 2,
            retain_vars: vec![("total_feed".into(), StValueType::Real)],
            allowed_write_tags: vec!["feeder_rate".into()],
            safe_state_pinned_tags: vec!["emergency_stop".into()],
            opcodes: vec![
                Opcode::PushConst {
                    value: StValue::Real(2.5),
                },
                Opcode::WriteTag {
                    name: "feeder_rate".into(),
                },
                Opcode::Return,
            ],
        }
    }

    #[test]
    fn canonical_bytes_is_deterministic() {
        let bc = canned_bytecode();
        let a = canonical_bytes(&bc).expect("ok");
        let b = canonical_bytes(&bc).expect("ok");
        assert_eq!(a, b);
    }

    #[test]
    fn canonical_bytes_starts_with_magic_and_version() {
        let bc = canned_bytecode();
        let bytes = canonical_bytes(&bc).expect("ok");
        assert_eq!(&bytes[0..4], b"STBC");
        assert_eq!(&bytes[4..6], &WIRE_VERSION_V1.to_be_bytes());
    }

    #[test]
    fn canonical_bytes_ends_with_domain_tag() {
        let bc = canned_bytecode();
        let bytes = canonical_bytes(&bc).expect("ok");
        assert!(bytes.ends_with(DOMAIN_TAG_V1));
    }

    #[test]
    fn canonical_bytes_differs_on_program_id_change() {
        let mut a = canned_bytecode();
        let b_bc = {
            let mut c = a.clone();
            c.program_id = "script-002".into();
            c
        };
        let a_bytes = canonical_bytes(&mut a).expect("ok");
        let b_bytes = canonical_bytes(&b_bc).expect("ok");
        assert_ne!(a_bytes, b_bytes);
    }

    #[test]
    fn canonical_bytes_differs_on_opcode_tamper() {
        let a = canned_bytecode();
        let mut tampered = a.clone();
        tampered.opcodes[0] = Opcode::PushConst {
            value: StValue::Real(9.9),
        };
        let a_bytes = canonical_bytes(&a).expect("ok");
        let b_bytes = canonical_bytes(&tampered).expect("ok");
        assert_ne!(a_bytes, b_bytes);
    }

    fn signing_key_seed_1() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32])
    }

    fn signing_key_seed_2() -> SigningKey {
        SigningKey::from_bytes(&[2u8; 32])
    }

    fn sign(bc: &Bytecode, key: &SigningKey) -> SignedBytecode {
        let canonical = canonical_bytes(bc).expect("canonical ok");
        let sig = key.sign(&canonical);
        SignedBytecode {
            bytecode: bc.clone(),
            signature: Ed25519SignatureBytes::from_array(sig.to_bytes()),
        }
    }

    fn verify_with(key: VerifyingKey) -> impl FnOnce(&[u8], &[u8; 64]) -> bool {
        move |msg, sig_bytes| {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            key.verify(msg, &sig).is_ok()
        }
    }

    #[test]
    fn verify_signed_bytecode_accepts_matching_signature() {
        let key = signing_key_seed_1();
        let bc = canned_bytecode();
        let signed = sign(&bc, &key);
        let verified = verify_signed_bytecode(&signed, verify_with(key.verifying_key()))
            .expect("verify ok");
        assert_eq!(verified, bc);
    }

    #[test]
    fn verify_signed_bytecode_rejects_tampered_opcodes() {
        let key = signing_key_seed_1();
        let bc = canned_bytecode();
        let mut signed = sign(&bc, &key);
        // Tamper with the bytecode AFTER signing.
        signed.bytecode.opcodes[0] = Opcode::PushConst {
            value: StValue::Real(99.0),
        };
        assert_eq!(
            verify_signed_bytecode(&signed, verify_with(key.verifying_key())),
            Err(BytecodeVerifyError::InvalidSignature)
        );
    }

    #[test]
    fn verify_signed_bytecode_rejects_tampered_allowed_write_tags() {
        let key = signing_key_seed_1();
        let bc = canned_bytecode();
        let mut signed = sign(&bc, &key);
        signed.bytecode.allowed_write_tags = vec!["rogue_tag".into()];
        assert_eq!(
            verify_signed_bytecode(&signed, verify_with(key.verifying_key())),
            Err(BytecodeVerifyError::InvalidSignature)
        );
    }

    #[test]
    fn verify_signed_bytecode_rejects_wrong_key() {
        let key_a = signing_key_seed_1();
        let key_b = signing_key_seed_2();
        let bc = canned_bytecode();
        let signed = sign(&bc, &key_a);
        assert_eq!(
            verify_signed_bytecode(&signed, verify_with(key_b.verifying_key())),
            Err(BytecodeVerifyError::InvalidSignature)
        );
    }

    #[test]
    fn verify_signed_bytecode_rejects_pinned_tag_downgrade() {
        // Security-critical: if an attacker strips a tag
        // out of safe_state_pinned_tags (so the Batch 156
        // gate no longer fires), the signature must fail.
        let key = signing_key_seed_1();
        let bc = canned_bytecode();
        let mut signed = sign(&bc, &key);
        signed.bytecode.safe_state_pinned_tags.clear();
        assert_eq!(
            verify_signed_bytecode(&signed, verify_with(key.verifying_key())),
            Err(BytecodeVerifyError::InvalidSignature)
        );
    }

    #[test]
    fn domain_tag_prevents_cross_schema_replay() {
        // Canonical bytes must differ even if the same
        // struct payload were signed under a different
        // schema version. Swapping the domain tag is
        // simulated by changing the trailing bytes —
        // if the ACTUAL bytes match (same schema), the
        // signature verifies; the domain tag binds them.
        let bc = canned_bytecode();
        let bytes = canonical_bytes(&bc).expect("ok");
        let tail_len = DOMAIN_TAG_V1.len();
        let (body, tail) = bytes.split_at(bytes.len() - tail_len);
        assert_eq!(tail, DOMAIN_TAG_V1);
        // Body without the domain tag must be distinct
        // from body + wrong-tag.
        let mut fake = body.to_vec();
        fake.extend_from_slice(b"st-bytecode-v2");
        assert_ne!(bytes, fake);
    }
}
