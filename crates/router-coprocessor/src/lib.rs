//! router-coprocessor — self-built Apollo Router coprocessor (R1, PATH 2).
//!
//! WHY: the cutover to Apollo Router needs a coprocessor to sign each subgraph
//! request with the platform's service-identity HMAC-v2 (Rhai cannot do HMAC-SHA256).
//! The hot-path + crypto + single-droplet memory budget make Rust the right tool.
//!
//! LOAD-BEARING INVARIANT: the HMAC-v2 signing below MUST be byte-for-byte identical
//! to the TS `generateServiceIdentityHeadersV2`
//! (libs/backend-common/src/utils/service-identity.util.ts) — every subgraph guard
//! re-verifies the HMAC, so a one-byte divergence rejects all gateway→subgraph traffic.
//! The parity test pins the contract against a golden vector computed with the same
//! crypto primitives the TS generator uses (Node createHash/createHmac). This module
//! (the highest-risk integration point) is implemented + tested FIRST; the axum server,
//! RS256 JWT verification, Redis blacklist/rate-limit, and CSRF stages follow.

use hmac::digest::InvalidLength;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// The Apollo Router external-coprocessor wire contract (stage payload + control
/// signal). Kept in its own module so the protocol types are testable in isolation
/// from the crypto primitives below.
pub mod protocol;
/// The `SubgraphRequest` coprocessor stage: derives the canonical inputs from the
/// forwarded request and injects the 14 service-identity v2 headers via the golden
/// crypto primitives in this module.
pub mod subgraph_stage;

/// `SIG_VERSION_V2` in the TS SSoT.
pub const SIG_VERSION_V2: &str = "v2";
/// `CANONICAL_DELIM` in the TS SSoT — the 14 canonical fields are newline-joined.
pub const CANONICAL_DELIM: char = '\n';

type HmacSha256 = Hmac<Sha256>;

/// sha256 of the input as lowercase hex. Mirrors the TS `sha256Hex` helper.
#[must_use]
pub fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex::encode(hasher.finalize())
}

/// The 14 canonical fields, in the exact order the TS `buildCanonicalV2` emits them.
/// Callers resolve the TS defaults (key_id `"local-dev"`, audience/content_type/
/// assertion_hash `""`, effective_tenant_id ← tenant_id, nonce ← random uuid) before
/// constructing this; `body_hash`/`query_hash` are sha256 hex of the raw body/query.
#[derive(Debug, Clone)]
pub struct CanonicalV2Input {
    pub timestamp: String,
    pub service_name: String,
    pub method: String,
    pub path: String,
    pub body_hash: String,
    pub tenant_id: String,
    pub key_id: String,
    pub audience: String,
    pub query_hash: String,
    pub content_type: String,
    pub effective_tenant_id: String,
    pub assertion_hash: String,
    pub nonce: String,
}

/// Build the v2 canonical string: 14 fields joined by `\n`, byte-identical to the TS
/// `buildCanonicalV2`. The HTTP method is upper-cased (the only transform).
#[must_use]
pub fn build_canonical_v2(input: &CanonicalV2Input) -> String {
    [
        SIG_VERSION_V2.to_string(),
        input.timestamp.clone(),
        input.service_name.clone(),
        input.method.to_uppercase(),
        input.path.clone(),
        input.body_hash.clone(),
        input.tenant_id.clone(),
        input.key_id.clone(),
        input.audience.clone(),
        input.query_hash.clone(),
        input.content_type.clone(),
        input.effective_tenant_id.clone(),
        input.assertion_hash.clone(),
        input.nonce.clone(),
    ]
    .join(&CANONICAL_DELIM.to_string())
}

/// `HMAC-SHA256(canonical, secret)` as lowercase hex. Mirrors the TS
/// `createHmac('sha256', secret).update(canonical).digest('hex')`.
///
/// Returns `Err(InvalidLength)` only on the path HMAC never takes (any key length is
/// valid) — surfaced as a `Result` rather than a panic to satisfy the workspace's
/// no-`expect`/`unwrap` clippy lint.
pub fn sign_v2(canonical: &str, secret: &[u8]) -> Result<String, InvalidLength> {
    let mut mac = HmacSha256::new_from_slice(secret)?;
    mac.update(canonical.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Golden vector computed with the SAME crypto the TS generator uses
    // (Node createHash/createHmac), with fixed timestamp + nonce for determinism.
    // Regenerate via: node -e '<canonical join + createHmac>' (see PR description).
    // If the TS canonical layout or HMAC ever drifts, this fails loudly — which is the
    // point: the subgraph guards would otherwise silently reject the coprocessor.
    #[test]
    fn hmac_v2_matches_typescript_golden_vector() -> Result<(), InvalidLength> {
        let body = r#"{"query":"{ me { id } }"}"#;
        let query = "op=me";

        let body_hash = sha256_hex(body.as_bytes());
        let query_hash = sha256_hex(query.as_bytes());
        assert_eq!(
            body_hash,
            "64d4ae404c393f3916a308845f1df6e2ccd4243d889d3883f9b2dd7da9d31114"
        );
        assert_eq!(
            query_hash,
            "5226997613365afc8a0099fed5b3d0370cf1e2215b93f41e34a3b7a4b405c8a0"
        );

        let input = CanonicalV2Input {
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            service_name: "gateway-api".to_string(),
            method: "post".to_string(),
            path: "/graphql".to_string(),
            body_hash,
            tenant_id: "11111111-1111-4111-8111-111111111111".to_string(),
            key_id: "kid-1".to_string(),
            audience: "auth-service".to_string(),
            query_hash,
            content_type: "application/json".to_string(),
            effective_tenant_id: "11111111-1111-4111-8111-111111111111".to_string(),
            assertion_hash: String::new(),
            nonce: "nonce-fixed-1".to_string(),
        };

        let canonical = build_canonical_v2(&input);
        // 14 fields => exactly 13 newline delimiters.
        assert_eq!(canonical.matches('\n').count(), 13);
        assert!(
            canonical.starts_with("v2\n2026-01-01T00:00:00.000Z\ngateway-api\nPOST\n/graphql\n")
        );

        let sig = sign_v2(&canonical, b"test-shared-secret")?;
        assert_eq!(
            sig,
            "1f6e6d1423dcf8efa92e61bc96ad37e004134c0794c4bee5207440d80a783147"
        );
        Ok(())
    }

    #[test]
    fn method_is_upper_cased_in_canonical() {
        let mut input = golden_input();
        input.method = "patch".to_string();
        let canonical = build_canonical_v2(&input);
        assert!(canonical.contains("\nPATCH\n"));
    }

    fn golden_input() -> CanonicalV2Input {
        CanonicalV2Input {
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            service_name: "gateway-api".to_string(),
            method: "post".to_string(),
            path: "/graphql".to_string(),
            body_hash: sha256_hex(b"{}"),
            tenant_id: "t".to_string(),
            key_id: "kid-1".to_string(),
            audience: String::new(),
            query_hash: sha256_hex(b""),
            content_type: String::new(),
            effective_tenant_id: "t".to_string(),
            assertion_hash: String::new(),
            nonce: "n".to_string(),
        }
    }
}
