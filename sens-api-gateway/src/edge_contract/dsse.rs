//! DSSE v1 envelopes (statements.json `dsse`, ADR-048 DEC-3.2).
//!
//! The signature covers `PAE(payloadType, payload bytes)` exactly; nothing is
//! re-serialized or canonicalized, and a payload is parsed only after its
//! signature verifies under ed25519-dalek `verify_strict`.

use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

use super::encoding::{
    decode_base64_array, decode_canonical_base64, is_payload_type, is_sha256_hex,
};
use super::json::check_strict_object;
use super::registry::Reason;

/// Largest base64 payload the envelope schema admits.
const MAX_PAYLOAD_B64: usize = 1_048_576;

/// The wire form of an envelope (schemas/dsse-envelope.schema.json).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEnvelope {
    #[serde(rename = "payloadType")]
    payload_type: String,
    payload: String,
    signatures: Vec<RawSignature>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSignature {
    keyid: String,
    sig: String,
}

/// A schema-valid envelope with its payload and signature decoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// DSSE payloadType.
    pub payload_type: String,
    /// The exact signed payload bytes.
    pub payload: Vec<u8>,
    /// Keyid of the single signature.
    pub keyid: String,
    /// The 64-byte Ed25519 signature.
    pub signature: [u8; 64],
}

impl Envelope {
    /// Parses envelope bytes; any failure is `envelope-invalid`.
    pub fn parse(bytes: &[u8]) -> Result<Self, Reason> {
        check_strict_object(bytes).map_err(|_| Reason::EnvelopeInvalid)?;
        let raw: RawEnvelope =
            serde_json::from_slice(bytes).map_err(|_| Reason::EnvelopeInvalid)?;
        Self::from_raw(raw).ok_or(Reason::EnvelopeInvalid)
    }

    /// Validates the wire form against the envelope schema.
    fn from_raw(raw: RawEnvelope) -> Option<Self> {
        if !is_payload_type(&raw.payload_type)
            || raw.payload.len() < 4
            || raw.payload.len() > MAX_PAYLOAD_B64
        {
            return None;
        }
        let payload = decode_canonical_base64(&raw.payload)?;
        // Exactly one signature per envelope (statements.json dsse.signatures).
        let [signature] = <[RawSignature; 1]>::try_from(raw.signatures).ok()?;
        if !is_sha256_hex(&signature.keyid) || signature.sig.len() != 88 {
            return None;
        }
        let sig = decode_base64_array::<64>(&signature.sig)?;
        Some(Self {
            payload_type: raw.payload_type,
            payload,
            keyid: signature.keyid,
            signature: sig,
        })
    }

    /// SHA-256 of the decoded payload (statements.json `statement_digest`).
    pub fn statement_digest(&self) -> String {
        super::encoding::sha256_hex(&self.payload)
    }
}

/// DSSE v1 pre-authentication encoding.
pub fn pae(payload_type: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload_type.len() + payload.len() + 32);
    out.extend_from_slice(b"DSSEv1 ");
    out.extend_from_slice(payload_type.len().to_string().as_bytes());
    out.push(b' ');
    out.extend_from_slice(payload_type.as_bytes());
    out.push(b' ');
    out.extend_from_slice(payload.len().to_string().as_bytes());
    out.push(b' ');
    out.extend_from_slice(payload);
    out
}

/// `verify_strict` of `signature` over `message` under the raw public key.
/// A key that is not a canonical, decodable point never verifies.
pub fn verify_strict(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    VerifyingKey::from_bytes(public_key)
        .and_then(|key| key.verify_strict(message, &Signature::from_bytes(signature)))
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pae_matches_dsse_example() {
        assert_eq!(
            super::super::encoding::hex_lower(&pae(
                "http://example.com/HelloWorld",
                b"hello world"
            )),
            "44535345763120323920687474703a2f2f6578616d706c652e636f6d2f48656c6c6f576f726c642031312068656c6c6f20776f726c64"
        );
    }

    #[test]
    fn envelope_rejects_schema_violations() {
        let sig = "A".repeat(85) + "A==";
        let keyid = "a".repeat(64);
        let ok = format!(
            r#"{{"payloadType":"application/vnd.suderra.edge-release.v1+json","payload":"e30=","signatures":[{{"keyid":"{keyid}","sig":"{sig}"}}]}}"#
        );
        assert!(Envelope::parse(ok.as_bytes()).is_ok());
        for bad in [
            ok.replace(r#""signatures":["#, r#""extra":1,"signatures":["#),
            ok.replace("e30=", "e30"),
            ok.replace("e30=", ""),
            ok.replace(&keyid, &"A".repeat(64)),
            ok.replace("edge-release.v1", "edge-release.v0"),
            ok.replace(&sig, &("A".repeat(85) + "B==")),
            ok.replace("}]}", r#"},{"keyid":"x","sig":"y"}]}"#),
            ok.replace(r#""signatures":[{"#, r#""signatures":[],"x":[{"#),
        ] {
            assert_eq!(
                Envelope::parse(bad.as_bytes()),
                Err(Reason::EnvelopeInvalid),
                "{bad}"
            );
        }
    }
}
