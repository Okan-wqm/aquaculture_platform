//! # Retained-message guard (plan D-14, ADR-020 §4)
//!
//! MQTT retained messages are delivered to subscribers at subscribe time
//! AND on reconnect. An attacker who briefly controls a broker session
//! with publish rights can PUBLISH a signed mutating command with the
//! retain flag set; every subsequent subscriber reconnect receives and
//! executes the command again — turning single-use authorization into a
//! persistent replay surface.
//!
//! Defense-in-depth:
//!
//! - **Broker ACL (primary):** Mosquitto / EMQX policy forbids the retain
//!   flag on command topics. Configured in `infrastructure/mosquitto/conf.d/`
//!   by the deployment team (Sprint 6.7).
//! - **Edge-side rejection (belt-and-braces):** every incoming MQTT command
//!   passes through `is_retained_command_rejected` BEFORE signature verify.
//!   Retained commands on mutating topics are rejected with structured
//!   reason, regardless of signature validity. The jti dedup cache is NOT
//!   sufficient defense here because a retained command with a fresh-jti
//!   replay would pass dedup.
//!
//! This module provides the edge-side predicate type surface. Sprint 6.7
//! wires the MQTT-client subscribe hook.

use serde::{Deserialize, Serialize};

/// Reason a retained message was rejected. Structured for audit trail;
/// each variant carries enough detail for operator incident response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum RetainedMsgRejectionReason {
    /// Message arrived with the retain flag set on a command topic.
    RetainedOnCommandTopic { topic: String },

    /// Message on a non-command topic (telemetry / status / watch) — NOT
    /// rejected. Used as the `Ok` equivalent by consumers that want to
    /// express the decision in a single enum.
    NotRejected,
}

impl std::fmt::Display for RetainedMsgRejectionReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RetainedOnCommandTopic { .. } => f.write_str("retained_on_command_topic"),
            Self::NotRejected => f.write_str("not_rejected"),
        }
    }
}

/// Predicate: is this MQTT message a retained mutating command that must
/// be rejected?
///
/// Inputs:
/// - `retained`: the MQTT retain flag from the incoming PUBLISH packet.
/// - `topic`: the topic string (e.g. `"tenants/t-42/devices/d-7/cmd/write_tag"`).
/// - `is_command_topic_fn`: closure returning true if `topic` is a command
///   topic (tenant-scoped command-dispatch path). Injected so the command-
///   topic taxonomy can evolve without a D-14 type change. Sprint 6.7
///   wires a regex-based matcher.
///
/// Returns `RetainedMsgRejectionReason::RetainedOnCommandTopic { topic }`
/// if retained + is-command-topic; `NotRejected` otherwise.
pub fn is_retained_command_rejected(
    retained: bool,
    topic: &str,
    is_command_topic_fn: impl FnOnce(&str) -> bool,
) -> RetainedMsgRejectionReason {
    if !retained {
        return RetainedMsgRejectionReason::NotRejected;
    }
    if is_command_topic_fn(topic) {
        RetainedMsgRejectionReason::RetainedOnCommandTopic {
            topic: topic.to_string(),
        }
    } else {
        RetainedMsgRejectionReason::NotRejected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd_topic_matcher(topic: &str) -> bool {
        topic.contains("/cmd/")
    }

    /// WHY: Retained mutating command → RetainedOnCommandTopic rejection.
    #[test]
    fn retained_on_command_topic_rejected() {
        let reason = is_retained_command_rejected(
            true,
            "tenants/t-42/devices/d-7/cmd/write_tag",
            cmd_topic_matcher,
        );
        assert!(matches!(
            reason,
            RetainedMsgRejectionReason::RetainedOnCommandTopic { .. }
        ));
    }

    /// WHY: Non-retained command → accepted (NotRejected).
    #[test]
    fn non_retained_command_accepted() {
        let reason = is_retained_command_rejected(
            false,
            "tenants/t-42/devices/d-7/cmd/write_tag",
            cmd_topic_matcher,
        );
        assert_eq!(reason, RetainedMsgRejectionReason::NotRejected);
    }

    /// WHY: Retained message on a NON-command topic (telemetry) → accepted.
    ///      Retained telemetry is a legitimate MQTT pattern ("last-known
    ///      value on subscribe"); only commands are rejected.
    #[test]
    fn retained_on_telemetry_topic_accepted() {
        let reason = is_retained_command_rejected(
            true,
            "tenants/t-42/devices/d-7/telemetry/pond3_temp",
            cmd_topic_matcher,
        );
        assert_eq!(reason, RetainedMsgRejectionReason::NotRejected);
    }

    /// WHY: Non-retained non-command message → accepted.
    #[test]
    fn non_retained_non_command_accepted() {
        let reason = is_retained_command_rejected(
            false,
            "tenants/t-42/devices/d-7/status",
            cmd_topic_matcher,
        );
        assert_eq!(reason, RetainedMsgRejectionReason::NotRejected);
    }

    /// WHY: Rejection carries the topic for audit trail + incident response.
    #[test]
    fn rejection_includes_topic_for_audit() {
        let reason = is_retained_command_rejected(
            true,
            "tenants/t-42/devices/d-7/cmd/force_value",
            cmd_topic_matcher,
        );
        match reason {
            RetainedMsgRejectionReason::RetainedOnCommandTopic { topic } => {
                assert_eq!(topic, "tenants/t-42/devices/d-7/cmd/force_value");
            }
            other => panic!("expected RetainedOnCommandTopic, got {:?}", other),
        }
    }

    /// WHY: Display format pinned for log grep.
    #[test]
    fn rejection_reason_display_snake_case() {
        assert_eq!(
            format!(
                "{}",
                RetainedMsgRejectionReason::RetainedOnCommandTopic {
                    topic: "x".to_string()
                }
            ),
            "retained_on_command_topic"
        );
        assert_eq!(
            format!("{}", RetainedMsgRejectionReason::NotRejected),
            "not_rejected"
        );
    }

    /// WHY: JSON serde roundtrip for audit event propagation.
    #[test]
    fn rejection_reason_json_roundtrip() {
        let r = RetainedMsgRejectionReason::RetainedOnCommandTopic {
            topic: "tenants/t-42/cmd/x".to_string(),
        };
        let json = serde_json::to_string(&r).expect("ok");
        let back: RetainedMsgRejectionReason = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, r);
    }
}
