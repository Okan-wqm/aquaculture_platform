//! D-3 SQLCipher consumer-context resolver
//! (PR-195 Batch #7 — ADR-031 stability-contract bridge).
//!
//! ## Why this module exists
//!
//! ADR-031 enumerates 4 SqlCipher consumers and pins
//! the CONTEXT-BYTES contract per consumer:
//!
//!   | KeyPurpose                  | Context bytes                                |
//!   |-----------------------------|----------------------------------------------|
//!   | SqlCipherOfflineQueue       | deployment-instance UUID                     |
//!   | SqlCipherLicenseCache       | deployment-instance UUID                     |
//!   | SqlCipherRetainPersistence  | program-artifact SHA-256                     |
//!   | SqlCipherBytecodeRetain     | program-artifact SHA-256                     |
//!
//! Both the future CLI execution path (PR-195 Batch
//! #8+) AND each per-consumer constructor (subsequent
//! batches) need to compute the SAME bytes for the
//! SAME consumer. Without an SSoT resolver, each
//! consumer's constructor would inline-pick its
//! context, drift between callsites would happen
//! silently, and the CLI's rekey-tool would compute
//! a v2 key that doesn't match what the consumer
//! itself derives at boot — producing a DB the
//! consumer can't open.
//!
//! Architectural fix: a single `context_bytes_for_purpose`
//! resolver function. Caller passes a `ConsumerContext`
//! struct carrying the inputs (deployment UUID +
//! program-artifact SHA-256 if applicable); the
//! resolver picks the right slice per ADR-031
//! taxonomy.
//!
//! ## What this module does NOT own
//!
//! - **Source of the inputs.** Deployment UUID lives
//!   in `provisioning::deployment_instance_uuid()`;
//!   program-artifact SHA-256 lives in the bytecode
//!   artifact loader. The resolver takes them as
//!   pre-computed bytes; callers are responsible for
//!   reading them from the agent's runtime sources.
//! - **Validation of input shape.** The resolver
//!   trusts that `deployment_uuid` is the canonical
//!   16-byte UUID per `provisioning` and
//!   `program_artifact_sha256` is a 32-byte digest.
//!   Mis-shaped inputs would produce a wrong key but
//!   not a panic; that's the caller's responsibility.
//!   The architectural property pinned here is the
//!   PURPOSE → INPUT-SLOT mapping, not the input-shape.
//!
//! ## Wrong-purpose handling
//!
//! Calling the resolver with a non-SqlCipher* purpose
//! (e.g., `KeyPurpose::AuditHmacChain`) returns
//! `ConsumerContextError::WrongPurpose`. Same shape as
//! the v2 shim's `WrongPurpose` guard (Batch #332): the
//! migration boundary fails closed if a refactor
//! accidentally routes a non-SqlCipher purpose through
//! the migration path.

use crate::keystore::purpose::KeyPurpose;

/// Pre-computed context inputs available to the
/// resolver. Caller populates the fields that apply to
/// the consumer being resolved; fields not needed for
/// a given consumer can be left empty/None.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsumerContext {
    /// Canonical deployment-instance UUID bytes per
    /// `provisioning::deployment_instance_uuid()`. Used
    /// by `SqlCipherOfflineQueue` + `SqlCipherLicenseCache`.
    pub deployment_uuid: Vec<u8>,
    /// SHA-256 digest of the currently-deployed program
    /// artifact. Used by `SqlCipherRetainPersistence` +
    /// `SqlCipherBytecodeRetain`. `None` is acceptable
    /// for callers resolving only consumers that don't
    /// need it; resolving a program-bound purpose with
    /// `None` returns `ProgramSha256Required`.
    pub program_artifact_sha256: Option<Vec<u8>>,
}

/// Errors returned by `context_bytes_for_purpose`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConsumerContextError {
    /// Caller passed a `KeyPurpose` that is NOT a
    /// SqlCipher* variant. Same architectural fail-
    /// closed shape as the v2 shim's `WrongPurpose`
    /// guard (Batch #332).
    WrongPurpose { got: KeyPurpose },
    /// Resolver was asked for a program-bound consumer
    /// (`SqlCipherRetainPersistence` /
    /// `SqlCipherBytecodeRetain`) but the
    /// `ConsumerContext.program_artifact_sha256` field
    /// is `None`. Caller must populate the field
    /// before resolving program-bound consumers.
    ProgramSha256Required { purpose: KeyPurpose },
    /// Deployment UUID was empty when required for
    /// device-bound consumers (`SqlCipherOfflineQueue`
    /// / `SqlCipherLicenseCache`). Caller must
    /// populate from `provisioning::deployment_instance_uuid()`.
    DeploymentUuidRequired { purpose: KeyPurpose },
}

impl std::fmt::Display for ConsumerContextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPurpose { got } => write!(
                f,
                "consumer_context_wrong_purpose: not a SqlCipher* variant (got {got:?})"
            ),
            Self::ProgramSha256Required { purpose } => write!(
                f,
                "consumer_context_program_sha256_required: {purpose:?} is program-bound but program_artifact_sha256 is None"
            ),
            Self::DeploymentUuidRequired { purpose } => write!(
                f,
                "consumer_context_deployment_uuid_required: {purpose:?} is device-bound but deployment_uuid is empty"
            ),
        }
    }
}

impl std::error::Error for ConsumerContextError {}

/// Resolve the context bytes for the given SqlCipher
/// consumer purpose per the ADR-031 stability
/// contract. Returns a slice borrowed from the input
/// `ConsumerContext` (no allocation; lifetime tied to
/// the caller's context struct).
///
/// **Caller contract:**
/// - `purpose` MUST be a SqlCipher* variant. Non-
///   SqlCipher purposes return `WrongPurpose` —
///   architectural fail-closed at the migration
///   boundary.
/// - `ctx` MUST carry the input slot the consumer
///   needs: deployment UUID for device-bound
///   consumers, program SHA-256 for program-bound
///   consumers. Missing slots return a precise
///   error class so the caller can populate from
///   the right source.
///
/// **Returns:** `Ok(&[u8])` borrowed from `ctx` (no
/// allocation), or a structured error per the missing-
/// input class.
pub fn context_bytes_for_purpose<'a>(
    purpose: KeyPurpose,
    ctx: &'a ConsumerContext,
) -> Result<&'a [u8], ConsumerContextError> {
    match purpose {
        KeyPurpose::SqlCipherOfflineQueue
        | KeyPurpose::SqlCipherLicenseCache
        | KeyPurpose::SqlCipherScadaDisplay => {
            // Device-bound — deployment UUID required.
            if ctx.deployment_uuid.is_empty() {
                return Err(ConsumerContextError::DeploymentUuidRequired { purpose });
            }
            Ok(&ctx.deployment_uuid)
        }
        KeyPurpose::SqlCipherRetainPersistence | KeyPurpose::SqlCipherBytecodeRetain => {
            // Program-bound — program SHA-256 required.
            match &ctx.program_artifact_sha256 {
                Some(sha) if !sha.is_empty() => Ok(sha.as_slice()),
                _ => Err(ConsumerContextError::ProgramSha256Required { purpose }),
            }
        }
        // All non-SqlCipher* variants → fail-closed.
        KeyPurpose::AuditHmacChain
        | KeyPurpose::ReplayCache
        | KeyPurpose::DekEscrow
        | KeyPurpose::ConfigVerify => Err(ConsumerContextError::WrongPurpose { got: purpose }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with_both() -> ConsumerContext {
        ConsumerContext {
            deployment_uuid: b"deployment-uuid-16b".to_vec(),
            program_artifact_sha256: Some(vec![0xAA; 32]),
        }
    }

    #[test]
    fn offline_queue_resolves_to_deployment_uuid() {
        let ctx = ctx_with_both();
        let bytes = context_bytes_for_purpose(KeyPurpose::SqlCipherOfflineQueue, &ctx).expect("ok");
        assert_eq!(bytes, b"deployment-uuid-16b");
    }

    #[test]
    fn license_cache_resolves_to_deployment_uuid() {
        let ctx = ctx_with_both();
        let bytes = context_bytes_for_purpose(KeyPurpose::SqlCipherLicenseCache, &ctx).expect("ok");
        assert_eq!(bytes, b"deployment-uuid-16b");
    }

    #[test]
    fn retain_persistence_resolves_to_program_sha256() {
        let ctx = ctx_with_both();
        let bytes =
            context_bytes_for_purpose(KeyPurpose::SqlCipherRetainPersistence, &ctx).expect("ok");
        assert_eq!(bytes, &vec![0xAA; 32][..]);
    }

    #[test]
    fn bytecode_retain_resolves_to_program_sha256() {
        let ctx = ctx_with_both();
        let bytes =
            context_bytes_for_purpose(KeyPurpose::SqlCipherBytecodeRetain, &ctx).expect("ok");
        assert_eq!(bytes, &vec![0xAA; 32][..]);
    }

    #[test]
    fn device_bound_with_empty_uuid_returns_deployment_uuid_required() {
        let ctx = ConsumerContext {
            deployment_uuid: Vec::new(),
            program_artifact_sha256: Some(vec![0xAA; 32]),
        };
        let err = context_bytes_for_purpose(KeyPurpose::SqlCipherOfflineQueue, &ctx)
            .expect_err("must error");
        match err {
            ConsumerContextError::DeploymentUuidRequired { purpose } => {
                assert_eq!(purpose, KeyPurpose::SqlCipherOfflineQueue);
            }
            other => panic!("expected DeploymentUuidRequired, got {other:?}"),
        }
    }

    #[test]
    fn program_bound_without_sha256_returns_program_sha256_required() {
        let ctx = ConsumerContext {
            deployment_uuid: b"x".to_vec(),
            program_artifact_sha256: None,
        };
        let err = context_bytes_for_purpose(KeyPurpose::SqlCipherRetainPersistence, &ctx)
            .expect_err("must error");
        match err {
            ConsumerContextError::ProgramSha256Required { purpose } => {
                assert_eq!(purpose, KeyPurpose::SqlCipherRetainPersistence);
            }
            other => panic!("expected ProgramSha256Required, got {other:?}"),
        }
    }

    #[test]
    fn program_bound_with_empty_sha256_returns_program_sha256_required() {
        // Empty Some(vec) — semantically equivalent to None.
        let ctx = ConsumerContext {
            deployment_uuid: b"x".to_vec(),
            program_artifact_sha256: Some(Vec::new()),
        };
        let err = context_bytes_for_purpose(KeyPurpose::SqlCipherBytecodeRetain, &ctx)
            .expect_err("must error");
        assert!(matches!(
            err,
            ConsumerContextError::ProgramSha256Required { .. }
        ));
    }

    #[test]
    fn non_sqlcipher_purpose_returns_wrong_purpose() {
        let ctx = ctx_with_both();
        for purpose in [
            KeyPurpose::AuditHmacChain,
            KeyPurpose::ReplayCache,
            KeyPurpose::DekEscrow,
            KeyPurpose::ConfigVerify,
        ] {
            let err =
                context_bytes_for_purpose(purpose, &ctx).expect_err("non-sqlcipher must error");
            assert!(
                matches!(err, ConsumerContextError::WrongPurpose { .. }),
                "expected WrongPurpose for {purpose:?}, got {err:?}"
            );
        }
    }

    #[test]
    fn error_display_strings_pinned() {
        for (err, prefix) in [
            (
                ConsumerContextError::WrongPurpose {
                    got: KeyPurpose::AuditHmacChain,
                },
                "consumer_context_wrong_purpose",
            ),
            (
                ConsumerContextError::ProgramSha256Required {
                    purpose: KeyPurpose::SqlCipherRetainPersistence,
                },
                "consumer_context_program_sha256_required",
            ),
            (
                ConsumerContextError::DeploymentUuidRequired {
                    purpose: KeyPurpose::SqlCipherOfflineQueue,
                },
                "consumer_context_deployment_uuid_required",
            ),
        ] {
            let s = format!("{err}");
            assert!(s.contains(prefix), "missing `{prefix}` in: {s}");
        }
    }

    #[test]
    fn error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ConsumerContextError>();
    }

    /// **ADR-031 stability contract pin (Batch #7
    /// invariant 1):** the device-bound consumer set
    /// is exactly `SqlCipherOfflineQueue` +
    /// `SqlCipherLicenseCache`. Adding a 3rd device-
    /// bound consumer requires extending this test +
    /// the resolver's match arm + ADR-031 itself.
    #[test]
    fn adr031_device_bound_consumer_set_pinned() {
        let ctx_only_uuid = ConsumerContext {
            deployment_uuid: b"x".to_vec(),
            program_artifact_sha256: None,
        };
        // These resolve cleanly with only deployment_uuid.
        for purpose in [
            KeyPurpose::SqlCipherOfflineQueue,
            KeyPurpose::SqlCipherLicenseCache,
        ] {
            let result = context_bytes_for_purpose(purpose, &ctx_only_uuid);
            assert!(
                result.is_ok(),
                "device-bound consumer {purpose:?} must resolve with only deployment_uuid"
            );
        }
        // These do NOT — they need program_artifact_sha256.
        for purpose in [
            KeyPurpose::SqlCipherRetainPersistence,
            KeyPurpose::SqlCipherBytecodeRetain,
        ] {
            let result = context_bytes_for_purpose(purpose, &ctx_only_uuid);
            assert!(
                matches!(
                    result,
                    Err(ConsumerContextError::ProgramSha256Required { .. })
                ),
                "program-bound consumer {purpose:?} must require program_artifact_sha256"
            );
        }
    }
}
