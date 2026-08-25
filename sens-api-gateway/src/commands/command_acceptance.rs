use chrono::{DateTime, Utc};

use crate::authz::manifest_runtime::RbacManifestStore;
use crate::command_envelope::EnvelopeVerifyError;
use crate::command_envelope::envelope::SignatureMode;
use crate::mqtt::CommandMessage;

use super::envelope_adapter::{self, AdapterOutcome};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CommandDecodeRejection {
    TenantUnavailable,
    LegacyPayloadForbidden,
    LegacyPayloadMalformed,
    EnvelopeRejected(EnvelopeVerifyError),
}

impl std::fmt::Display for CommandDecodeRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TenantUnavailable => formatter.write_str("tenant_unavailable"),
            Self::LegacyPayloadForbidden => formatter.write_str("legacy_payload_forbidden"),
            Self::LegacyPayloadMalformed => formatter.write_str("legacy_payload_malformed"),
            Self::EnvelopeRejected(reason) => write!(formatter, "envelope_rejected:{reason}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CommandTimestampRejection {
    Malformed,
    Stale,
    Future,
}

impl std::fmt::Display for CommandTimestampRejection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed => formatter.write_str("timestamp_malformed"),
            Self::Stale => formatter.write_str("timestamp_stale"),
            Self::Future => formatter.write_str("timestamp_future"),
        }
    }
}

pub(super) fn decode_command(
    payload: &[u8],
    tenant_bytes: Option<[u8; 16]>,
    signature_mode: SignatureMode,
    rbac_store: &RbacManifestStore,
) -> Result<CommandMessage, CommandDecodeRejection> {
    let tenant_bytes = match tenant_bytes {
        Some(tenant_bytes) => tenant_bytes,
        None if matches!(signature_mode, SignatureMode::Enforcing) => {
            return Err(CommandDecodeRejection::TenantUnavailable);
        }
        None => return parse_legacy_command(payload),
    };

    match envelope_adapter::try_parse_and_verify(payload, tenant_bytes, signature_mode, rbac_store)
    {
        AdapterOutcome::Verified(adapted) => Ok(CommandMessage {
            command_id: adapted.command_id,
            command: adapted.command,
            params: adapted.params,
            timestamp: adapted.timestamp,
            verified_co_approver: adapted.verified_co_approver,
        }),
        AdapterOutcome::NotEnvelopeFormat
            if matches!(
                signature_mode,
                SignatureMode::Disabled | SignatureMode::Permissive
            ) =>
        {
            parse_legacy_command(payload)
        }
        AdapterOutcome::NotEnvelopeFormat => Err(CommandDecodeRejection::LegacyPayloadForbidden),
        AdapterOutcome::VerifyFailed(reason) => {
            Err(CommandDecodeRejection::EnvelopeRejected(reason))
        }
    }
}

fn parse_legacy_command(payload: &[u8]) -> Result<CommandMessage, CommandDecodeRejection> {
    serde_json::from_slice(payload).map_err(|_| CommandDecodeRejection::LegacyPayloadMalformed)
}

pub(super) fn validate_command_timestamp(
    timestamp: &str,
    now: DateTime<Utc>,
    max_age_secs: i64,
    max_skew_secs: i64,
) -> Result<(), CommandTimestampRejection> {
    let command_time = DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| CommandTimestampRejection::Malformed)?;
    let age = now.signed_duration_since(command_time);
    let max_age = chrono::TimeDelta::seconds(max_age_secs);
    let max_future_skew = chrono::TimeDelta::seconds(max_skew_secs);

    if age > max_age {
        Err(CommandTimestampRejection::Stale)
    } else if age < -max_future_skew {
        Err(CommandTimestampRejection::Future)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, Utc};
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};

    use super::{
        CommandDecodeRejection, CommandTimestampRejection, decode_command,
        validate_command_timestamp,
    };
    use crate::authz::manifest::{Ed25519PublicKeyBytes, OperatorBinding, RbacManifest};
    use crate::authz::manifest_runtime::RbacManifestStore;
    use crate::authz::permission::{OperatorId, TenantId};
    use crate::authz::policy::Ed25519SignatureBytes;
    use crate::command_envelope::{
        CmdHash, CommandEnvelope, canonical_params, envelope::SignatureMode,
        envelope_canonical_bytes,
    };

    use super::super::envelope_adapter;

    const LEGACY_COMMAND: &[u8] = br#"{
        "commandId":"legacy-1",
        "command":"ping",
        "timestamp":"2026-08-25T12:00:00Z",
        "params":{}
    }"#;

    fn fixed_now() -> DateTime<Utc> {
        "2026-08-25T12:00:00Z"
            .parse()
            .expect("literal test timestamp must parse")
    }

    #[test]
    fn enforcing_mode_rejects_legacy_payload() {
        let store = RbacManifestStore::new();

        assert!(matches!(
            decode_command(
                LEGACY_COMMAND,
                Some([0u8; 16]),
                SignatureMode::Enforcing,
                &store
            ),
            Err(CommandDecodeRejection::LegacyPayloadForbidden)
        ));
    }

    #[test]
    fn enforcing_mode_rejects_when_tenant_is_unavailable() {
        let store = RbacManifestStore::new();

        assert!(matches!(
            decode_command(LEGACY_COMMAND, None, SignatureMode::Enforcing, &store),
            Err(CommandDecodeRejection::TenantUnavailable)
        ));
    }

    #[test]
    fn enforcing_mode_rejects_malformed_provisioned_tenant() {
        let store = RbacManifestStore::new();
        let tenant_bytes = envelope_adapter::tenant_id_bytes_or_none(Some("not-a-uuid"));

        assert!(matches!(
            decode_command(
                LEGACY_COMMAND,
                tenant_bytes,
                SignatureMode::Enforcing,
                &store
            ),
            Err(CommandDecodeRejection::TenantUnavailable)
        ));
    }

    #[test]
    fn verified_envelope_projects_all_command_fields() {
        let actor = [0x11u8; 16];
        let tenant = [0x42u8; 16];
        let signing_key = SigningKey::from_bytes(&[0x07u8; 32]);
        let store = RbacManifestStore::new();
        store.test_set_manifest(RbacManifest {
            policy_version: 1,
            tenant_id: TenantId::new_from_verified(tenant),
            manifest_valid_from_unix_secs: 0,
            manifest_valid_until_unix_secs: i64::MAX,
            operator_bindings: vec![OperatorBinding {
                operator_id: OperatorId::new_from_verified(actor),
                pubkey: Ed25519PublicKeyBytes::from_bytes(signing_key.verifying_key().to_bytes()),
                role_names: vec![],
            }],
            roles: vec![],
        });

        let params = serde_json::json!({"echo": "projected"});
        let canonical = canonical_params("ping", &params).expect("valid command fixture");
        let now_unix_secs = Utc::now().timestamp();
        let iat_unix_secs = now_unix_secs - 1;
        let mut envelope = CommandEnvelope {
            cmd: "ping".to_string(),
            params: params.clone(),
            actor,
            tenant_id: tenant,
            iat_unix_secs,
            exp_unix_secs: now_unix_secs + 3_600,
            claimed_policy_version: 1,
            co_approver_actor: None,
            co_approver_signature: None,
            jti: "projected-jti".to_string(),
            nonce: "projected-nonce".to_string(),
            cmd_hash: CmdHash::from_bytes(Sha256::digest(&canonical).into()),
            signature: None,
        };
        let signing_bytes = envelope_canonical_bytes(&envelope).expect("valid envelope fixture");
        envelope.signature = Some(Ed25519SignatureBytes::from_array(
            signing_key.sign(&signing_bytes).to_bytes(),
        ));
        let payload = serde_json::to_vec(&envelope).expect("serializable envelope fixture");

        let command = decode_command(&payload, Some(tenant), SignatureMode::Enforcing, &store)
            .expect("signed envelope must verify");

        assert_eq!(command.command_id, "projected-jti");
        assert_eq!(command.command, "ping");
        assert_eq!(command.params, params);
        assert_eq!(
            command.timestamp,
            DateTime::<Utc>::from_timestamp(iat_unix_secs, 0)
                .expect("fixture timestamp in range")
                .to_rfc3339()
        );
        assert!(!command.verified_co_approver);
    }

    #[test]
    fn permissive_mode_accepts_legacy_payload() {
        let store = RbacManifestStore::new();

        assert!(
            decode_command(
                LEGACY_COMMAND,
                Some([0u8; 16]),
                SignatureMode::Permissive,
                &store
            )
            .is_ok()
        );
    }

    #[test]
    fn disabled_mode_accepts_legacy_payload() {
        let store = RbacManifestStore::new();

        assert!(
            decode_command(
                LEGACY_COMMAND,
                Some([0u8; 16]),
                SignatureMode::Disabled,
                &store
            )
            .is_ok()
        );
    }

    #[test]
    fn malformed_timestamp_is_rejected() {
        assert!(matches!(
            validate_command_timestamp("not-rfc3339", fixed_now(), 300, 60),
            Err(CommandTimestampRejection::Malformed)
        ));
    }

    #[test]
    fn timestamp_older_than_max_age_is_rejected() {
        assert!(matches!(
            validate_command_timestamp("2026-08-25T11:54:59Z", fixed_now(), 300, 60),
            Err(CommandTimestampRejection::Stale)
        ));
    }

    #[test]
    fn timestamp_fractionally_older_than_max_age_is_rejected() {
        assert!(matches!(
            validate_command_timestamp("2026-08-25T11:54:59.500Z", fixed_now(), 300, 60),
            Err(CommandTimestampRejection::Stale)
        ));
    }

    #[test]
    fn timestamp_farther_future_than_max_skew_is_rejected() {
        assert!(matches!(
            validate_command_timestamp("2026-08-25T12:01:01Z", fixed_now(), 300, 60),
            Err(CommandTimestampRejection::Future)
        ));
    }

    #[test]
    fn timestamp_fractionally_farther_future_than_max_skew_is_rejected() {
        assert!(matches!(
            validate_command_timestamp("2026-08-25T12:01:00.500Z", fixed_now(), 300, 60),
            Err(CommandTimestampRejection::Future)
        ));
    }

    #[test]
    fn timestamp_at_exact_max_age_boundary_is_accepted() {
        assert!(validate_command_timestamp("2026-08-25T11:55:00Z", fixed_now(), 300, 60).is_ok());
    }

    #[test]
    fn timestamp_at_exact_max_skew_boundary_is_accepted() {
        assert!(validate_command_timestamp("2026-08-25T12:01:00Z", fixed_now(), 300, 60).is_ok());
    }
}
