//! Bytecode deploy pipeline — Batch 166 Faz 3 (plan R-1).
//!
//! ## WHY
//!
//! The operator-facing `cmd_deploy_program` command receives
//! a wire-form `SignedBytecode`, must verify the ed25519
//! signature (Batch 158 — canonical encoding now binds
//! tenant_id + policy_version per Batch 165), then insert
//! the validated program into the registry (Batch 163).
//!
//! `verify_and_deploy` composes those three primitives into
//! one gate-ordered pipeline with structured error returns
//! so the command handler (future batch) is a thin
//! adapter: JSON-decode payload → `verify_and_deploy` →
//! MQTT response.
//!
//! ## Gate order
//!
//! 1. **Signature verify** (most expensive — closure-
//!    injected). Rejects tampered / forged artifacts
//!    first. Without this the tenant + registry gates
//!    would operate on attacker-controlled input.
//! 2. **Tenant match**. The caller supplies the expected
//!    tenant (from the agent's `AppState.tenant_id`); the
//!    signed bytecode's `tenant_id` field MUST equal it.
//!    Prevents a tenant-A-signed bytecode from being
//!    deployed into a tenant-B agent even if the key
//!    ceremony leaks a cross-tenant signing pair.
//! 3. **Registry insert**. The registry runs its own
//!    tenant + monotonic-version gates (Batch 163). Same
//!    tenant is enforced again at the registry boundary
//!    (defense in depth); monotonic version rejects
//!    replay.
//!
//! ## Audit surface
//!
//! On success the caller obtains a `DeployReport` with the
//! program_id + policy_version + tenant_id — suitable for
//! emitting a structured audit event.
//!
//! On failure the returned `DeployError` carries enough
//! context for the command handler to respond with a
//! operator-visible reason (without leaking cryptographic
//! material).
//!
//! ## What's not in Batch 166
//!
//! - The MQTT command handler itself — that's the next
//!   batch (cmd_deploy_program in `src/commands/`).
//! - Permission / RBAC gating — plan R-5 specifies the
//!   authz layer runs BEFORE deploy; the command handler
//!   consumes the authz manifest separately and calls
//!   `verify_and_deploy` only after permission passes.

#![allow(dead_code)]

use chrono::Utc;

use super::bytecode_registry::{
    BytecodeProgramRegistry, ProgramEntry, RegistryError,
};
use super::bytecode_sig::{
    verify_signed_bytecode, BytecodeVerifyError, SignedBytecode,
};

/// Success response from `verify_and_deploy`. The command
/// handler surfaces these fields in the MQTT response +
/// audit event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeployReport {
    pub program_id: String,
    pub tenant_id: Option<String>,
    pub policy_version: u64,
    /// Whether this deploy replaced an existing program
    /// (true) or inserted a new one (false). Useful for
    /// operator audit — a replace crosses the monotonic-
    /// version gate deliberately + should flag more
    /// loudly than a new insert.
    pub replaced_existing: bool,
}

/// Failure taxonomy. Each variant surfaces a specific
/// gate so audit + operator surfaces see the exact
/// cause.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeployError {
    /// ed25519 signature verification failed — tampered
    /// or forged artifact, or wrong key.
    SignatureInvalid,
    /// Canonical encoding of the bytecode body failed.
    /// Rare; indicates a malformed bytecode that slipped
    /// past serde parsing.
    CanonicalEncoding { what: &'static str },
    /// Signed bytecode's `tenant_id` does not match the
    /// agent's expected tenant. Cross-tenant deploy
    /// attempt.
    TenantMismatch {
        expected: Option<String>,
        got: Option<String>,
    },
    /// Registry-side gate failure (version / tenant /
    /// internal). Forwarded from `RegistryError` so the
    /// command handler can emit the same operator-visible
    /// message the registry would surface directly.
    Registry(RegistryError),
}

impl std::fmt::Display for DeployError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignatureInvalid => {
                write!(f, "deploy: bytecode signature verification failed")
            }
            Self::CanonicalEncoding { what } => {
                write!(f, "deploy: canonical encoding failed: {}", what)
            }
            Self::TenantMismatch { expected, got } => write!(
                f,
                "deploy: tenant mismatch (expected={:?}, got={:?})",
                expected, got
            ),
            Self::Registry(e) => write!(f, "deploy: registry: {}", e),
        }
    }
}

impl std::error::Error for DeployError {}

impl From<BytecodeVerifyError> for DeployError {
    fn from(e: BytecodeVerifyError) -> Self {
        match e {
            BytecodeVerifyError::CanonicalEncoding { what } => {
                Self::CanonicalEncoding { what }
            }
            BytecodeVerifyError::InvalidSignature => Self::SignatureInvalid,
        }
    }
}

impl From<RegistryError> for DeployError {
    fn from(e: RegistryError) -> Self {
        Self::Registry(e)
    }
}

/// Verify + deploy a signed bytecode into the registry.
///
/// Gate order (see module docs for rationale):
/// 1. ed25519 signature verify.
/// 2. Tenant match against the agent's expected tenant.
/// 3. Registry insert (monotonic version + tenant gates).
///
/// On success returns a `DeployReport`; any failure stage
/// is surfaced as a `DeployError`.
pub async fn verify_and_deploy(
    registry: &BytecodeProgramRegistry,
    signed: &SignedBytecode,
    expected_tenant: Option<&str>,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<DeployReport, DeployError> {
    // Gate 1 — ed25519 signature verify.
    let bytecode = verify_signed_bytecode(signed, verify_signature)?;

    // Gate 2 — tenant match.
    let expected_opt = expected_tenant.map(|s| s.to_string());
    if bytecode.tenant_id != expected_opt {
        return Err(DeployError::TenantMismatch {
            expected: expected_opt,
            got: bytecode.tenant_id.clone(),
        });
    }

    // Track whether this replaces an existing entry —
    // read BEFORE insert so the post-insert registry
    // state doesn't confuse the check.
    let replaced_existing = registry.get(&bytecode.program_id).await.is_some();

    // Gate 3 — registry insert (with its own gates).
    let entry = ProgramEntry {
        program_id: bytecode.program_id.clone(),
        tenant_id: bytecode.tenant_id.clone(),
        policy_version: bytecode.policy_version,
        enabled: true,
        deployed_at: Utc::now(),
        bytecode,
    };
    registry.insert(entry.clone()).await?;

    Ok(DeployReport {
        program_id: entry.program_id,
        tenant_id: entry.tenant_id,
        policy_version: entry.policy_version,
        replaced_existing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::bytecode::{Bytecode, Opcode, StValue};
    use super::super::bytecode_sig::canonical_bytes;
    use crate::authz::policy::Ed25519SignatureBytes;
    use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};

    fn key_a() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32])
    }

    fn key_b() -> SigningKey {
        SigningKey::from_bytes(&[2u8; 32])
    }

    fn mk_bc(
        program_id: &str,
        tenant: Option<&str>,
        version: u64,
    ) -> Bytecode {
        Bytecode {
            program_id: program_id.to_string(),
            program_name: format!("{}-name", program_id),
            tenant_id: tenant.map(|s| s.to_string()),
            policy_version: version,
            max_gas_per_tick: 1000,
            local_count: 0,
            retain_vars: vec![],
            allowed_write_tags: vec![],
            safe_state_pinned_tags: vec![],
            opcodes: vec![
                Opcode::PushConst { value: StValue::Real(0.0) },
                Opcode::Pop,
                Opcode::Return,
            ],
        }
    }

    fn sign(bc: &Bytecode, key: &SigningKey) -> SignedBytecode {
        let canonical = canonical_bytes(bc).expect("canonical ok");
        let sig = key.sign(&canonical);
        SignedBytecode {
            bytecode: bc.clone(),
            signature: Ed25519SignatureBytes::from_array(sig.to_bytes()),
        }
    }

    fn verify_with(
        key: VerifyingKey,
    ) -> impl FnOnce(&[u8], &[u8; 64]) -> bool {
        move |msg, sig_bytes| {
            let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
            key.verify(msg, &sig).is_ok()
        }
    }

    #[tokio::test]
    async fn verify_and_deploy_happy_path() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let bc = mk_bc("p1", Some("tenant-a"), 1);
        let signed = sign(&bc, &key);

        let report = verify_and_deploy(
            &reg,
            &signed,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("deploy ok");

        assert_eq!(report.program_id, "p1");
        assert_eq!(report.tenant_id, Some("tenant-a".to_string()));
        assert_eq!(report.policy_version, 1);
        assert!(!report.replaced_existing);

        // Registry actually has the entry.
        let got = reg.get("p1").await.expect("exists");
        assert_eq!(got.program_id, "p1");
        assert_eq!(got.policy_version, 1);
    }

    #[tokio::test]
    async fn verify_and_deploy_rejects_wrong_signature_key() {
        let reg = BytecodeProgramRegistry::new();
        let bc = mk_bc("p1", Some("tenant-a"), 1);
        let signed = sign(&bc, &key_a());

        let err = verify_and_deploy(
            &reg,
            &signed,
            Some("tenant-a"),
            verify_with(key_b().verifying_key()),
        )
        .await
        .expect_err("wrong key");
        assert_eq!(err, DeployError::SignatureInvalid);
    }

    #[tokio::test]
    async fn verify_and_deploy_rejects_cross_tenant_artifact() {
        // Bytecode signed with tenant-a; agent expects
        // tenant-b. Should reject at Gate 2.
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let bc = mk_bc("p1", Some("tenant-a"), 1);
        let signed = sign(&bc, &key);

        let err = verify_and_deploy(
            &reg,
            &signed,
            Some("tenant-b"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("cross-tenant");
        match err {
            DeployError::TenantMismatch { expected, got } => {
                assert_eq!(expected, Some("tenant-b".to_string()));
                assert_eq!(got, Some("tenant-a".to_string()));
            }
            other => panic!("expected TenantMismatch, got {:?}", other),
        }
        // Registry must NOT have the entry.
        assert!(reg.get("p1").await.is_none());
    }

    #[tokio::test]
    async fn verify_and_deploy_accepts_platform_scoped_none_tenant() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let bc = mk_bc("factory_default_alarm", None, 1);
        let signed = sign(&bc, &key);

        verify_and_deploy(&reg, &signed, None, verify_with(key.verifying_key()))
            .await
            .expect("platform-scoped ok");
    }

    #[tokio::test]
    async fn verify_and_deploy_replaces_existing_on_higher_version() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        // v1 initial deploy.
        let signed_v1 = sign(&mk_bc("p1", Some("tenant-a"), 1), &key);
        verify_and_deploy(
            &reg,
            &signed_v1,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("v1 deploy ok");

        // v2 replace.
        let signed_v2 = sign(&mk_bc("p1", Some("tenant-a"), 2), &key);
        let report = verify_and_deploy(
            &reg,
            &signed_v2,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("v2 deploy ok");
        assert!(report.replaced_existing);
        assert_eq!(report.policy_version, 2);
        assert_eq!(
            reg.get("p1").await.expect("exists").policy_version,
            2
        );
    }

    #[tokio::test]
    async fn verify_and_deploy_rejects_version_rollback() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let signed_v5 = sign(&mk_bc("p1", Some("tenant-a"), 5), &key);
        verify_and_deploy(
            &reg,
            &signed_v5,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("v5 ok");

        let signed_v3 = sign(&mk_bc("p1", Some("tenant-a"), 3), &key);
        let err = verify_and_deploy(
            &reg,
            &signed_v3,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("rollback");
        assert!(matches!(
            err,
            DeployError::Registry(RegistryError::PolicyVersionNotMonotonic { .. })
        ));
        // Original v5 still in place.
        assert_eq!(
            reg.get("p1").await.expect("exists").policy_version,
            5
        );
    }

    #[tokio::test]
    async fn verify_and_deploy_tampered_bytecode_fails_signature_first() {
        // Tamper with the bytecode AFTER signing — the
        // signature gate must fire BEFORE the tenant
        // gate, so error is SignatureInvalid not
        // TenantMismatch.
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let bc = mk_bc("p1", Some("tenant-a"), 1);
        let mut signed = sign(&bc, &key);
        signed.bytecode.tenant_id = Some("tenant-b".into());

        let err = verify_and_deploy(
            &reg,
            &signed,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("tampered");
        assert_eq!(err, DeployError::SignatureInvalid);
    }

    #[tokio::test]
    async fn verify_and_deploy_sets_enabled_true_by_default() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let signed = sign(&mk_bc("p1", Some("tenant-a"), 1), &key);
        verify_and_deploy(
            &reg,
            &signed,
            Some("tenant-a"),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("ok");
        assert!(reg.get("p1").await.expect("exists").enabled);
    }
}
