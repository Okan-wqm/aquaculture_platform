//! Signed statements the agent hands to root (ADR-048 DEC-5.8, DEC-5.14).
//! Suderra OS profile only.
//!
//! Root alone records the device lifecycle (lifecycle.json `store`); the
//! agent's part is to carry the cloud-signed statement that moves it from
//! the command plane to the file root's path unit watches
//! (mutable-state.json `/var/lib/suderra/state`):
//!
//! * `activation_receipt` — `suderra.edge-activation-receipt.v1`, issued by
//!   the cloud after the device's first authenticated broker session
//!   (DEC-5.7, DEC-5.8). The agent verifies it as statements.json's agent
//!   verifier does — every check except root's key-epoch ratchet and the
//!   digest of the manifest root installed, which the agent cannot see —
//!   and only then writes it to `state/activation-receipt.dsse`
//!   (`suderra-activation.path`). Root verifies it again and records
//!   ACTIVE; nothing the agent writes is itself evidence of activation.
//! * `lifecycle_request` — `suderra.device-lifecycle.v1` (DEC-5.14: enter
//!   maintenance to re-provision). The agent is not a verifier of this
//!   statement (statements.json lists root alone; its key is pinned only in
//!   the OS image), so it checks only the envelope's form and payloadType —
//!   the checks root would fail first — and writes it to
//!   `state/lifecycle-request.dsse` (`suderra-lifecycle.path`).
//!
//! The statement is the command's `statement` parameter: a string holding
//! the DSSE envelope JSON exactly as the cloud produced it. The agent writes
//! those bytes and no others (atomic, mode 0600). Re-serializing a parsed
//! object instead would silently repair an envelope root must refuse (a
//! duplicate member, for one) and would change the bytes the cloud recorded.
//!
//! Both commands are catalog-anonymous: the statement carries its own
//! signature, and on Suderra OS every command still arrives in an envelope
//! signed by the platform's command key (DEC-9.1).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tracing::{info, warn};

use super::CommandHandler;
use crate::edge_contract::dsse::Envelope;
use crate::edge_contract::registry::{Reason, StatementType};
use crate::edge_contract::verify::verify_receipt;
use crate::paths::AgentPaths;
use crate::shared_io::atomic_json_sidecar::write_atomic_bytes_owner_only;
use crate::trust_anchors::{InstalledTrust, now_timestamp, reasons_text};

/// Largest statement the agent hands over: root reads at most this many
/// bytes of an agent-written statement (Suderra-OS `suderra-installer`
/// `cmd/lifecycle.rs` `MAX_STATEMENT`), so a larger one could never be
/// accepted.
pub(crate) const MAX_HANDOFF_BYTES: usize = 64 * 1024;

/// Why a statement was not handed to root. Nothing is written in any case.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum HandoffError {
    /// The command carried no `statement` string.
    #[error("the `statement` parameter must be the DSSE envelope as a JSON string")]
    MissingStatement,
    /// Larger than root reads.
    #[error("statement is {0} bytes; root reads at most {MAX_HANDOFF_BYTES}")]
    TooLarge(usize),
    /// The statement failed a contract check (statements.json reasons).
    #[error("statement rejected: {}", reasons_text(.0))]
    Rejected(BTreeSet<Reason>),
    /// The agent has no verified trust anchors to check the statement with.
    #[error("no verified trust-anchors bundle is installed")]
    NoTrustRoot,
    /// The file could not be written.
    #[error("cannot write {path}: {reason}")]
    Write {
        /// Target file.
        path: PathBuf,
        /// I/O error.
        reason: String,
    },
}

impl HandoffError {
    /// The machine-readable reasons for the command result.
    fn reasons(&self) -> Vec<&'static str> {
        match self {
            Self::Rejected(reasons) => reasons.iter().map(|r| r.as_str()).collect(),
            Self::MissingStatement => vec!["statement-missing"],
            Self::TooLarge(_) => vec!["statement-too-large"],
            Self::NoTrustRoot => vec!["trust-anchors-unavailable"],
            Self::Write { .. } => vec!["io-error"],
        }
    }
}

/// A statement written for root.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Handed {
    /// Statement digest (SHA-256 of the payload bytes).
    pub statement_digest: String,
    /// The file root reads.
    pub path: PathBuf,
}

fn rejected(reason: Reason) -> HandoffError {
    HandoffError::Rejected(BTreeSet::from([reason]))
}

/// The envelope of `statement` if it is within root's size limit, a
/// well-formed DSSE envelope and of payloadType `expected`.
fn envelope_of(statement: &[u8], expected: StatementType) -> Result<Envelope, HandoffError> {
    if statement.len() > MAX_HANDOFF_BYTES {
        return Err(HandoffError::TooLarge(statement.len()));
    }
    let env = Envelope::parse(statement).map_err(rejected)?;
    if env.payload_type != expected.payload_type() {
        return Err(rejected(Reason::PayloadTypeMismatch));
    }
    Ok(env)
}

fn write_for_root(target: &Path, statement: &[u8], digest: String) -> Result<Handed, HandoffError> {
    write_atomic_bytes_owner_only(target, statement).map_err(|e| HandoffError::Write {
        path: target.to_path_buf(),
        reason: e.to_string(),
    })?;
    Ok(Handed {
        statement_digest: digest,
        path: target.to_path_buf(),
    })
}

/// Verifies an activation receipt for this device at `now` and writes it
/// verbatim to `target` (DEC-5.8).
pub(crate) fn hand_over_activation_receipt(
    trust: &InstalledTrust,
    statement: &[u8],
    target: &Path,
    now: &str,
) -> Result<Handed, HandoffError> {
    let env = envelope_of(statement, StatementType::EdgeActivationReceipt)?;
    let no_gates = BTreeMap::new();
    let receipt = verify_receipt(&env, &trust.scope(&no_gates, now))
        .accepted()
        .map_err(HandoffError::Rejected)?;
    write_for_root(target, statement, receipt.digest)
}

/// Writes a device-lifecycle statement verbatim to `target` for root to
/// verify and act on (DEC-5.14).
pub(crate) fn hand_over_lifecycle_request(
    statement: &[u8],
    target: &Path,
) -> Result<Handed, HandoffError> {
    let env = envelope_of(statement, StatementType::DeviceLifecycle)?;
    write_for_root(target, statement, env.statement_digest())
}

/// The `statement` parameter's bytes.
pub(crate) fn statement_param(params: &Value) -> Result<&[u8], HandoffError> {
    params
        .get("statement")
        .and_then(Value::as_str)
        .map(str::as_bytes)
        .ok_or(HandoffError::MissingStatement)
}

/// The command result for a hand-over.
pub(crate) fn respond(
    command: &str,
    outcome: Result<Handed, HandoffError>,
) -> (bool, Value, Option<String>) {
    match outcome {
        Ok(handed) => {
            info!(
                "{}: statement {} handed to root at {}",
                command,
                handed.statement_digest,
                handed.path.display()
            );
            (
                true,
                json!({
                    "statement_digest": { "sha256": handed.statement_digest },
                    "handed_to_root": true,
                }),
                None,
            )
        }
        Err(e) => {
            warn!("{} refused: {}", command, e);
            (
                false,
                json!({ "handed_to_root": false, "reasons": e.reasons() }),
                Some(format!("{command}: {e}")),
            )
        }
    }
}

impl CommandHandler {
    /// `activation_receipt` — verify the cloud-signed activation receipt
    /// and hand it to root (ADR-048 DEC-5.8).
    pub(super) async fn cmd_activation_receipt(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let trust = self.state.read().await.trust_anchors.clone();
        let outcome = match trust {
            None => Err(HandoffError::NoTrustRoot),
            Some(trust) => statement_param(params).and_then(|statement| {
                hand_over_activation_receipt(
                    &trust,
                    statement,
                    &AgentPaths::current().activation_receipt_file(),
                    &now_timestamp(),
                )
            }),
        };
        respond("activation_receipt", outcome)
    }

    /// `lifecycle_request` — hand a cloud-signed device-lifecycle statement
    /// to root (ADR-048 DEC-5.14).
    pub(super) async fn cmd_lifecycle_request(
        &self,
        params: &Value,
    ) -> (bool, Value, Option<String>) {
        let outcome = statement_param(params).and_then(|statement| {
            hand_over_lifecycle_request(statement, &AgentPaths::current().lifecycle_request_file())
        });
        respond("lifecycle_request", outcome)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::trust_anchors::test_support::{FIXTURE_NOW, fixture, fixture_trust};

    const BUNDLE: &str = "trust-anchors/valid/bundle-seq-1.dsse.json";
    const RECEIPT: &str = "edge-activation-receipt/valid/revpi-connect4.dsse.json";
    const LIFECYCLE: &str = "device-lifecycle/valid/enter-maintenance-reprovision.dsse.json";

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_verified_receipt_lands_verbatim_and_owner_only() {
        let (root, trust) = fixture_trust(BUNDLE);
        let target = root.path().join("state/activation-receipt.dsse");
        let bytes = fixture(RECEIPT);
        let handed = hand_over_activation_receipt(&trust, &bytes, &target, FIXTURE_NOW).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert_eq!(mode(&target), 0o600);
        assert_eq!(
            handed.statement_digest,
            Envelope::parse(&bytes).unwrap().statement_digest()
        );

        // A later receipt (re-provisioning) replaces the file whole.
        let again = hand_over_activation_receipt(&trust, &bytes, &target, FIXTURE_NOW).unwrap();
        assert_eq!(again, handed);
    }

    #[test]
    fn the_installed_manifest_digest_is_roots_check() {
        // statements.json verified_by.agent.omits: the agent cannot see which
        // manifest root installed, so it hands this receipt over and root
        // refuses it as manifest-digest-mismatch.
        let (root, trust) = fixture_trust(BUNDLE);
        let target = root.path().join("receipt.dsse");
        let bytes = fixture("edge-activation-receipt/invalid/wrong-manifest-digest.dsse.json");
        assert!(hand_over_activation_receipt(&trust, &bytes, &target, FIXTURE_NOW).is_ok());
    }

    #[test]
    fn a_refused_receipt_names_its_contract_reason_and_writes_nothing() {
        let (root, trust) = fixture_trust(BUNDLE);
        let target = root.path().join("state/activation-receipt.dsse");
        for (rel, reason) in [
            (
                "edge-activation-receipt/invalid/two-signatures.dsse.json",
                Reason::EnvelopeInvalid,
            ),
            (
                "edge-activation-receipt/invalid/unknown-keyid.dsse.json",
                Reason::KeyUnknown,
            ),
            (
                "edge-activation-receipt/invalid/wrong-purpose-key.dsse.json",
                Reason::KeyPurposeMismatch,
            ),
            (
                "edge-activation-receipt/invalid/bad-signature.dsse.json",
                Reason::SignatureInvalid,
            ),
            (
                "edge-activation-receipt/invalid/duplicate-member.dsse.json",
                Reason::PayloadJsonInvalid,
            ),
            (
                "edge-activation-receipt/invalid/unknown-field.dsse.json",
                Reason::SchemaInvalid,
            ),
            (
                "edge-activation-receipt/invalid/wrong-device-binding.dsse.json",
                Reason::DeviceBindingMismatch,
            ),
            (
                "edge-activation-receipt/invalid/wrong-device-id.dsse.json",
                Reason::DeviceIdMismatch,
            ),
            (
                "edge-activation-receipt/invalid/wrong-tenant.dsse.json",
                Reason::TenantMismatch,
            ),
            (
                "edge-activation-receipt/invalid/expired.dsse.json",
                Reason::Expired,
            ),
            (
                "edge-activation-receipt/invalid/not-yet-valid.dsse.json",
                Reason::NotYetValid,
            ),
            (LIFECYCLE, Reason::PayloadTypeMismatch),
        ] {
            let err = hand_over_activation_receipt(&trust, &fixture(rel), &target, FIXTURE_NOW)
                .unwrap_err();
            assert_eq!(
                err,
                HandoffError::Rejected(BTreeSet::from([reason])),
                "{rel}"
            );
            assert!(!target.exists(), "{rel} was written");
        }
    }

    #[test]
    fn a_lifecycle_statement_lands_verbatim_for_root_to_verify() {
        let (root, _) = fixture_trust(BUNDLE);
        let target = root.path().join("state/lifecycle-request.dsse");
        let bytes = fixture(LIFECYCLE);
        let handed = hand_over_lifecycle_request(&bytes, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert_eq!(mode(&target), 0o600);
        assert_eq!(
            handed.statement_digest,
            Envelope::parse(&bytes).unwrap().statement_digest()
        );
        // The agent is not this statement's verifier (statements.json):
        // a bad signature is root's to refuse.
        let forged = fixture("device-lifecycle/invalid/bad-signature.dsse.json");
        assert!(hand_over_lifecycle_request(&forged, &target).is_ok());
    }

    #[test]
    fn a_lifecycle_request_must_be_a_lifecycle_envelope_root_can_read() {
        let (root, _) = fixture_trust(BUNDLE);
        let target = root.path().join("state/lifecycle-request.dsse");
        assert_eq!(
            hand_over_lifecycle_request(&fixture(RECEIPT), &target).unwrap_err(),
            HandoffError::Rejected(BTreeSet::from([Reason::PayloadTypeMismatch]))
        );
        assert_eq!(
            hand_over_lifecycle_request(
                &fixture("device-lifecycle/invalid/two-signatures.dsse.json"),
                &target
            )
            .unwrap_err(),
            HandoffError::Rejected(BTreeSet::from([Reason::EnvelopeInvalid]))
        );
        let mut oversize = fixture(LIFECYCLE);
        oversize.resize(MAX_HANDOFF_BYTES + 1, b' ');
        assert_eq!(
            hand_over_lifecycle_request(&oversize, &target).unwrap_err(),
            HandoffError::TooLarge(MAX_HANDOFF_BYTES + 1)
        );
        assert!(!target.exists());
    }

    #[test]
    fn the_statement_travels_as_a_string_and_results_name_their_reasons() {
        assert_eq!(
            statement_param(&json!({ "statement": { "payloadType": "x" } })).unwrap_err(),
            HandoffError::MissingStatement
        );
        assert_eq!(
            statement_param(&json!({ "statement": "{}" })).unwrap(),
            b"{}"
        );

        let (ok, details, error) = respond(
            "lifecycle_request",
            Err(HandoffError::Rejected(BTreeSet::from([
                Reason::PayloadTypeMismatch,
            ]))),
        );
        assert!(!ok);
        assert_eq!(details["reasons"], json!(["payload-type-mismatch"]));
        assert!(error.unwrap().contains("payload-type-mismatch"));
        let (ok, details, error) = respond(
            "activation_receipt",
            Ok(Handed {
                statement_digest: "ab".repeat(32),
                path: PathBuf::from("/x"),
            }),
        );
        assert!(ok && error.is_none());
        assert_eq!(details["statement_digest"]["sha256"], "ab".repeat(32));
    }
}
