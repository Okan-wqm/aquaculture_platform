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
//!
//! The directory is bounded: it shares the agent's data volume with the
//! offline queue and the secrets, and until root consumes a request it
//! stays there. At most [`MAX_PENDING_UPDATE_REQUESTS`] entries and
//! [`MAX_PENDING_UPDATE_REQUEST_BYTES`] bytes are pending at once; a new
//! request beyond that is refused (`update-requests-backlog`) and nothing
//! is written. Every entry counts, a temporary file a crashed agent left
//! behind included, except that such a stale temporary file (a dot-file
//! of another process) is removed first: the agent is the directory's only
//! writer and root never reads dot-files.

use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

use super::CommandHandler;
use super::root_handoff::{
    Handed, HandoffError, MAX_HANDOFF_BYTES, envelope_of, respond, statement_param, write_for_root,
};
use crate::edge_contract::registry::StatementType;
use crate::paths::AgentPaths;

/// Statements the update request channel carries (contract 1.x).
pub(crate) const UPDATE_REQUEST_STATEMENTS: &[StatementType] = &[StatementType::EdgeRelease];

/// Most update requests pending for root at once.
pub(crate) const MAX_PENDING_UPDATE_REQUESTS: usize = 4;

/// Most bytes pending for root at once: every request is at most
/// [`MAX_HANDOFF_BYTES`].
pub(crate) const MAX_PENDING_UPDATE_REQUEST_BYTES: u64 = {
    let bytes = MAX_PENDING_UPDATE_REQUESTS.saturating_mul(MAX_HANDOFF_BYTES);
    // usize is at most 64 bits on every supported target.
    bytes as u64
};

/// Serializes the count-then-write of concurrent hand-overs in this
/// process, so two of them cannot both pass the bound.
static REQUEST_DIR_LOCK: Mutex<()> = Mutex::new(());

/// Whether `name` is a temporary file another process left behind
/// (`.<name>.tmp-<pid>`, the atomic writer's form).
fn is_stale_temporary(name: &str) -> bool {
    let own = format!(".tmp-{}", std::process::id());
    name.starts_with('.') && name.contains(".tmp-") && !name.ends_with(&own)
}

/// Entries pending in `dir` other than `target`, and their bytes, after
/// removing stale temporary files.
fn pending_requests(dir: &Path, target: &Path) -> Result<(usize, u64), HandoffError> {
    let io = |e: std::io::Error| HandoffError::Write {
        path: dir.to_path_buf(),
        reason: e.to_string(),
    };
    let listing = match std::fs::read_dir(dir) {
        Ok(listing) => listing,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(io(e)),
    };
    let mut count = 0usize;
    let mut bytes = 0u64;
    for item in listing {
        let item = item.map_err(io)?;
        let path = item.path();
        if path == target {
            continue;
        }
        if item.file_name().to_str().is_some_and(is_stale_temporary) {
            std::fs::remove_file(&path).map_err(io)?;
            continue;
        }
        count += 1;
        bytes = bytes.saturating_add(item.metadata().map_err(io)?.len());
    }
    Ok((count, bytes))
}

/// Writes an update request for root into `dir` as
/// `<statement digest>.dsse`, unless root has not yet consumed the
/// requests already pending (the directory bound).
pub(crate) fn hand_over_update_request(
    statement: &[u8],
    dir: &Path,
) -> Result<Handed, HandoffError> {
    let env = envelope_of(statement, UPDATE_REQUEST_STATEMENTS)?;
    let digest = env.statement_digest();
    let target = dir.join(format!("{digest}.dsse"));
    // A poisoned lock only means another hand-over panicked; the count is
    // re-read from the directory, so its state is still sound.
    let _serialized = REQUEST_DIR_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (pending, bytes) = pending_requests(dir, &target)?;
    let new_bytes = u64::try_from(statement.len()).unwrap_or(u64::MAX);
    if pending >= MAX_PENDING_UPDATE_REQUESTS
        || bytes.saturating_add(new_bytes) > MAX_PENDING_UPDATE_REQUEST_BYTES
    {
        return Err(HandoffError::Backlog { pending, bytes });
    }
    write_for_root(&target, statement, digest)
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

    fn names(dir: &Path) -> BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[test]
    fn the_request_directory_is_bounded_and_a_full_one_gets_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = fixture(RELEASE);
        // Requests root has not consumed yet.
        for i in 0..MAX_PENDING_UPDATE_REQUESTS {
            std::fs::write(dir.path().join(format!("{i:064x}.dsse")), b"pending").unwrap();
        }
        let before = names(dir.path());
        let err = hand_over_update_request(&bytes, dir.path()).unwrap_err();
        assert_eq!(
            err,
            HandoffError::Backlog {
                pending: MAX_PENDING_UPDATE_REQUESTS,
                bytes: 7 * MAX_PENDING_UPDATE_REQUESTS as u64,
            }
        );
        assert_eq!(names(dir.path()), before, "nothing is written");
        // Once root drains one, the request lands.
        std::fs::remove_file(dir.path().join(format!("{:064x}.dsse", 0))).unwrap();
        hand_over_update_request(&bytes, dir.path()).unwrap();
        // A repeated request replaces itself even at the bound.
        hand_over_update_request(&bytes, dir.path()).unwrap();
        assert_eq!(names(dir.path()).len(), MAX_PENDING_UPDATE_REQUESTS);
    }

    #[test]
    fn the_byte_bound_holds_with_fewer_files() {
        let dir = tempfile::tempdir().unwrap();
        let big = vec![b'x'; usize::try_from(MAX_PENDING_UPDATE_REQUEST_BYTES).unwrap()];
        std::fs::write(dir.path().join("a.dsse"), &big).unwrap();
        assert!(matches!(
            hand_over_update_request(&fixture(RELEASE), dir.path()),
            Err(HandoffError::Backlog { pending: 1, .. })
        ));
        assert_eq!(names(dir.path()), BTreeSet::from(["a.dsse".to_owned()]));
    }

    #[test]
    fn a_crashed_writers_temporary_file_is_swept_not_counted() {
        let dir = tempfile::tempdir().unwrap();
        let stale = format!(
            ".{:064x}.dsse.tmp-{}",
            1,
            std::process::id().wrapping_add(1)
        );
        std::fs::write(dir.path().join(&stale), b"half").unwrap();
        for i in 1..MAX_PENDING_UPDATE_REQUESTS {
            std::fs::write(dir.path().join(format!("{i:064x}.dsse")), b"pending").unwrap();
        }
        let handed = hand_over_update_request(&fixture(RELEASE), dir.path()).unwrap();
        let left = names(dir.path());
        assert!(!left.contains(&stale));
        assert!(left.contains(handed.path.file_name().unwrap().to_str().unwrap()));
        assert_eq!(left.len(), MAX_PENDING_UPDATE_REQUESTS);
    }
}
