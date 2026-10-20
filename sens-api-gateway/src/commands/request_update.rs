//! The agent's only update path on Suderra OS: a request to root (ADR-048
//! DEC-2.3). Suderra OS profile only.
//!
//! The OS manages every update (feature `os-managed-updates`): the agent
//! writes no binary, boot configuration or bootloader flag. What it can do
//! is carry a cloud-signed statement from the command plane into the update
//! request directory (mutable-state.json `/var/lib/suderra/update-requests`),
//! where root's request worker copies it, verifies it against the keys
//! pinned in the OS image, applies its own sequence and rollback floors and
//! installs through the one installer (DEC-2.2, DEC-2.4). Root does not rely
//! on anything the agent decided.
//!
//! The agent checks only what makes the file one root can act on: the size
//! root reads, the DSSE envelope form and a payloadType of a statement the
//! update channel carries. In contract 1.x that is the release statement
//! (`suderra.edge-release.v1`, the statement root's `edge-update` result
//! verifies). The request is written under its statement digest, through a
//! temporary name and `rename(2)`, so a repeated request replaces itself
//! and root never sees a half-written file.

use std::path::Path;

use serde_json::Value;

use super::CommandHandler;
use super::root_handoff::{
    Handed, HandoffError, envelope_of, respond, statement_param, write_for_root,
};
use crate::edge_contract::registry::StatementType;
use crate::paths::AgentPaths;

/// Statements the update request channel carries (contract 1.x).
pub(crate) const UPDATE_REQUEST_STATEMENTS: &[StatementType] = &[StatementType::EdgeRelease];

/// Writes an update request for root into `dir` as
/// `<statement digest>.dsse`.
pub(crate) fn hand_over_update_request(
    statement: &[u8],
    dir: &Path,
) -> Result<Handed, HandoffError> {
    let env = envelope_of(statement, UPDATE_REQUEST_STATEMENTS)?;
    let digest = env.statement_digest();
    write_for_root(&dir.join(format!("{digest}.dsse")), statement, digest)
}

impl CommandHandler {
    /// `request_update` — hand a cloud-signed update statement to root
    /// (ADR-048 DEC-2.3).
    pub(super) async fn cmd_request_update(&self, params: &Value) -> (bool, Value, Option<String>) {
        let outcome = statement_param(params).and_then(|statement| {
            hand_over_update_request(statement, &AgentPaths::current().update_requests_dir())
        });
        respond("request_update", outcome)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

    use std::collections::BTreeSet;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::edge_contract::dsse::Envelope;
    use crate::edge_contract::registry::Reason;
    use crate::trust_anchors::test_support::fixture;

    const RELEASE: &str = "edge-release/valid/revpi-connect4-aarch64-1.6.0.dsse.json";

    #[test]
    fn a_release_statement_lands_under_its_digest_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = fixture(RELEASE);
        let handed = hand_over_update_request(&bytes, dir.path()).unwrap();
        let digest = Envelope::parse(&bytes).unwrap().statement_digest();
        assert_eq!(handed.statement_digest, digest);
        assert_eq!(handed.path, dir.path().join(format!("{digest}.dsse")));
        assert_eq!(std::fs::read(&handed.path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&handed.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        // The only entry: no temporary file is left behind, and a repeated
        // request replaces itself.
        hand_over_update_request(&bytes, dir.path()).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from(format!("{digest}.dsse"))]
        );
    }

    #[test]
    fn only_a_statement_the_update_channel_carries_is_handed_over() {
        let dir = tempfile::tempdir().unwrap();
        for rel in [
            "edge-activation-receipt/valid/revpi-connect4.dsse.json",
            "device-lifecycle/valid/enter-maintenance-reprovision.dsse.json",
            "trust-anchors/valid/bundle-seq-1.dsse.json",
            "site-config/valid/revpi-connect4-seq-2.dsse.json",
            "edge-provisioning/valid/revpi-connect4-first.dsse.json",
        ] {
            assert_eq!(
                hand_over_update_request(&fixture(rel), dir.path()).unwrap_err(),
                HandoffError::Rejected(BTreeSet::from([Reason::PayloadTypeMismatch])),
                "{rel}"
            );
        }
        assert_eq!(
            hand_over_update_request(
                &fixture("edge-release/invalid/two-signatures.dsse.json"),
                dir.path()
            )
            .unwrap_err(),
            HandoffError::Rejected(BTreeSet::from([Reason::EnvelopeInvalid]))
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
