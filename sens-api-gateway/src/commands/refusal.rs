//! A command message the agent did not execute: audited, and answered
//! (EDGE-MEDIUM-135, ADR-048 DEC-7.5, DEC-9).
//!
//! Before this module every gate of the command path ended in a `warn!` and
//! `return Ok(())`. The platform that sent a command learned nothing: it timed
//! out, retried, or waited for a hand-over that never happens, and the audit
//! chain held no record that a signed command was refused — "silent denies hide
//! policy probes from the SIEM" (the comment of the one refusal that was
//! audited, the two-person gate).
//!
//! Now every refusal is a [`Refusal`] value and leaves through
//! [`CommandHandler::refuse`](super::CommandHandler):
//!
//! * one audit entry (`CommandRejected`, outcome `AuthorizationDenied` for a
//!   denial of authority, `Failure` otherwise), with the stable code of the
//!   refusal in its detail;
//! * one command response, `success: false`, whose result names the code and
//!   says whether sending the same command again later can succeed
//!   (`retryable`), published like every other response so a broker outage
//!   queues it.
//!
//! Two refusals are audited and not answered. A **duplicate** is an MQTT
//! redelivery of a command that already ran: its own response is on its way, and
//! a second, failed one under the same `command_id` could overwrite it at the
//! cloud. A **retained** command is a broker replay: it has no sender to tell.
//!
//! The command id and name an audit entry or response carries for a refusal come
//! from the payload BEFORE (or without) verification, so they are claims: bounded
//! to the audit chain's field size and reduced to printable ASCII.

use tracing::warn;

use crate::audit::AuditOutcome;
use crate::mqtt::CommandResponse;
use crate::runtime_safety::ClockError;
use crate::security::sanitize_for_log;

use super::audit_emit;
use super::command_acceptance::CommandTimestampRejection;

/// The longest id or command name a refusal repeats: the audit entry's
/// `correlation_id` bound.
const MAX_CLAIM_BYTES: usize = crate::audit::entry::MAX_CORRELATION_ID_BYTES;
/// The longest detail a response carries, in characters; the audit entry
/// bounds its own.
const MAX_RESPONSE_DETAIL_CHARS: usize = 256;
/// What a refusal says when the payload names no id or command.
const UNKNOWN_CLAIM: &str = "unknown";

/// Why a command message was not executed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Refusal {
    /// The clock authority does not vouch for the wall clock, so freshness
    /// cannot be judged (DEC-7.5). Retryable: it is the contract's
    /// `clock-unsynced`.
    ClockUnsynced(String),
    /// The clock authority failed in a way waiting does not repair (a monotonic
    /// clock that went backward).
    ClockFault(String),
    /// A payload that is not a command envelope, where only envelopes run
    /// (Enforcing, and the whole suderra-os profile).
    NotAnEnvelope,
    /// A payload that is neither an envelope nor a legacy command. The suderra-os
    /// profile has no legacy command to fail to parse (ADR-048 DEC-9.1): the
    /// refusal is not compiled there.
    #[cfg(not(feature = "suderra-os"))]
    Unparseable,
    /// An unsigned (legacy) command the catalog's policy forbids in this mode.
    /// Not compiled on suderra-os, which has no unsigned command path.
    #[cfg(not(feature = "suderra-os"))]
    UnsignedForbidden(String),
    /// An envelope a verification gate rejected (the gate's stable name).
    EnvelopeInvalid(String),
    /// The device has no tenant to bind an envelope to yet (provisioning, or the
    /// trust root, is not complete). Retryable once it is. Not compiled on the
    /// generic profile, which binds the tenant when the state is built and
    /// parses a legacy command while there is none.
    #[cfg(feature = "suderra-os")]
    NoTenantBinding,
    /// The command names a device or register the configuration does not have.
    TargetUnresolved(String),
    /// The actor's role does not hold the permission the command needs.
    NotAuthorized(String),
    /// The command's timestamp is outside the replay window, or is none.
    Timestamp(CommandTimestampRejection),
    /// A command id already executed (an MQTT redelivery). Audited, not answered.
    Duplicate,
    /// A retained message on the command topic (a broker replay). Audited, not
    /// answered.
    Retained,
}

impl Refusal {
    /// What an authority that will not vouch for the wall clock means for a
    /// command: not synchronized (retryable, DEC-7.5), or broken beyond waiting.
    pub(super) fn from_clock_error(error: &ClockError) -> Self {
        match error {
            ClockError::Unsynced(cause) => Self::ClockUnsynced(cause.as_str().to_owned()),
            ClockError::NtsSyncStale { .. } => Self::ClockUnsynced("nts-sync-stale".to_owned()),
            ClockError::PreEpochWallClock => Self::ClockUnsynced("pre-epoch".to_owned()),
            ClockError::MonotonicBackward | ClockError::MonotonicOverflow => {
                Self::ClockFault(error.to_string())
            }
        }
    }

    /// The stable wire code of the refusal: what the response's `rejected` and
    /// the audit detail carry. Kebab-case, like the contract's result reasons.
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::ClockUnsynced(_) => "clock-unsynced",
            Self::ClockFault(_) => "clock-fault",
            Self::NotAnEnvelope => "not-an-envelope",
            #[cfg(not(feature = "suderra-os"))]
            Self::Unparseable => "unparseable-command",
            #[cfg(not(feature = "suderra-os"))]
            Self::UnsignedForbidden(_) => "unsigned-command-forbidden",
            Self::EnvelopeInvalid(_) => "envelope-invalid",
            #[cfg(feature = "suderra-os")]
            Self::NoTenantBinding => "no-tenant-binding",
            Self::TargetUnresolved(_) => "target-unresolved",
            Self::NotAuthorized(_) => "not-authorized",
            Self::Timestamp(CommandTimestampRejection::Malformed) => "timestamp-malformed",
            Self::Timestamp(CommandTimestampRejection::Stale) => "timestamp-stale",
            Self::Timestamp(CommandTimestampRejection::Future) => "timestamp-future",
            Self::Duplicate => "duplicate-command",
            Self::Retained => "retained-command",
        }
    }

    /// The refusal's specifics (a gate name, a reason), when it has any.
    fn detail(&self) -> Option<&str> {
        match self {
            Self::ClockUnsynced(detail)
            | Self::ClockFault(detail)
            | Self::EnvelopeInvalid(detail)
            | Self::TargetUnresolved(detail)
            | Self::NotAuthorized(detail) => Some(detail),
            #[cfg(not(feature = "suderra-os"))]
            Self::UnsignedForbidden(detail) => Some(detail),
            _ => None,
        }
    }

    /// Whether sending the SAME command again later can succeed without anyone
    /// changing it: only when the refusal is a state the device leaves by
    /// itself (the clock synchronizes, provisioning completes). A refusal for a
    /// stale timestamp, a bad signature or a missing permission is not.
    pub(super) fn retryable(&self) -> bool {
        match self {
            Self::ClockUnsynced(_) => true,
            #[cfg(feature = "suderra-os")]
            Self::NoTenantBinding => true,
            _ => false,
        }
    }

    /// Whether the sender is told. A duplicate's answer is already on its way,
    /// and a retained message has no sender.
    pub(super) fn is_answered(&self) -> bool {
        !matches!(self, Self::Duplicate | Self::Retained)
    }

    /// The audit outcome: a denial of authority, or a failure to qualify.
    pub(super) fn audit_outcome(&self) -> AuditOutcome {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::UnsignedForbidden(_) => AuditOutcome::AuthorizationDenied,
            Self::EnvelopeInvalid(_)
            | Self::NotAuthorized(_)
            | Self::NotAnEnvelope
            | Self::Retained => AuditOutcome::AuthorizationDenied,
            _ => AuditOutcome::Failure,
        }
    }

    /// `refused=<code>` plus the specifics, for the audit entry's detail.
    pub(super) fn audit_detail(&self) -> String {
        match self.detail() {
            Some(detail) => format!(
                "refused={} detail={}",
                self.code(),
                sanitize_for_log(detail)
            ),
            None => format!("refused={}", self.code()),
        }
    }

    /// The command response that tells the sender.
    pub(super) fn response(&self, claims: &Claimed, device_id: &str) -> CommandResponse {
        let mut message = format!("Command refused ({})", self.code());
        if let Some(detail) = self.detail() {
            message.push_str(": ");
            message.extend(
                sanitize_for_log(detail)
                    .chars()
                    .take(MAX_RESPONSE_DETAIL_CHARS),
            );
        }
        CommandResponse {
            command_id: claims.command_id.clone(),
            device_id: device_id.to_owned(),
            success: false,
            result: serde_json::json!({
                "rejected": self.code(),
                "retryable": self.retryable(),
            }),
            // The time of the response is information for the reader, not a
            // freshness decision: nothing on the device judges anything by it.
            timestamp: chrono::Utc::now().to_rfc3339(),
            error: Some(message),
        }
    }
}

/// The id and command name a payload CLAIMS: read without verifying, so bounded
/// and reduced to printable ASCII before anything repeats them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Claimed {
    pub command_id: String,
    pub command: String,
}

impl Claimed {
    /// A refused payload's claims: an envelope's `jti` and `cmd`, or a legacy
    /// command's `commandId`/`command_id` and `command`.
    pub(super) fn from_payload(payload: &[u8]) -> Self {
        let value: serde_json::Value = serde_json::from_slice(payload).unwrap_or_default();
        let text = |names: &[&str]| -> String {
            let found = names
                .iter()
                .find_map(|name| value.get(*name).and_then(serde_json::Value::as_str));
            Self::printable(found.unwrap_or(UNKNOWN_CLAIM))
        };
        Self {
            command_id: text(&["jti", "command_id", "commandId"]),
            command: text(&["cmd", "command"]),
        }
    }

    fn printable(text: &str) -> String {
        let reduced: String = text
            .chars()
            .filter(char::is_ascii_graphic)
            .take(MAX_CLAIM_BYTES)
            .collect();
        if reduced.is_empty() {
            UNKNOWN_CLAIM.to_owned()
        } else {
            reduced
        }
    }
}

impl super::CommandHandler {
    /// Refuse a payload: audit it and, unless the refusal is not answered,
    /// answer the sender. Always `Ok(())`: a refusal is an operational event of
    /// the command path, not a failure of the run loop.
    pub(super) async fn refuse(&self, payload: &[u8], refusal: Refusal) -> anyhow::Result<()> {
        self.record_refusal(Claimed::from_payload(payload), refusal)
            .await;
        Ok(())
    }

    async fn record_refusal(&self, claims: Claimed, refusal: Refusal) {
        warn!(
            code = refusal.code(),
            retryable = refusal.retryable(),
            command = %claims.command,
            command_id = %claims.command_id,
            answered = refusal.is_answered(),
            "Command refused: {}",
            refusal.detail().map(sanitize_for_log).unwrap_or_default(),
        );
        let state = self.state.read().await;
        let tenant = crate::authz::permission::TenantId::new_from_verified(
            state
                .tenant_id
                .as_deref()
                .and_then(|tenant| uuid::Uuid::parse_str(tenant).ok())
                .map_or([0u8; 16], |tenant| *tenant.as_bytes()),
        );
        audit_emit::emit_refusal_event(
            state.audit_sink.as_ref(),
            &claims.command,
            &claims.command_id,
            &state.config.device_id,
            tenant,
            &refusal,
        );
        if refusal.is_answered() {
            let response = refusal.response(&claims, &state.config.device_id);
            crate::publish_helpers::publish_response(&state, &response).await;
            #[cfg(test)]
            if let (Ok(mut sent), Ok(wire)) = (
                self.refusal_responses.lock(),
                serde_json::to_value(&response),
            ) {
                sent.push(wire);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(unused_mut)]
    fn every_refusal() -> Vec<Refusal> {
        let mut all = vec![
            Refusal::ClockUnsynced("stale".into()),
            Refusal::ClockFault("monotonic_backward".into()),
            Refusal::NotAnEnvelope,
            Refusal::EnvelopeInvalid("signature_invalid".into()),
            Refusal::TargetUnresolved("no such device".into()),
            Refusal::NotAuthorized("role lacks the permission".into()),
            Refusal::Timestamp(CommandTimestampRejection::Malformed),
            Refusal::Timestamp(CommandTimestampRejection::Stale),
            Refusal::Timestamp(CommandTimestampRejection::Future),
            Refusal::Duplicate,
            Refusal::Retained,
        ];
        #[cfg(not(feature = "suderra-os"))]
        all.extend([
            Refusal::Unparseable,
            Refusal::UnsignedForbidden("denied".into()),
        ]);
        #[cfg(feature = "suderra-os")]
        all.push(Refusal::NoTenantBinding);
        all
    }

    #[test]
    fn a_clock_that_cannot_be_trusted_is_retryable_one_that_is_broken_is_not() {
        use crate::runtime_safety::UnsyncedCause;
        for error in [
            ClockError::Unsynced(UnsyncedCause::Stale),
            ClockError::Unsynced(UnsyncedCause::Unreadable),
            ClockError::NtsSyncStale {
                last_sync_age_secs: 9,
                threshold_secs: 1,
            },
            ClockError::PreEpochWallClock,
        ] {
            let refusal = Refusal::from_clock_error(&error);
            assert_eq!(refusal.code(), "clock-unsynced", "{error:?}");
            assert!(refusal.retryable(), "{error:?}");
        }
        for error in [ClockError::MonotonicBackward, ClockError::MonotonicOverflow] {
            let refusal = Refusal::from_clock_error(&error);
            assert_eq!(refusal.code(), "clock-fault", "{error:?}");
            assert!(!refusal.retryable(), "{error:?}");
        }
        assert_eq!(
            Refusal::from_clock_error(&ClockError::Unsynced(UnsyncedCause::Stale)).audit_detail(),
            "refused=clock-unsynced detail=stale"
        );
    }

    #[test]
    fn every_refusal_has_its_own_stable_kebab_case_code() {
        let codes: Vec<&str> = every_refusal().iter().map(Refusal::code).collect();
        let unique: std::collections::BTreeSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len(), "codes collide: {codes:?}");
        for code in codes {
            assert!(
                !code.is_empty()
                    && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                    && !code.starts_with('-')
                    && !code.ends_with('-'),
                "{code}"
            );
        }
    }

    /// The contract names the clock refusal; the agent says exactly that.
    #[test]
    fn the_clock_refusal_is_the_contract_s_retryable_clock_unsynced() {
        let channels: serde_json::Value = serde_json::from_slice(
            &std::fs::read("../contracts/suderra-edge/v1/channels.json").expect("channels.json"),
        )
        .expect("JSON");
        let refusal = &channels["time"]["consumers"]["agent-fresh-actuation"]["refusal"];
        let clock = Refusal::ClockUnsynced("unreadable".into());
        assert_eq!(refusal, clock.code());
        assert!(clock.retryable());
        assert_eq!(
            clock.response(&Claimed::from_payload(b"{}"), "dev").result["retryable"],
            true
        );
    }

    #[test]
    fn only_a_state_the_device_leaves_by_itself_is_retryable() {
        let retryable: Vec<&str> = every_refusal()
            .iter()
            .filter(|r| r.retryable())
            .map(Refusal::code)
            .collect();
        // The tenant binding exists on suderra-os only (the generic profile
        // binds the tenant when the state is built).
        let expected: &[&str] = if cfg!(feature = "suderra-os") {
            &["clock-unsynced", "no-tenant-binding"]
        } else {
            &["clock-unsynced"]
        };
        assert_eq!(retryable, expected);
    }

    /// A duplicate is answered by the first execution, a retained message has no
    /// sender: the rest are all answered.
    #[test]
    fn only_a_duplicate_and_a_retained_replay_are_not_answered() {
        let silent: Vec<&str> = every_refusal()
            .iter()
            .filter(|r| !r.is_answered())
            .map(Refusal::code)
            .collect();
        assert_eq!(silent, ["duplicate-command", "retained-command"]);
    }

    #[test]
    fn a_response_says_what_was_refused_and_why() {
        let claims =
            Claimed::from_payload(br#"{"jti":"abc-123","cmd":"write_modbus","iat_unix_secs":1}"#);
        let response =
            Refusal::EnvelopeInvalid("signature_invalid".into()).response(&claims, "device-7");
        assert!(!response.success);
        assert_eq!(response.command_id, "abc-123");
        assert_eq!(response.device_id, "device-7");
        assert_eq!(response.result["rejected"], "envelope-invalid");
        assert_eq!(response.result["retryable"], false);
        let error = response.error.expect("a message");
        assert!(error.contains("envelope-invalid"), "{error}");
        assert!(error.contains("signature_invalid"), "{error}");
    }

    #[test]
    fn claims_come_from_an_envelope_or_a_legacy_command_and_are_bounded() {
        let envelope = Claimed::from_payload(br#"{"jti":"j-1","cmd":"ping"}"#);
        assert_eq!(
            (envelope.command_id.as_str(), envelope.command.as_str()),
            ("j-1", "ping")
        );
        let legacy = Claimed::from_payload(br#"{"command_id":"c-1","command":"get_info"}"#);
        assert_eq!(
            (legacy.command_id.as_str(), legacy.command.as_str()),
            ("c-1", "get_info")
        );
        let camel = Claimed::from_payload(br#"{"commandId":"c-2","command":"ping"}"#);
        assert_eq!(camel.command_id, "c-2");
        for payload in [
            &b""[..],
            b"not json",
            b"[]",
            b"{}",
            br#"{"jti":5,"cmd":null}"#,
        ] {
            let unknown = Claimed::from_payload(payload);
            assert_eq!(unknown.command_id, UNKNOWN_CLAIM, "{payload:?}");
            assert_eq!(unknown.command, UNKNOWN_CLAIM, "{payload:?}");
        }
        let huge = format!(
            r#"{{"jti":"{}","cmd":"c\u0000md\n{}"}}"#,
            "x".repeat(10_000),
            "y".repeat(10_000)
        );
        let bounded = Claimed::from_payload(huge.as_bytes());
        assert_eq!(bounded.command_id.len(), MAX_CLAIM_BYTES);
        assert!(bounded.command.len() <= MAX_CLAIM_BYTES);
        assert!(
            bounded.command.bytes().all(|b| b.is_ascii_graphic()),
            "{}",
            bounded.command
        );
    }

    #[test]
    fn a_response_detail_is_bounded_and_one_line() {
        let long = format!("line one\nline two {}", "z".repeat(5_000));
        let response = Refusal::NotAuthorized(long).response(&Claimed::from_payload(b"{}"), "d");
        let error = response.error.expect("a message");
        assert!(!error.contains('\n'), "{error}");
        assert!(error.len() < 400, "{}", error.len());
    }

    #[test]
    #[allow(unused_mut)]
    fn a_denial_of_authority_is_audited_as_one() {
        let mut denials = vec![
            Refusal::NotAuthorized("x".into()),
            Refusal::EnvelopeInvalid("x".into()),
            Refusal::NotAnEnvelope,
            Refusal::Retained,
        ];
        let mut failures = vec![
            Refusal::ClockUnsynced("x".into()),
            Refusal::Duplicate,
            Refusal::Timestamp(CommandTimestampRejection::Stale),
        ];
        #[cfg(not(feature = "suderra-os"))]
        {
            denials.push(Refusal::UnsignedForbidden("x".into()));
            failures.push(Refusal::Unparseable);
        }
        #[cfg(feature = "suderra-os")]
        failures.push(Refusal::NoTenantBinding);
        for denial in denials {
            assert_eq!(denial.audit_outcome(), AuditOutcome::AuthorizationDenied);
        }
        for failure in failures {
            assert_eq!(failure.audit_outcome(), AuditOutcome::Failure);
        }
    }

    #[test]
    fn the_audit_detail_names_the_code_and_the_specifics() {
        assert_eq!(
            Refusal::Duplicate.audit_detail(),
            "refused=duplicate-command"
        );
        assert_eq!(
            Refusal::EnvelopeInvalid("signature_invalid".into()).audit_detail(),
            "refused=envelope-invalid detail=signature_invalid"
        );
    }
}
