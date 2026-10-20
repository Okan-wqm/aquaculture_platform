//! The cloud signer's CommandEnvelope v3 vector, verified as the agent
//! verifies a command in Enforcing mode (ADR-048 DEC-9.2).
//!
//! The cloud (apps/sensor-service/src/edge-device/command-envelope-signer.service.ts)
//! and this crate each build the signed transcript themselves, so one byte of
//! difference in key order, number or string form, framing or a domain tag
//! would refuse every command a Suderra OS agent receives while both test
//! suites stayed green on their own. `tests/fixtures/command-envelope-v3/
//! platform-command.json` is written from this crate's layout by
//! `scripts/edge/command_envelope_vector.py`; the cloud's jest spec asserts its
//! signer reproduces every byte, and this test asserts the agent parses the
//! wire JSON, recomputes the same canonical params, cmd_hash and transcript,
//! and accepts the signature under `verify_envelope` in Enforcing mode.

use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::canonical::canonical_params;
use super::envelope::{
    CommandEnvelope, EnvelopeVerifyError, SignatureMode, envelope_canonical_bytes, verify_envelope,
};

const VECTOR: &str = include_str!("../../tests/fixtures/command-envelope-v3/platform-command.json");

fn vector() -> Value {
    serde_json::from_str(VECTOR).expect("the vector is JSON")
}

fn text<'a>(vector: &'a Value, field: &str) -> &'a str {
    vector[field]
        .as_str()
        .unwrap_or_else(|| panic!("vector field {field} is a string"))
}

fn hex(field: &str) -> Vec<u8> {
    let vector = vector();
    let digits = text(&vector, field);
    (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).expect("vector hex"))
        .collect()
}

fn wire_envelope() -> CommandEnvelope {
    let vector = vector();
    serde_json::from_str(text(&vector, "wire")).expect("the cloud's wire envelope parses")
}

fn verify(env: &CommandEnvelope, now: i64) -> Result<super::Jti, EnvelopeVerifyError> {
    let key_bytes: [u8; 32] = hex("public_key_hex")
        .try_into()
        .expect("32-byte public key");
    let key = VerifyingKey::from_bytes(&key_bytes).expect("an Ed25519 public key");
    let tenant: [u8; 16] = hex("tenant_hex").try_into().expect("16-byte tenant");
    verify_envelope(
        env,
        &tenant,
        now,
        SignatureMode::Enforcing,
        |canonical: &[u8]| -> [u8; 32] { Sha256::digest(canonical).into() },
        |transcript: &[u8], signature: &[u8; 64]| -> bool {
            key.verify_strict(transcript, &Signature::from_bytes(signature))
                .is_ok()
        },
    )
}

fn now() -> i64 {
    vector()["now_unix_secs"].as_i64().expect("now_unix_secs")
}

#[test]
fn the_agent_recomputes_the_clouds_canonical_params_cmd_hash_and_transcript() {
    let env = wire_envelope();
    let params = canonical_params(&env.cmd, &env.params).expect("canonical params");
    assert_eq!(params, hex("canonical_params_hex"));
    let cmd_hash: [u8; 32] = Sha256::digest(&params).into();
    assert_eq!(cmd_hash.to_vec(), hex("cmd_hash_hex"));
    assert_eq!(env.cmd_hash.as_bytes(), &cmd_hash);
    let transcript = envelope_canonical_bytes(&env).expect("transcript");
    assert_eq!(transcript, hex("envelope_canonical_bytes_hex"));
    let signature = env
        .signature
        .as_ref()
        .expect("the cloud signs every envelope");
    assert_eq!(signature.as_bytes().to_vec(), hex("signature_hex"));
}

#[test]
fn the_clouds_platform_command_verifies_in_enforcing_mode() {
    let env = wire_envelope();
    let jti = verify(&env, now()).expect("the cloud's envelope verifies");
    assert_eq!(jti.as_str(), env.jti);
}

#[test]
fn a_changed_parameter_or_signature_is_refused() {
    let mut tampered = wire_envelope();
    tampered.params["count"] = Value::from(43);
    assert_eq!(
        verify(&tampered, now()),
        Err(EnvelopeVerifyError::CmdHashMismatch)
    );

    let mut forged = wire_envelope();
    forged.nonce.push('0');
    assert_eq!(
        verify(&forged, now()),
        Err(EnvelopeVerifyError::SignatureInvalid)
    );
}
