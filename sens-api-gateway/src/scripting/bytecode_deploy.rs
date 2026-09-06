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

// Batch #259 wire-audit: D-1 ultra-plan compile/registry
// path is partially orphan (Batch 149-167 primitives wired
// for runtime + scan-cycle, but several stdlib/compile/
// debug helpers wait on the D-1 production wire). Blanket
// allow retained + tracked as ULTRA-HIGH-024; remove
// per-item as the D-1 batch consumes each helper.
#![allow(dead_code)]

use chrono::Utc;

use super::bytecode_registry::{BytecodeProgramRegistry, ProgramEntry, RegistryError};
use super::bytecode_sig::{BytecodeVerifyError, SignedBytecode, verify_signed_bytecode};

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
    /// **Batch #298 ORPHAN-HIGH-020 closure variant.** ST
    /// source signature verification failed — only
    /// reachable via `compile_and_deploy_signed_source`
    /// (the parallel SignedBytecode path uses
    /// SignatureInvalid above). Distinct variant so audit
    /// records can discriminate which signature kind
    /// failed (source-side vs bytecode-side).
    StSourceSignatureInvalid,
    /// **Batch #298 closure variant.** ST source canonical
    /// encoding failed (e.g., source longer than u32::MAX
    /// bytes). Defense-in-depth; a well-formed wire payload
    /// should never produce this.
    StSourceCanonicalEncoding { what: &'static str },
    /// **Batch #298 closure variant.** ST source parsing
    /// (`parse_st`) reported syntax / lexical errors. Carries
    /// the full set of error messages for operator audit;
    /// does NOT carry source excerpts (avoid leaking
    /// proprietary operator code into audit log).
    StSourceParseFailed {
        /// Number of distinct parse errors reported.
        error_count: usize,
        /// First error's diagnostic message — full set is
        /// available via the parse_st return value at the
        /// caller, but the audit-visible variant carries
        /// just the headline so logs stay bounded.
        first_error: String,
    },
    /// **Batch #298 closure variant.** AST→bytecode compile
    /// reported an error (Unsupported variant / unresolved
    /// symbol / etc.). The compiler's `CompileError`
    /// Display gives a structured operator-facing message;
    /// we Forward it as a String so `bytecode_deploy.rs`
    /// doesn't take a transitive dep on `bytecode_compiler::
    /// CompileError` enum shape (which can grow without
    /// touching this taxonomy).
    StSourceCompileFailed { reason: String },
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
            Self::StSourceSignatureInvalid => {
                write!(f, "deploy: ST source signature verification failed")
            }
            Self::StSourceCanonicalEncoding { what } => {
                write!(f, "deploy: ST source canonical encoding failed: {}", what)
            }
            Self::StSourceParseFailed {
                error_count,
                first_error,
            } => write!(
                f,
                "deploy: ST source parse failed ({} error(s); first: {})",
                error_count, first_error
            ),
            Self::StSourceCompileFailed { reason } => {
                write!(f, "deploy: ST source compile failed: {}", reason)
            }
        }
    }
}

impl std::error::Error for DeployError {}

impl From<BytecodeVerifyError> for DeployError {
    fn from(e: BytecodeVerifyError) -> Self {
        match e {
            BytecodeVerifyError::CanonicalEncoding { what } => Self::CanonicalEncoding { what },
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
        bytecode: std::sync::Arc::new(bytecode),
    };
    registry.insert(entry.clone()).await?;

    Ok(DeployReport {
        program_id: entry.program_id,
        tenant_id: entry.tenant_id,
        policy_version: entry.policy_version,
        replaced_existing,
    })
}

// ============================================================
// Batch #298 ORPHAN-HIGH-020 closure — source-compile adapter
// ============================================================
//
// ## Why this adapter exists
//
// Pre-Batch-#298 the only deploy entry point was
// `verify_and_deploy(SignedBytecode)` — operators had to
// run the AST→bytecode compile pipeline cloud-side and ship
// the pre-compiled binary. The orphan finding ORPHAN-HIGH-020
// named that as a violation of plan §3 R-1's "edge compiles
// ST in-place" promise.
//
// `compile_and_deploy_signed_source` is the parallel entry
// point: operators ship raw `.st` source text in a
// `SignedStSource` envelope (Batch #297 primitive), the
// edge verifies the source signature, runs `parse_st` +
// `compile_program` internally, and inserts the compiled
// Bytecode directly into the registry.
//
// ## Trust model
//
// Source-signature trust transfer (per Batch #297 docstring):
// the operator's private key signs the SOURCE BYTES (not the
// compiled bytecode). The edge verifies the source signature
// using the SAME firmware_signing_pubkey it uses for
// SignedBytecode verify; cross-format confusion is structurally
// impossible because the canonical-bytes domain tags differ
// (`st-source-v1` vs `st-bytecode-v3`).
//
// ## Gate order
//
// 1. **ST source signature verify** (closure-injected — same
//    closure type as `verify_and_deploy` so the keystore
//    layer plugs the same active public key).
// 2. **Tenant match** against the agent's expected tenant —
//    same gate as `verify_and_deploy`.
// 3. **parse_st** the source text → AST. Lex/parse errors
//    surface as `StSourceParseFailed { error_count,
//    first_error }`.
// 4. **compile_program** the AST → Bytecode with the caller-
//    supplied tag descriptors + gas budget. CompileError
//    surfaces as `StSourceCompileFailed { reason }`.
// 5. **Tag the Bytecode** with the SignedStSource body's
//    tenant_id + policy_version (pre-compile bytecode has
//    tenant_id=None / policy_version=0; the body's claims
//    flow through to the registry-side gates).
// 6. **Registry insert** — same gate as `verify_and_deploy`
//    (monotonic version + tenant + internal). Returns
//    DeployReport on success, structured DeployError on any
//    gate failure.
//
// ## Why parse + compile happen INSIDE this adapter
//
// The alternative would be: caller runs parse_st + compile_program
// + signs the resulting Bytecode + calls verify_and_deploy. But
// the caller is a thin MQTT command handler; pulling parse +
// compile up to the handler would (a) duplicate the gate-order
// discipline, (b) require the handler to discriminate
// CompileError variants, (c) re-introduce the "edge signs
// bytecode" antipattern this batch architecturally rejects.
// Centralizing the orchestration here keeps the handler thin
// + makes the gate order auditable in one place.

/// Verify + parse + compile + deploy a signed ST source into
/// the registry. Parallel entry point to `verify_and_deploy`
/// for operators shipping raw source instead of pre-compiled
/// bytecode.
///
/// Gate order documented in the section header above. On
/// success returns a `DeployReport`; any failure surfaces as a
/// `DeployError` variant with operator-visible context.
///
/// **Tag descriptors** — required by `compile_program` to
/// resolve tag references in the source. Caller supplies the
/// list from the agent's tag catalog (the boot-time io_poll
/// config); typically threaded down from AppState by the MQTT
/// command handler.
pub async fn compile_and_deploy_signed_source(
    registry: &BytecodeProgramRegistry,
    signed: &super::st_source_sig::SignedStSource,
    expected_tenant: Option<&str>,
    tags: &[super::bytecode_compiler::TagDescriptor],
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<DeployReport, DeployError> {
    use super::st_source_sig::{StSourceVerifyError, verify_signed_st_source};

    // Gate 1 — ST source signature verify.
    let body = match verify_signed_st_source(signed, verify_signature) {
        Ok(b) => b,
        Err(StSourceVerifyError::InvalidSignature) => {
            return Err(DeployError::StSourceSignatureInvalid);
        }
        Err(StSourceVerifyError::CanonicalEncoding { what }) => {
            return Err(DeployError::StSourceCanonicalEncoding { what });
        }
    };

    // Gate 2 — tenant match. Performed BEFORE parse + compile
    // so a wrong-tenant deploy costs zero parse/compile cycles.
    let expected_opt = expected_tenant.map(|s| s.to_string());
    if body.tenant_id != expected_opt {
        return Err(DeployError::TenantMismatch {
            expected: expected_opt,
            got: body.tenant_id.clone(),
        });
    }

    // Gate 3 — parse_st (ST source → AST). Lex/parse errors
    // bubble up with the count + first message; full set is
    // dropped here to keep audit log entries bounded (the
    // operator UI surfaces the full set client-side from its
    // own pre-flight parse).
    let program = match crate::st_validator::parse_st(&body.source) {
        Ok(p) => p,
        Err(errors) => {
            let error_count = errors.len();
            let first_error = errors
                .first()
                .map(|e| format!("{:?}", e))
                .unwrap_or_else(|| "<no error reported>".to_string());
            return Err(DeployError::StSourceParseFailed {
                error_count,
                first_error,
            });
        }
    };

    // Gate 4 — compile_program (AST → Bytecode). CompileError
    // Display gives the operator-facing reason; we Forward it
    // as a String to keep `DeployError` decoupled from the
    // compiler's internal enum shape.
    let mut bytecode = match super::bytecode_compiler::compile_program(
        &program,
        tags,
        body.program_id.clone(),
        body.max_gas_per_tick,
    ) {
        Ok(bc) => bc,
        Err(e) => {
            return Err(DeployError::StSourceCompileFailed {
                reason: format!("{:?}", e),
            });
        }
    };

    // Gate 5 — tag the Bytecode with the body's tenant_id +
    // policy_version. compile_program produces a Bytecode
    // with tenant_id=None / policy_version=0; the SignedStSource
    // body's signed claims flow through to the registry gate.
    bytecode.tenant_id = body.tenant_id.clone();
    bytecode.policy_version = body.policy_version;

    // Track replace-vs-new for the audit report.
    let replaced_existing = registry.get(&bytecode.program_id).await.is_some();

    // Gate 6 — registry insert (with its own gates: monotonic
    // version + tenant + internal). Same shape as
    // `verify_and_deploy`'s final gate.
    let entry = ProgramEntry {
        program_id: bytecode.program_id.clone(),
        tenant_id: bytecode.tenant_id.clone(),
        policy_version: bytecode.policy_version,
        enabled: true,
        deployed_at: Utc::now(),
        bytecode: std::sync::Arc::new(bytecode),
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
    use super::super::bytecode::{Bytecode, Opcode, StValue};
    use super::super::bytecode_sig::canonical_bytes;
    use super::*;
    use crate::authz::policy::Ed25519SignatureBytes;
    use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};

    fn key_a() -> SigningKey {
        SigningKey::from_bytes(&[1u8; 32])
    }

    fn key_b() -> SigningKey {
        SigningKey::from_bytes(&[2u8; 32])
    }

    fn mk_bc(program_id: &str, tenant: Option<&str>, version: u64) -> Bytecode {
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
                Opcode::PushConst {
                    value: StValue::Real(0.0),
                },
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

    fn verify_with(key: VerifyingKey) -> impl FnOnce(&[u8], &[u8; 64]) -> bool {
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
        assert_eq!(reg.get("p1").await.expect("exists").policy_version, 2);
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
        assert_eq!(reg.get("p1").await.expect("exists").policy_version, 5);
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

    // =========================================================
    // Batch #298 ORPHAN-HIGH-020 closure tests —
    // compile_and_deploy_signed_source adapter
    // =========================================================
    //
    // These tests pin the source-compile deploy path's gate
    // ordering + each gate's reject behavior. The minimal happy-
    // path source is a syntactically valid IEC 61131-3 PROGRAM
    // with one VAR block and an empty body (compile_program
    // accepts this — the resulting Bytecode is opcodes=[Return]).
    //
    // Tag descriptors are empty since the minimal source declares
    // no tags; tag-aware tests live in bytecode_compiler's own
    // unit tests.

    use super::super::st_source_sig::{
        SignedStSource, StSourceBody, canonical_bytes as src_canonical_bytes,
    };

    fn mk_st_body(
        program_id: &str,
        tenant: Option<&str>,
        version: u64,
        source: &str,
    ) -> StSourceBody {
        StSourceBody {
            program_id: program_id.to_string(),
            tenant_id: tenant.map(|s| s.to_string()),
            policy_version: version,
            max_gas_per_tick: 1000,
            source: source.to_string(),
        }
    }

    fn sign_source(body: &StSourceBody, key: &SigningKey) -> SignedStSource {
        let canonical = src_canonical_bytes(body).expect("canonical ok");
        let sig = key.sign(&canonical);
        SignedStSource {
            body: body.clone(),
            signature: Ed25519SignatureBytes::from_array(sig.to_bytes()),
        }
    }

    /// Minimal syntactically-valid ST program. compile_program
    /// accepts an empty PROGRAM body — the resulting Bytecode
    /// is just [Return].
    const MINIMAL_VALID_SOURCE: &str = "PROGRAM Empty\nVAR\n  x : INT;\nEND_VAR\nEND_PROGRAM\n";

    #[tokio::test]
    async fn compile_and_deploy_happy_path_inserts_into_registry() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let signed = sign_source(
            &mk_st_body("p-src-1", Some("tenant-a"), 1, MINIMAL_VALID_SOURCE),
            &key,
        );
        let report = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-a"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect("happy path");
        assert_eq!(report.program_id, "p-src-1");
        assert_eq!(report.tenant_id.as_deref(), Some("tenant-a"));
        assert_eq!(report.policy_version, 1);
        assert!(!report.replaced_existing);
        // Registry now carries the compiled Bytecode.
        let entry = reg.get("p-src-1").await.expect("entry");
        assert_eq!(entry.tenant_id.as_deref(), Some("tenant-a"));
        assert_eq!(entry.policy_version, 1);
        assert!(entry.enabled);
    }

    #[tokio::test]
    async fn compile_and_deploy_rejects_wrong_signing_key() {
        let reg = BytecodeProgramRegistry::new();
        let body = mk_st_body("p-src-2", Some("tenant-a"), 1, MINIMAL_VALID_SOURCE);
        // Sign with key_a but verify with key_b's pubkey.
        let signed = sign_source(&body, &key_a());
        let err = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-a"),
            &[],
            verify_with(key_b().verifying_key()),
        )
        .await
        .expect_err("wrong key");
        assert_eq!(err, DeployError::StSourceSignatureInvalid);
    }

    #[tokio::test]
    async fn compile_and_deploy_rejects_tampered_source() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        // Sign source A.
        let body_a = mk_st_body("p-src-3", Some("tenant-a"), 1, MINIMAL_VALID_SOURCE);
        let mut signed = sign_source(&body_a, &key);
        // Mutate the source post-sign — tampered envelope.
        signed.body.source =
            "PROGRAM Tampered\nVAR\n  y : REAL;\nEND_VAR\nEND_PROGRAM\n".to_string();
        let err = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-a"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("tampered");
        assert_eq!(err, DeployError::StSourceSignatureInvalid);
    }

    #[tokio::test]
    async fn compile_and_deploy_rejects_wrong_tenant() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let signed = sign_source(
            &mk_st_body("p-src-4", Some("tenant-A"), 1, MINIMAL_VALID_SOURCE),
            &key,
        );
        let err = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-B"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("wrong tenant");
        match err {
            DeployError::TenantMismatch { expected, got } => {
                assert_eq!(expected.as_deref(), Some("tenant-B"));
                assert_eq!(got.as_deref(), Some("tenant-A"));
            }
            other => panic!("expected TenantMismatch, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn compile_and_deploy_surfaces_parse_failure() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        // Syntactically invalid ST — no PROGRAM keyword.
        let bad_source = "this is not valid ST source code at all 12345 @@";
        let signed = sign_source(
            &mk_st_body("p-src-5", Some("tenant-a"), 1, bad_source),
            &key,
        );
        let err = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-a"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("parse fail");
        match err {
            DeployError::StSourceParseFailed {
                error_count,
                first_error: _,
            } => {
                assert!(error_count >= 1, "expected >=1 parse error");
            }
            other => panic!("expected StSourceParseFailed, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn compile_and_deploy_replaces_existing_with_higher_version() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        // Deploy v1.
        let v1 = sign_source(
            &mk_st_body("p-src-6", Some("tenant-a"), 1, MINIMAL_VALID_SOURCE),
            &key,
        );
        compile_and_deploy_signed_source(
            &reg,
            &v1,
            Some("tenant-a"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect("v1 deploy");

        // Deploy v2 — same program_id, higher policy_version.
        let v2 = sign_source(
            &mk_st_body("p-src-6", Some("tenant-a"), 2, MINIMAL_VALID_SOURCE),
            &key,
        );
        let report = compile_and_deploy_signed_source(
            &reg,
            &v2,
            Some("tenant-a"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect("v2 deploy");
        assert!(report.replaced_existing);
        assert_eq!(report.policy_version, 2);
        assert_eq!(reg.get("p-src-6").await.expect("entry").policy_version, 2);
    }

    /// **Cross-format confusion mitigation pin.** A
    /// SignedBytecode signed with key_a CANNOT be used as a
    /// SignedStSource because the wire types are structurally
    /// different (different magic, different domain tag) — the
    /// type system precludes the cross-format swap. This test
    /// proves the type-level discipline is in place by
    /// asserting the two signed envelopes produce DIFFERENT
    /// canonical bytes for equivalent program identity claims.
    #[tokio::test]
    async fn signed_bytecode_canonical_distinct_from_signed_st_source() {
        let bc = mk_bc("p-cross", Some("tenant-a"), 1);
        let bc_canonical = canonical_bytes(&bc).expect("bc canonical");

        let body = mk_st_body("p-cross", Some("tenant-a"), 1, MINIMAL_VALID_SOURCE);
        let src_canonical = src_canonical_bytes(&body).expect("src canonical");

        // Different magic + different domain tag means even a
        // SHA-256 collision on the bodies cannot pivot one
        // signature into a valid one for the other format.
        assert_ne!(bc_canonical, src_canonical);
        assert_eq!(&bc_canonical[0..4], b"STBC");
        assert_eq!(&src_canonical[0..4], b"SSRC");
    }

    // =========================================================
    // Batch #300 ORPHAN-HIGH-020 closure FINAL —
    // d1_source_compile_roundtrip integration roundtrip
    // =========================================================
    //
    // ## Architectural intent
    //
    // The orphan finding's deliverable list specified
    // `tests/integration/d1_source_compile_roundtrip.rs`. That
    // path is a contract-marker test (the bin is `[[bin]]`,
    // not `[lib]`, so external test crates can't import
    // internal types — the project's pattern is to have
    // tests/invariants/*.rs files document the architectural
    // contract via prose-level assertions, while the real
    // executable tests live in `#[cfg(test)] mod` inside the
    // bin source files).
    //
    // This test is the EXECUTABLE D-1 roundtrip. It exercises:
    //
    //   1. Real ed25519 SigningKey (not closure mock).
    //   2. A NON-TRIVIAL ST source — VAR block + assignment +
    //      tag-write — that produces meaningful opcodes.
    //   3. Tag descriptor catalog with one writable + one
    //      read-only tag, so the compile gate's
    //      target_kind discipline runs (write to a read-only
    //      tag would CompileError).
    //   4. Real verify_signed_st_source via real ed25519
    //      verify in the closure.
    //   5. Real parse_st on the meaningful source.
    //   6. Real compile_program with the tag descriptors.
    //   7. Tagging Bytecode with body claims (tenant_id +
    //      policy_version).
    //   8. Real registry insert.
    //   9. Post-deploy assertions:
    //      - registry contains the entry
    //      - bytecode.opcodes is NOT just [Return] (proves
    //        the source semantically compiled to instructions)
    //      - bytecode.allowed_write_tags contains the tag
    //        the source actually wrote to (proves the
    //        WriteTag opcode allowlist derivation worked
    //        end-to-end)
    //      - bytecode.tenant_id matches the body's claim
    //      - bytecode.policy_version matches the body's claim
    //
    // ## Why this single test covers the D-1 contract
    //
    // The 6 prior gate-coverage tests (compile_and_deploy_*)
    // already pin each individual gate. This test is the
    // CROSS-GATE SEMANTIC roundtrip — it proves the full
    // sign→verify→parse→compile→deploy→inspect chain works on
    // a meaningful program, NOT just on the minimal
    // syntactically-valid PROGRAM body the gate-coverage tests
    // used. A regression that breaks parse-AST→opcodes
    // semantic translation would NOT be caught by the prior
    // tests (they use empty bodies → only [Return] opcode);
    // this test catches it.

    /// Non-trivial ST source. Exercises:
    ///   - VAR block with INT + REAL declarations
    ///   - Assignment to a local variable
    ///   - Tag write (the operator's actuator command — the
    ///     entire point of the deploy pipeline)
    ///
    /// Tag references resolved against the test's
    /// TagDescriptor catalog: `setpoint` (REAL, writable) +
    /// `sensor_temp` (REAL, read-only).
    const ROUNDTRIP_SOURCE: &str = "PROGRAM Roundtrip\n\
        VAR\n\
          x : REAL;\n\
        END_VAR\n\
        x := 42.5;\n\
        setpoint := x;\n\
        END_PROGRAM\n";

    fn roundtrip_tags() -> Vec<super::super::bytecode_compiler::TagDescriptor> {
        use super::super::bytecode::StValueType;
        use super::super::bytecode_compiler::TagDescriptor;
        vec![
            TagDescriptor {
                name: "setpoint".to_string(),
                data_type: StValueType::Real,
                writable: true,
            },
            TagDescriptor {
                name: "sensor_temp".to_string(),
                data_type: StValueType::Real,
                writable: false,
            },
        ]
    }

    #[tokio::test]
    async fn d1_source_compile_roundtrip_meaningful_program() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let body = mk_st_body("p-roundtrip", Some("tenant-prod"), 5, ROUNDTRIP_SOURCE);
        let signed = sign_source(&body, &key);

        // End-to-end deploy.
        let report = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-prod"),
            &roundtrip_tags(),
            verify_with(key.verifying_key()),
        )
        .await
        .expect("happy roundtrip");

        // Report-level assertions.
        assert_eq!(report.program_id, "p-roundtrip");
        assert_eq!(report.tenant_id.as_deref(), Some("tenant-prod"));
        assert_eq!(report.policy_version, 5);
        assert!(!report.replaced_existing);

        // Inspect the registry entry — the ARCHITECTURAL
        // proof that semantic compilation happened (not just
        // syntax-pass + empty body).
        let entry = reg.get("p-roundtrip").await.expect("registry entry");

        // Body claims flowed through to the compiled bytecode.
        assert_eq!(entry.bytecode.tenant_id.as_deref(), Some("tenant-prod"));
        assert_eq!(entry.bytecode.policy_version, 5);

        // Bytecode is NOT just [Return]. Empty PROGRAM bodies
        // produce a single Return opcode; this source has a
        // local assignment + a tag write so the opcode count
        // MUST exceed 1.
        assert!(
            entry.bytecode.opcodes.len() > 1,
            "expected non-trivial opcode list (proves semantic compile); got {} opcodes",
            entry.bytecode.opcodes.len()
        );

        // Allowed write tags MUST include `setpoint` (the
        // tag the source actually writes to). This proves
        // the WriteTag opcode allowlist derivation worked
        // end-to-end — compile_program collects every
        // Opcode::WriteTag.name into allowed_write_tags + the
        // VM gate at scan-cycle time uses this list as the
        // SSoT for write authorization.
        assert!(
            entry
                .bytecode
                .allowed_write_tags
                .contains(&"setpoint".to_string()),
            "expected `setpoint` in allowed_write_tags; got {:?}",
            entry.bytecode.allowed_write_tags
        );

        // sensor_temp is read-only in the catalog AND the
        // source never writes to it; allowed_write_tags MUST
        // NOT contain it.
        assert!(
            !entry
                .bytecode
                .allowed_write_tags
                .contains(&"sensor_temp".to_string()),
            "sensor_temp MUST NOT be in allowed_write_tags (source never writes it; catalog marks it read-only)",
        );

        // Local count must be at least 1 (`x` declared in VAR).
        assert!(
            entry.bytecode.local_count >= 1,
            "expected >=1 local from VAR block; got {}",
            entry.bytecode.local_count
        );

        // max_gas_per_tick from the body claim flowed through.
        assert_eq!(entry.bytecode.max_gas_per_tick, 1000);

        // Default-enabled at registry insert (matches the
        // SignedBytecode path's enabled-true default).
        assert!(entry.enabled);
    }

    /// **Cross-gate negative roundtrip.** Same source as the
    /// happy path, but the tag catalog OMITS `setpoint` — the
    /// compile gate's tag-resolution step MUST surface a
    /// CompileError (StSourceCompileFailed) because the source
    /// references an unresolved tag.
    ///
    /// This proves the tag descriptor catalog is actually
    /// consumed by compile_program — a regression that
    /// silently ignored unresolved tags would deploy a broken
    /// program; this test catches that class of regression.
    #[tokio::test]
    async fn d1_source_compile_roundtrip_rejects_unresolved_tag() {
        let reg = BytecodeProgramRegistry::new();
        let key = key_a();
        let body = mk_st_body("p-bad-tag", Some("tenant-prod"), 1, ROUNDTRIP_SOURCE);
        let signed = sign_source(&body, &key);

        // Empty tag catalog — `setpoint` is unresolved.
        let err = compile_and_deploy_signed_source(
            &reg,
            &signed,
            Some("tenant-prod"),
            &[],
            verify_with(key.verifying_key()),
        )
        .await
        .expect_err("must fail on unresolved tag");

        match err {
            DeployError::StSourceCompileFailed { reason: _ } => {}
            other => panic!(
                "expected StSourceCompileFailed for unresolved tag, got {:?}",
                other
            ),
        }

        // Registry untouched — failed deploy MUST NOT leave a
        // partial entry behind.
        assert!(reg.get("p-bad-tag").await.is_none());
    }
}
