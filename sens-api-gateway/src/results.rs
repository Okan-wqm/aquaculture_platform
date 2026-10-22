//! Republishing root's typed results to the cloud (ADR-048 DEC-27, contract
//! `channels.json result_telemetry`).
//!
//! Root's workers (installer, update worker, lockdown, health gate, time and
//! data-unlock helpers) write one `suderra.result.v1` document per file to
//! `/run/suderra/results` (`<seq, 16 digits>-<kind>.json`, `volatile-` prefixed
//! while `/data` is not available). A technician's SSH session used to be the
//! only place those results went, and lockdown ends that session: the cloud had
//! no record of an install, an update, a rollback or a lockdown. The agent
//! publishes them on `tenants/{tenant_id}/devices/{device_id}/results`, QoS 1,
//! not retained, one document per message, **byte for byte what root wrote**: it
//! parses a file only to check that it is a result document (the type, and a
//! `seq` and `kind` that agree with the file name) and republishes the bytes it
//! read. Results are unsigned observations; the cloud stores them as
//! device-reported evidence, never as authority.
//!
//! Delivery. A result is published in `seq` order every few seconds while the
//! broker connection is up and until the broker acknowledged THAT publish
//! (`mqtt_acks`); the highest acknowledged `seq` is kept in
//! `$DATA/state/results-cursor.json`, so a restart does not republish what the
//! broker already has. Anything not acknowledged is simply published again: the
//! cloud deduplicates on `(device_id, seq)`.
//!
//! Volatile results (`volatile-<seq>-<kind>.json`, written while `/data` is not
//! available) are numbered by a per-boot counter that restarts at 1, so their
//! `seq` says nothing about their order among the persistent ones: they never
//! move the cursor, go after the persistent results, and are remembered as
//! acknowledged by name for the life of the process.

use std::collections::HashSet;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::mqtt_acks::AckError;
use crate::shared_io::atomic_json_sidecar::{AtomicJsonWriteError, write_atomic_json_owner_only};

/// `schemas/result.schema.json` `_type`.
pub const RESULT_TYPE: &str = "suderra.result.v1";
/// A result document is a few hundred bytes (`detail` is at most 512); the
/// reader takes no more than this from a file.
pub const MAX_RESULT_BYTES: u64 = 16 * 1024;
/// `common.schema.json` `sequence` upper bound: the largest integer every JSON
/// consumer reads exactly.
const MAX_SEQ: u64 = 9_007_199_254_740_991;
/// How often the directory is read and pending results are published.
pub const PUBLISH_INTERVAL: Duration = Duration::from_secs(5);
/// How long one publish waits for the broker's acknowledgement.
pub const ACK_WAIT: Duration = Duration::from_secs(10);

/// A result file name taken apart (`channels.json result_telemetry
/// .file_name_pattern`: `^(volatile-)?[0-9]{16}-[a-z0-9]+(-[a-z0-9]+)*\.json$`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultName {
    pub volatile: bool,
    pub seq: u64,
    pub kind: String,
}

/// Take a file name apart, or `None` when it is not a result file name.
pub fn parse_name(name: &str) -> Option<ResultName> {
    let stem = name.strip_suffix(".json")?;
    let (volatile, rest) = match stem.strip_prefix("volatile-") {
        Some(rest) => (true, rest),
        None => (false, stem),
    };
    let (digits, kind) = rest.split_at_checked(16)?;
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let kind = kind.strip_prefix('-')?;
    let well_formed = !kind.is_empty()
        && kind.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if !well_formed {
        return None;
    }
    let seq: u64 = digits.parse().ok()?;
    if !(1..=MAX_SEQ).contains(&seq) {
        return None;
    }
    Some(ResultName {
        volatile,
        seq,
        kind: kind.to_owned(),
    })
}

/// A result file the agent will publish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingResult {
    pub name: String,
    pub seq: u64,
    pub volatile: bool,
    /// Exactly the bytes root wrote.
    pub bytes: Vec<u8>,
}

/// Why a file in the results directory is not published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Skip {
    /// Not a regular file, or larger than [`MAX_RESULT_BYTES`], or unreadable.
    Unreadable,
    /// Not a `suderra.result.v1` document that agrees with its file name.
    NotAResult(&'static str),
}

/// What a directory scan found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Scan {
    /// Publishable results: persistent ones by `seq`, then volatile ones by `seq`.
    pub results: Vec<PendingResult>,
    /// Files that look like results by name and are not publishable.
    pub skipped: Vec<(String, Skip)>,
}

/// Check that `bytes` is a result document that agrees with its file name:
/// the type, an integer `seq` equal to the name's, a `kind` equal to the name's.
/// Nothing more: root wrote it against the schema, and the cloud stores it as an
/// observation.
fn check_document(bytes: &[u8], name: &ResultName) -> Result<(), &'static str> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "not-json")?;
    let doc = value.as_object().ok_or("not-an-object")?;
    if doc.get("_type").and_then(serde_json::Value::as_str) != Some(RESULT_TYPE) {
        return Err("wrong-type");
    }
    if doc.get("seq").and_then(serde_json::Value::as_u64) != Some(name.seq) {
        return Err("seq-differs-from-the-file-name");
    }
    if doc.get("kind").and_then(serde_json::Value::as_str) != Some(name.kind.as_str()) {
        return Err("kind-differs-from-the-file-name");
    }
    Ok(())
}

fn read_result(path: &Path) -> Result<Vec<u8>, Skip> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| Skip::Unreadable)?;
    if !metadata.is_file() || metadata.len() > MAX_RESULT_BYTES {
        return Err(Skip::Unreadable);
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_RESULT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| Skip::Unreadable)?;
    if bytes.len() as u64 > MAX_RESULT_BYTES {
        return Err(Skip::Unreadable);
    }
    Ok(bytes)
}

/// Read the results directory. A directory that is not there is an empty scan:
/// root has written nothing yet.
pub fn scan(dir: &Path) -> Scan {
    let mut scan = Scan::default();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return scan;
    };
    for entry in entries.flatten() {
        let Some(file_name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(name) = parse_name(&file_name) else {
            continue;
        };
        let outcome = read_result(&entry.path()).and_then(|bytes| {
            check_document(&bytes, &name)
                .map(|()| bytes)
                .map_err(Skip::NotAResult)
        });
        match outcome {
            Ok(bytes) => scan.results.push(PendingResult {
                name: file_name,
                seq: name.seq,
                volatile: name.volatile,
                bytes,
            }),
            Err(skip) => scan.skipped.push((file_name, skip)),
        }
    }
    scan.results.sort_by_key(|r| (r.volatile, r.seq));
    scan.skipped.sort_by(|a, b| a.0.cmp(&b.0));
    scan
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorDocument {
    acknowledged_seq: u64,
}

/// The highest persistent `seq` the broker acknowledged, kept across restarts.
pub struct ResultCursor {
    path: PathBuf,
    acknowledged: u64,
}

impl ResultCursor {
    /// Load the cursor. An absent file is `0`. An unreadable or corrupt one is
    /// `0` too, and says so: the worst outcome of starting over is that results
    /// the broker already has are published once more, which the cloud
    /// deduplicates on `(device_id, seq)`.
    pub fn load(path: PathBuf) -> Self {
        let acknowledged = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<CursorDocument>(&bytes) {
                Ok(doc) => doc.acknowledged_seq,
                Err(e) => {
                    warn!(
                        "result cursor {} is corrupt ({e}): publishing from the start",
                        path.display()
                    );
                    0
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => {
                warn!(
                    "result cursor {} is unreadable ({e}): publishing from the start",
                    path.display()
                );
                0
            }
        };
        Self { path, acknowledged }
    }

    pub fn acknowledged(&self) -> u64 {
        self.acknowledged
    }

    /// Move the cursor forward, durably. It never moves back.
    pub fn advance(&mut self, seq: u64) -> Result<(), AtomicJsonWriteError> {
        if seq <= self.acknowledged {
            return Ok(());
        }
        write_atomic_json_owner_only(
            &self.path,
            &CursorDocument {
                acknowledged_seq: seq,
            },
        )?;
        self.acknowledged = seq;
        Ok(())
    }
}

/// Where results go: the broker, as the publisher sees it.
#[async_trait]
pub trait ResultSink: Send + Sync {
    /// Whether the broker connection is up.
    fn is_connected(&self) -> bool;

    /// Publish and wait for the broker's acknowledgement of exactly this publish.
    async fn publish_acknowledged(
        &self,
        topic: &str,
        payload: Vec<u8>,
        within: Duration,
    ) -> Result<(), AckError>;
}

/// What one pass over the directory did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass {
    /// Results the broker acknowledged in this pass.
    pub acknowledged: usize,
    /// The pass stopped at a result the broker did not acknowledge.
    pub stopped: bool,
}

/// Publishes root's results.
pub struct ResultPublisher<S: ResultSink> {
    dir: PathBuf,
    topic: String,
    cursor: ResultCursor,
    sink: Arc<S>,
    ack_wait: Duration,
    /// Volatile results the broker acknowledged (their `seq` cannot say).
    acknowledged_volatile: HashSet<String>,
    /// Files already reported as unpublishable, so a journal says it once.
    reported: HashSet<String>,
}

impl<S: ResultSink> ResultPublisher<S> {
    pub fn new(
        dir: PathBuf,
        topic: String,
        cursor: ResultCursor,
        sink: Arc<S>,
        ack_wait: Duration,
    ) -> Self {
        Self {
            dir,
            topic,
            cursor,
            sink,
            ack_wait,
            acknowledged_volatile: HashSet::new(),
            reported: HashSet::new(),
        }
    }

    /// The topic of a device's results (`channels.json result_telemetry.topic`).
    pub fn topic_for(tenant_id: &str, device_id: &str) -> String {
        format!("tenants/{tenant_id}/devices/{device_id}/results")
    }

    #[cfg(test)]
    pub fn cursor(&self) -> &ResultCursor {
        &self.cursor
    }

    /// One pass: publish, in order, every result the broker has not
    /// acknowledged, and stop at the first one it does not (order matters: the
    /// cursor is the highest acknowledged `seq`).
    pub async fn publish_pending(&mut self) -> Pass {
        let mut pass = Pass::default();
        if !self.sink.is_connected() {
            return pass;
        }
        let scan = scan(&self.dir);
        for (name, skip) in &scan.skipped {
            if self.reported.insert(name.clone()) {
                warn!("result file {name} is not published: {skip:?}");
            }
        }
        for result in scan.results {
            let done = if result.volatile {
                self.acknowledged_volatile.contains(&result.name)
            } else {
                result.seq <= self.cursor.acknowledged()
            };
            if done {
                continue;
            }
            match self
                .sink
                .publish_acknowledged(&self.topic, result.bytes.clone(), self.ack_wait)
                .await
            {
                Ok(()) => {
                    pass.acknowledged += 1;
                    if result.volatile {
                        self.acknowledged_volatile.insert(result.name.clone());
                    } else if let Err(e) = self.cursor.advance(result.seq) {
                        warn!(
                            "result {} was acknowledged but the cursor could not be written \
                             ({e}): it is published again after a restart",
                            result.name
                        );
                    }
                    debug!("result {} acknowledged by the broker", result.name);
                }
                Err(e) => {
                    info!("result {} not acknowledged yet: {e}", result.name);
                    pass.stopped = true;
                    break;
                }
            }
        }
        pass
    }

    /// Publish for as long as the future is polled (the caller ends it with the
    /// shutdown coordinator): one pass every [`PUBLISH_INTERVAL`].
    pub async fn run(mut self) {
        let mut tick = tokio::time::interval(PUBLISH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let pass = self.publish_pending().await;
            if pass.acknowledged > 0 {
                info!(
                    "published {} result(s); the broker has acknowledged up to seq {}",
                    pass.acknowledged,
                    self.cursor.acknowledged()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const CONTRACT: &str = "../contracts/suderra-edge/v1";
    /// Any name: the agent's paths own the real one.
    const CURSOR_FILE: &str = "cursor.json";

    fn doc(seq: u64, kind: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "_type": RESULT_TYPE, "seq": seq, "kind": kind, "outcome": "ok",
            "occurred_at": "2026-10-22T12:00:00Z", "time_state": "synced-nts",
            "board_profile": "qemu-x86_64", "os_version": "0.1.0",
        }))
        .expect("serializes")
    }

    fn name(seq: u64, kind: &str, volatile: bool) -> String {
        let prefix = if volatile { "volatile-" } else { "" };
        format!("{prefix}{seq:016}-{kind}.json")
    }

    fn put(dir: &Path, seq: u64, kind: &str, volatile: bool) {
        std::fs::write(dir.join(name(seq, kind, volatile)), doc(seq, kind)).expect("write");
    }

    /// The contract's pattern and the parser agree on a table of names, the
    /// pattern being the contract's own text.
    #[test]
    fn the_name_parser_is_the_contract_s_pattern() {
        let channels: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{CONTRACT}/channels.json")).expect("channels.json"),
        )
        .expect("JSON");
        let result = &channels["result_telemetry"];
        let pattern = regex::Regex::new(result["file_name_pattern"].as_str().expect("a pattern"))
            .expect("the contract's pattern compiles");
        assert_eq!(
            result["topic"],
            "tenants/{tenant_id}/devices/{device_id}/results"
        );
        assert_eq!(result["qos"], 1);
        assert_eq!(result["retain"], false);
        for candidate in [
            "0000000000000001-edge-install.json",
            "volatile-0000000000000001-data-unlock.json",
            "0000000000000042-os-update.json",
            "9007199254740991-lockdown.json",
            "0000000000000000-edge-install.json",
            "9007199254740992-edge-install.json",
            "000000000000001-edge-install.json",
            "00000000000000001-edge-install.json",
            "0000000000000001-.json",
            "0000000000000001-Edge-install.json",
            "0000000000000001-edge--install.json",
            "0000000000000001-edge-install-.json",
            "0000000000000001-edge_install.json",
            "0000000000000001-edge-install.json.tmp",
            "0000000000000001-edge-install",
            "volatile-volatile-0000000000000001-x.json",
            "volatile0000000000000001-x.json",
            ".0000000000000001-x.json",
            "0000000000000001x.json",
            "a000000000000001-x.json",
            "0000000000000001-x.JSON",
            "",
        ] {
            let by_pattern = pattern.is_match(candidate)
                // the schema's `sequence` is at least 1 and at most 2^53 - 1;
                // the pattern only says sixteen digits
                && candidate
                    .trim_start_matches("volatile-")
                    .get(..16)
                    .and_then(|d| d.parse::<u64>().ok())
                    .is_some_and(|seq| (1..=MAX_SEQ).contains(&seq));
            assert_eq!(parse_name(candidate).is_some(), by_pattern, "{candidate:?}");
        }
        let parsed = parse_name("volatile-0000000000000007-site-config.json").expect("a name");
        assert_eq!(
            parsed,
            ResultName {
                volatile: true,
                seq: 7,
                kind: "site-config".into()
            }
        );
    }

    #[test]
    fn the_topic_is_the_contract_s() {
        assert_eq!(
            ResultPublisher::<Sink>::topic_for("t-1", "d-2"),
            "tenants/t-1/devices/d-2/results"
        );
    }

    #[test]
    fn every_valid_result_fixture_of_the_contract_passes_the_agent_s_check() {
        let index: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{CONTRACT}/fixtures/index.json")).expect("index"),
        )
        .expect("JSON");
        let mut checked = 0;
        for entry in index["documents"].as_array().expect("documents") {
            let path = entry["path"].as_str().expect("a path");
            if !path.starts_with("result/valid/") || entry["expect"] != "accept" {
                continue;
            }
            let bytes = std::fs::read(format!("{CONTRACT}/fixtures/{path}")).expect("fixture");
            let value: serde_json::Value = serde_json::from_slice(&bytes).expect("JSON");
            let name = ResultName {
                volatile: false,
                seq: value["seq"].as_u64().expect("a seq"),
                kind: value["kind"].as_str().expect("a kind").to_owned(),
            };
            assert_eq!(check_document(&bytes, &name), Ok(()), "{path}");
            checked += 1;
        }
        assert!(checked >= 20, "the contract's result fixtures: {checked}");
    }

    #[test]
    fn a_document_that_disagrees_with_its_file_name_is_not_a_result() {
        let name = parse_name(&name(5, "lockdown", false)).expect("a name");
        assert_eq!(check_document(&doc(5, "lockdown"), &name), Ok(()));
        assert_eq!(
            check_document(&doc(6, "lockdown"), &name),
            Err("seq-differs-from-the-file-name")
        );
        assert_eq!(
            check_document(&doc(5, "edge-update"), &name),
            Err("kind-differs-from-the-file-name")
        );
        assert_eq!(check_document(b"[]", &name), Err("not-an-object"));
        assert_eq!(check_document(b"nope", &name), Err("not-json"));
        assert_eq!(
            check_document(
                br#"{"_type":"suderra.result.v2","seq":5,"kind":"lockdown"}"#,
                &name
            ),
            Err("wrong-type")
        );
        assert_eq!(
            check_document(
                br#"{"_type":"suderra.result.v1","seq":"5","kind":"lockdown"}"#,
                &name
            ),
            Err("seq-differs-from-the-file-name"),
            "a seq that is a string is not the integer the name says"
        );
    }

    #[test]
    fn a_scan_orders_persistent_results_by_seq_then_volatile_ones() {
        let dir = tempfile::tempdir().expect("tempdir");
        put(dir.path(), 11, "edge-update", false);
        put(dir.path(), 3, "edge-install", false);
        put(dir.path(), 1, "data-unlock", true);
        put(dir.path(), 7, "lockdown", false);
        put(dir.path(), 2, "data-unlock", true);
        std::fs::write(dir.path().join("README"), b"not a result").expect("write");
        std::fs::write(dir.path().join(".0000000000000009-x.json.tmp"), b"{}").expect("write");
        let scan = scan(dir.path());
        let order: Vec<&str> = scan.results.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(
            order,
            [
                "0000000000000003-edge-install.json",
                "0000000000000007-lockdown.json",
                "0000000000000011-edge-update.json",
                "volatile-0000000000000001-data-unlock.json",
                "volatile-0000000000000002-data-unlock.json",
            ]
        );
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn the_bytes_published_are_the_bytes_root_wrote() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Not canonical on purpose: member order, spacing, a trailing newline.
        let written = br#"{ "seq": 4, "kind": "lockdown", "_type": "suderra.result.v1",
  "outcome": "ok" }
"#;
        std::fs::write(dir.path().join(name(4, "lockdown", false)), written).expect("write");
        let scan = scan(dir.path());
        assert_eq!(scan.results.len(), 1);
        assert_eq!(scan.results[0].bytes, written);
    }

    #[test]
    fn what_is_not_publishable_is_skipped_and_said() {
        let dir = tempfile::tempdir().expect("tempdir");
        put(dir.path(), 1, "lockdown", false);
        // Disagrees with its name.
        std::fs::write(
            dir.path().join(name(2, "lockdown", false)),
            doc(9, "lockdown"),
        )
        .expect("write");
        // Oversized.
        std::fs::write(
            dir.path().join(name(3, "lockdown", false)),
            vec![b' '; MAX_RESULT_BYTES as usize + 1],
        )
        .expect("write");
        // A symlink is not a regular file, whatever it points at.
        std::os::unix::fs::symlink(
            dir.path().join(name(1, "lockdown", false)),
            dir.path().join(name(4, "lockdown", false)),
        )
        .expect("symlink");
        // A directory with a result's name.
        std::fs::create_dir(dir.path().join(name(5, "lockdown", false))).expect("mkdir");
        let scan = scan(dir.path());
        assert_eq!(scan.results.len(), 1, "{:?}", scan.skipped);
        let skipped: Vec<(&str, &Skip)> =
            scan.skipped.iter().map(|(n, s)| (n.as_str(), s)).collect();
        assert_eq!(
            skipped,
            [
                (
                    "0000000000000002-lockdown.json",
                    &Skip::NotAResult("seq-differs-from-the-file-name")
                ),
                ("0000000000000003-lockdown.json", &Skip::Unreadable),
                ("0000000000000004-lockdown.json", &Skip::Unreadable),
                ("0000000000000005-lockdown.json", &Skip::Unreadable),
            ]
        );
    }

    #[test]
    fn a_missing_directory_is_nothing_to_publish() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(scan(&dir.path().join("absent")), Scan::default());
    }

    #[test]
    fn the_cursor_survives_a_restart_and_never_moves_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("state").join(CURSOR_FILE);
        let mut cursor = ResultCursor::load(path.clone());
        assert_eq!(cursor.acknowledged(), 0, "no file: from the start");
        cursor.advance(5).expect("written");
        cursor.advance(3).expect("a no-op");
        assert_eq!(cursor.acknowledged(), 5);
        assert_eq!(ResultCursor::load(path.clone()).acknowledged(), 5);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "state files are 0600 (DEC-4.6)");
        for corrupt in [
            &b"nonsense"[..],
            b"{}",
            br#"{"acknowledged_seq":-1}"#,
            br#"{"acknowledged_seq":1,"extra":2}"#,
        ] {
            std::fs::write(&path, corrupt).expect("write");
            assert_eq!(
                ResultCursor::load(path.clone()).acknowledged(),
                0,
                "{}",
                String::from_utf8_lossy(corrupt)
            );
        }
    }

    /// A sink the tests control.
    struct Sink {
        connected: Mutex<bool>,
        /// What it does with the next publishes; `Ok` once the script is empty.
        script: Mutex<Vec<Result<(), AckError>>>,
        published: Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl Sink {
        fn new(connected: bool) -> Arc<Self> {
            Arc::new(Self {
                connected: Mutex::new(connected),
                script: Mutex::new(Vec::new()),
                published: Mutex::new(Vec::new()),
            })
        }

        fn names(&self) -> Vec<u64> {
            self.published
                .lock()
                .expect("published")
                .iter()
                .map(|(_, bytes)| {
                    serde_json::from_slice::<serde_json::Value>(bytes).expect("JSON")["seq"]
                        .as_u64()
                        .expect("a seq")
                })
                .collect()
        }
    }

    #[async_trait]
    impl ResultSink for Sink {
        fn is_connected(&self) -> bool {
            *self.connected.lock().expect("connected")
        }

        async fn publish_acknowledged(
            &self,
            topic: &str,
            payload: Vec<u8>,
            _within: Duration,
        ) -> Result<(), AckError> {
            self.published
                .lock()
                .expect("published")
                .push((topic.to_owned(), payload));
            let mut script = self.script.lock().expect("script");
            if script.is_empty() {
                Ok(())
            } else {
                script.remove(0)
            }
        }
    }

    fn publisher(dir: &Path, sink: &Arc<Sink>) -> ResultPublisher<Sink> {
        ResultPublisher::new(
            dir.join("results"),
            "tenants/t/devices/d/results".into(),
            ResultCursor::load(dir.join("state").join(CURSOR_FILE)),
            sink.clone(),
            Duration::from_secs(1),
        )
    }

    fn results_dir(dir: &Path) -> PathBuf {
        let results = dir.join("results");
        std::fs::create_dir_all(&results).expect("mkdir");
        results
    }

    #[tokio::test]
    async fn results_are_published_in_order_once_and_the_cursor_follows_the_acknowledgements() {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = results_dir(dir.path());
        put(&results, 2, "edge-update", false);
        put(&results, 1, "edge-install", false);
        let sink = Sink::new(true);
        let mut publisher = publisher(dir.path(), &sink);

        let pass = publisher.publish_pending().await;
        assert_eq!(
            pass,
            Pass {
                acknowledged: 2,
                stopped: false
            }
        );
        assert_eq!(sink.names(), [1, 2], "seq order");
        assert_eq!(publisher.cursor().acknowledged(), 2);
        assert_eq!(
            sink.published.lock().expect("published")[0].0,
            "tenants/t/devices/d/results"
        );

        // Nothing is published twice.
        assert_eq!(publisher.publish_pending().await, Pass::default());
        assert_eq!(sink.names(), [1, 2]);

        // A new result is published alone.
        put(&results, 3, "lockdown", false);
        assert_eq!(publisher.publish_pending().await.acknowledged, 1);
        assert_eq!(sink.names(), [1, 2, 3]);
    }

    #[tokio::test]
    async fn a_restart_does_not_republish_what_the_broker_acknowledged() {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = results_dir(dir.path());
        put(&results, 1, "edge-install", false);
        put(&results, 2, "edge-update", false);
        let first = Sink::new(true);
        publisher(dir.path(), &first).publish_pending().await;
        assert_eq!(first.names(), [1, 2]);

        put(&results, 3, "lockdown", false);
        let second = Sink::new(true);
        publisher(dir.path(), &second).publish_pending().await;
        assert_eq!(second.names(), [3], "only what the cursor does not cover");
    }

    #[tokio::test]
    async fn a_result_the_broker_did_not_acknowledge_is_published_again_and_blocks_the_ones_after_it()
     {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = results_dir(dir.path());
        put(&results, 1, "edge-install", false);
        put(&results, 2, "edge-update", false);
        put(&results, 3, "lockdown", false);
        let sink = Sink::new(true);
        sink.script
            .lock()
            .expect("script")
            .extend([Ok(()), Err(AckError::Timeout)]);
        let mut publisher = publisher(dir.path(), &sink);

        let pass = publisher.publish_pending().await;
        assert_eq!(
            pass,
            Pass {
                acknowledged: 1,
                stopped: true
            }
        );
        assert_eq!(sink.names(), [1, 2], "3 waits behind 2");
        assert_eq!(publisher.cursor().acknowledged(), 1);

        // The next pass starts at 2.
        let pass = publisher.publish_pending().await;
        assert_eq!(
            pass,
            Pass {
                acknowledged: 2,
                stopped: false
            }
        );
        assert_eq!(sink.names(), [1, 2, 2, 3]);
        assert_eq!(publisher.cursor().acknowledged(), 3);
    }

    #[tokio::test]
    async fn nothing_is_published_while_the_broker_is_not_connected() {
        let dir = tempfile::tempdir().expect("tempdir");
        put(&results_dir(dir.path()), 1, "edge-install", false);
        let sink = Sink::new(false);
        let mut publisher = publisher(dir.path(), &sink);
        assert_eq!(publisher.publish_pending().await, Pass::default());
        assert!(sink.names().is_empty());
        *sink.connected.lock().expect("connected") = true;
        assert_eq!(publisher.publish_pending().await.acknowledged, 1);
    }

    /// Volatile results restart at 1 every boot: they never move the cursor,
    /// and a persistent result that comes later is not hidden by their `seq`.
    #[tokio::test]
    async fn volatile_results_do_not_move_the_cursor_and_are_published_once_per_process() {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = results_dir(dir.path());
        put(&results, 40, "edge-update", false);
        put(&results, 1, "data-unlock", true);
        let sink = Sink::new(true);
        let mut publisher = publisher(dir.path(), &sink);

        assert_eq!(publisher.publish_pending().await.acknowledged, 2);
        assert_eq!(sink.names(), [40, 1], "persistent first, volatile last");
        assert_eq!(
            publisher.cursor().acknowledged(),
            40,
            "volatile seq 1 did not touch it"
        );
        assert_eq!(publisher.publish_pending().await, Pass::default());

        // A volatile result with a LOWER seq than the cursor is still published.
        put(&results, 2, "data-unlock", true);
        assert_eq!(publisher.publish_pending().await.acknowledged, 1);
        assert_eq!(sink.names(), [40, 1, 2]);
    }

    #[tokio::test]
    async fn an_unpublishable_file_never_blocks_the_results_after_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let results = results_dir(dir.path());
        put(&results, 1, "edge-install", false);
        std::fs::write(
            results.join(name(2, "lockdown", false)),
            doc(99, "lockdown"),
        )
        .expect("write");
        put(&results, 3, "edge-update", false);
        let sink = Sink::new(true);
        let mut publisher = publisher(dir.path(), &sink);
        assert_eq!(publisher.publish_pending().await.acknowledged, 2);
        assert_eq!(sink.names(), [1, 3]);
    }

    /// `run` publishes on its first tick and is ended by dropping it (the
    /// shutdown coordinator's way of ending a task).
    #[tokio::test]
    async fn the_run_loop_publishes_on_its_tick_and_ends_when_dropped() {
        let dir = tempfile::tempdir().expect("tempdir");
        put(&results_dir(dir.path()), 1, "edge-install", false);
        let sink = Sink::new(true);
        let publisher = publisher(dir.path(), &sink);
        // The first tick is immediate; the next is PUBLISH_INTERVAL away.
        let _ = tokio::time::timeout(Duration::from_millis(300), publisher.run()).await;
        assert_eq!(sink.names(), [1]);
    }
}
