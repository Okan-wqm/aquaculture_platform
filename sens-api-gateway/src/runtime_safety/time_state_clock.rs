//! `TimeStateClockAuthority` — the clock authority of the Suderra OS profile
//! (ADR-048 DEC-7.3, DEC-7.5; contract `schemas/time-state.schema.json` and
//! `channels.json time`).
//!
//! The agent cannot read `adjtimex` under `ProtectClock`, and a wall clock it
//! reads for itself says nothing about whether anyone disciplined it. Root's
//! time helper knows: it writes `/run/suderra/time-state` from chrony's
//! tracking data and the persisted time floor, at least every
//! [`TIME_STATE_REFRESH_SECS`] seconds. This authority reads that document and
//! nothing else:
//!
//! | document                                                   | the authority says |
//! |------------------------------------------------------------|--------------------|
//! | `synced-nts` or `synced-unauthenticated`, `updated_at` fresh | a wall-clock reading |
//! | `unsynced`                                                  | `Unsynced(ReportedUnsynced)` |
//! | `updated_at` more than [`TIME_STATE_MAX_AGE_SECS`] from this clock, either way | `Unsynced(Stale)` |
//! | absent, unreadable, oversized                               | `Unsynced(Unreadable)` |
//! | not a conforming `suderra.time-state.v1` document           | `Unsynced(NonConforming)` |
//!
//! `synced-unauthenticated` suffices for freshness-dependent actuation because
//! only a signed site policy that marks a plain NTP source produces it and the
//! time floor bounds any rewind (channels.json `time.consumers`).
//!
//! The authority is consumed through [`ClockAuthority`] like every clock in the
//! agent. What it refuses is only what depends on the wall clock: a command
//! envelope's `iat`/`exp` window, an RBAC manifest's validity, an OPC UA write's
//! policy freshness. Local control, safe-state and alarms never ask for the wall
//! clock and run in every state; the agent never exits because the clock is
//! unsynced (DEC-7.5).
//!
//! An OPC UA write is the one local-looking path that is refused while the clock
//! is `unsynced`. That is a decision of DEC-7.5, not an accident: the write comes
//! from a local interface, but its authorization is the RBAC policy's freshness
//! window, which needs a trusted `received_at` (a wall clock anyone can move would
//! pass an expired policy or fail a valid one), and the ADR records it as part of
//! the agent's freshness-dependent actuation. A site that blocks udp/123 loses OPC
//! UA writes (not reads, not scripts, not the HMI) until it has a site NTS server
//! or a signed plain-NTP source.
//!
//! `SystemTime::now()` appears here and nowhere in a freshness decision: this
//! is the one place that compares the helper's `updated_at` with the agent's
//! own clock, which the contract's stale rule requires.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::io::AsyncReadExt;

use super::clock::{ClockAuthority, ClockError, MonotonicAnchor, UnsyncedCause, WallClockReading};
use super::system_clock::SystemClockAuthority;

/// `channels.json time.refresh_seconds`: the helper rewrites the document at
/// least this often.
pub const TIME_STATE_REFRESH_SECS: u64 = 30;
/// `channels.json time.max_age_seconds`: a document whose `updated_at` is
/// further than this from the reader's clock, in either direction, is unsynced.
pub const TIME_STATE_MAX_AGE_SECS: i64 = 120;
/// A conforming document is a few hundred bytes; the reader never takes more
/// than this from a file a root helper writes.
pub const MAX_TIME_STATE_BYTES: u64 = 4096;

const TIME_STATE_TYPE: &str = "suderra.time-state.v1";
/// The schema's `required` list; `additionalProperties` is false, so these are
/// exactly the members of a conforming document.
const TIME_STATE_MEMBERS: [&str; 6] = [
    "_type",
    "state",
    "floor_at",
    "last_sync_at",
    "offset_ms",
    "updated_at",
];
/// The schema bounds `offset_ms` to the integers every JSON consumer reads
/// exactly.
const MAX_OFFSET_MS: i64 = 9_007_199_254_740_991;

/// How a synchronized clock is disciplined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncSource {
    /// Against pinned NTS servers.
    Nts,
    /// Against a site NTP server the signed site policy marked as not
    /// NTS-capable.
    Unauthenticated,
}

/// What a conforming, fresh `synced-*` document claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncedClock {
    pub source: SyncSource,
    /// Instant of the last synchronization chrony reported, Unix seconds.
    pub last_sync_unix_secs: i64,
    /// Last measured offset from the time source, milliseconds.
    pub offset_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum RawState {
    Unsynced,
    SyncedUnauthenticated,
    SyncedNts,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTimeState {
    #[serde(rename = "_type")]
    doc_type: String,
    state: RawState,
    floor_at: String,
    last_sync_at: Option<String>,
    offset_ms: Option<i64>,
    updated_at: String,
}

/// A schema `timestamp`: second precision, a literal `Z`, no fraction, no
/// offset (`common.schema.json`). chrony-style leniency is exactly what the
/// contract rules out, so the shape is checked before the value.
fn parse_timestamp(text: &str) -> Option<i64> {
    let shape_ok = text.len() == 20
        && text.bytes().enumerate().all(|(at, byte)| match at {
            4 | 7 => byte == b'-',
            10 => byte == b'T',
            13 | 16 => byte == b':',
            19 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        });
    if !shape_ok {
        return None;
    }
    chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%SZ")
        .ok()
        .map(|t| t.and_utc().timestamp())
}

/// Decide what a time-state document says at `now_unix_secs` (the reader's own
/// clock). `Ok` only for a conforming, fresh, synchronized document; every
/// other input is `Err(cause)`, the cause an operator reads and a consumer
/// treats alike as "unsynced" (channels.json `time.stale_rule`).
pub fn evaluate_time_state(bytes: &[u8], now_unix_secs: i64) -> Result<SyncedClock, UnsyncedCause> {
    if bytes.len() as u64 > MAX_TIME_STATE_BYTES {
        return Err(UnsyncedCause::NonConforming);
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| UnsyncedCause::NonConforming)?;
    let members = value.as_object().ok_or(UnsyncedCause::NonConforming)?;
    if members.len() != TIME_STATE_MEMBERS.len()
        || !TIME_STATE_MEMBERS.iter().all(|m| members.contains_key(*m))
    {
        return Err(UnsyncedCause::NonConforming);
    }
    let doc: RawTimeState =
        serde_json::from_value(value).map_err(|_| UnsyncedCause::NonConforming)?;
    if doc.doc_type != TIME_STATE_TYPE {
        return Err(UnsyncedCause::NonConforming);
    }
    parse_timestamp(&doc.floor_at).ok_or(UnsyncedCause::NonConforming)?;
    let updated_at = parse_timestamp(&doc.updated_at).ok_or(UnsyncedCause::NonConforming)?;
    let last_sync = match doc.last_sync_at.as_deref() {
        Some(text) => Some(parse_timestamp(text).ok_or(UnsyncedCause::NonConforming)?),
        None => None,
    };
    if doc
        .offset_ms
        .is_some_and(|offset| !(-MAX_OFFSET_MS..=MAX_OFFSET_MS).contains(&offset))
    {
        return Err(UnsyncedCause::NonConforming);
    }
    // schemas/time-state.schema.json allOf: `unsynced` has a null offset; every
    // synchronized state has an offset and the instant of its last sync.
    let source = match doc.state {
        RawState::Unsynced => {
            if doc.offset_ms.is_some() {
                return Err(UnsyncedCause::NonConforming);
            }
            None
        }
        RawState::SyncedNts => Some(SyncSource::Nts),
        RawState::SyncedUnauthenticated => Some(SyncSource::Unauthenticated),
    };
    let synced = match (source, last_sync, doc.offset_ms) {
        (Some(source), Some(last_sync_unix_secs), Some(offset_ms)) => Some(SyncedClock {
            source,
            last_sync_unix_secs,
            offset_ms,
        }),
        (None, _, _) => None,
        (Some(_), _, _) => return Err(UnsyncedCause::NonConforming),
    };
    if now_unix_secs.abs_diff(updated_at) > TIME_STATE_MAX_AGE_SECS.unsigned_abs() {
        return Err(UnsyncedCause::Stale);
    }
    synced.ok_or(UnsyncedCause::ReportedUnsynced)
}

/// Read at most [`MAX_TIME_STATE_BYTES`] + 1 bytes: one more than the limit is
/// how [`evaluate_time_state`] learns the file was oversized.
async fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(MAX_TIME_STATE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

/// The Suderra OS agent's [`ClockAuthority`].
pub struct TimeStateClockAuthority {
    document: PathBuf,
    monotonic: SystemClockAuthority,
    threshold_secs: u64,
}

impl TimeStateClockAuthority {
    /// `document` is root's `/run/suderra/time-state`
    /// (`AgentPaths::time_state_file`). `threshold_secs` is the configured
    /// `clock.nts_sync_max_skew_secs`, reported to the metric that publishes
    /// it: the contract decides sufficiency by the document's state, so no
    /// second bound is enforced on the age of the last synchronization.
    pub fn new(document: PathBuf, threshold_secs: u64) -> Self {
        Self {
            document,
            monotonic: SystemClockAuthority::with_nts_threshold(threshold_secs),
            threshold_secs,
        }
    }
}

#[async_trait]
impl ClockAuthority for TimeStateClockAuthority {
    fn monotonic_now(&self) -> Result<MonotonicAnchor, ClockError> {
        self.monotonic.monotonic_now()
    }

    async fn trustworthy_wall_clock(&self) -> Result<WallClockReading, ClockError> {
        let system_time = SystemTime::now();
        let now_unix_secs = system_time
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ClockError::PreEpochWallClock)
            .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))?;
        let bytes = read_bounded(&self.document)
            .await
            .map_err(|_| ClockError::Unsynced(UnsyncedCause::Unreadable))?;
        let synced = evaluate_time_state(&bytes, now_unix_secs).map_err(ClockError::Unsynced)?;
        Ok(WallClockReading {
            system_time,
            monotonic_anchor: self.monotonic.monotonic_now()?,
            nts_sync_age_secs: u64::try_from(
                now_unix_secs.saturating_sub(synced.last_sync_unix_secs),
            )
            .unwrap_or(0),
        })
    }

    fn nts_sync_max_skew_secs(&self) -> u64 {
        self.threshold_secs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT: &str = "../contracts/suderra-edge/v1";

    fn fixture(relative: &str) -> Vec<u8> {
        std::fs::read(format!("{CONTRACT}/fixtures/time-state/{relative}"))
            .unwrap_or_else(|e| panic!("contract fixture time-state/{relative}: {e}"))
    }

    fn at(timestamp: &str) -> i64 {
        parse_timestamp(timestamp).expect("a schema timestamp")
    }

    /// The instant the contract's fixtures were written: `updated_at` of every
    /// fixture is one second earlier.
    const FIXTURE_NOW: &str = "2026-10-20T12:00:00Z";

    #[test]
    fn the_constants_are_the_contract_s() {
        let channels: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{CONTRACT}/channels.json")).expect("channels.json"),
        )
        .expect("channels.json is JSON");
        let time = &channels["time"];
        assert_eq!(time["document"], "/run/suderra/time-state");
        assert_eq!(time["refresh_seconds"], TIME_STATE_REFRESH_SECS);
        assert_eq!(time["max_age_seconds"], TIME_STATE_MAX_AGE_SECS);
        let sufficient = |consumer: &str| -> Vec<String> {
            time["consumers"][consumer]["sufficient"]
                .as_array()
                .expect("a sufficient list")
                .iter()
                .map(|s| s.as_str().expect("a state name").to_owned())
                .collect()
        };
        assert_eq!(
            sufficient("agent-fresh-actuation"),
            ["synced-nts", "synced-unauthenticated"]
        );
        assert_eq!(
            time["consumers"]["agent-fresh-actuation"]["refusal"],
            "clock-unsynced"
        );
    }

    #[test]
    fn a_fresh_synced_document_is_a_reading_for_either_source() {
        let now = at(FIXTURE_NOW);
        assert_eq!(
            evaluate_time_state(&fixture("valid/synced-nts.json"), now),
            Ok(SyncedClock {
                source: SyncSource::Nts,
                last_sync_unix_secs: at("2026-10-20T11:58:00Z"),
                offset_ms: -12,
            })
        );
        assert_eq!(
            evaluate_time_state(&fixture("valid/synced-unauthenticated.json"), now),
            Ok(SyncedClock {
                source: SyncSource::Unauthenticated,
                last_sync_unix_secs: at("2026-10-20T11:58:00Z"),
                offset_ms: 40,
            })
        );
    }

    #[test]
    fn the_reported_unsynced_state_is_not_a_reading() {
        assert_eq!(
            evaluate_time_state(&fixture("valid/unsynced.json"), at(FIXTURE_NOW)),
            Err(UnsyncedCause::ReportedUnsynced)
        );
    }

    /// Every fixture the contract's index lists for the document: the accepted
    /// ones are a reading or `unsynced`, every rejected one is non-conforming.
    #[test]
    fn the_contract_s_fixtures_decide_as_the_index_says() {
        let index: serde_json::Value = serde_json::from_slice(
            &std::fs::read(format!("{CONTRACT}/fixtures/index.json")).expect("fixtures index"),
        )
        .expect("the index is JSON");
        let (mut accepted, mut rejected) = (0, 0);
        for entry in index["runtime_documents"].as_array().expect("documents") {
            let path = entry["path"].as_str().expect("a path");
            let Some(name) = path.strip_prefix("time-state/") else {
                continue;
            };
            let outcome = evaluate_time_state(&fixture(name), at(FIXTURE_NOW));
            match entry["expect"].as_str().expect("an expectation") {
                "accept" => {
                    assert!(
                        matches!(outcome, Ok(_) | Err(UnsyncedCause::ReportedUnsynced)),
                        "{path}: {outcome:?}"
                    );
                    accepted += 1;
                }
                "reject" => {
                    assert_eq!(outcome, Err(UnsyncedCause::NonConforming), "{path}");
                    rejected += 1;
                }
                other => panic!("{path}: unknown expectation {other}"),
            }
        }
        assert_eq!(
            (accepted, rejected),
            (3, 4),
            "the contract's time-state fixtures"
        );
    }

    fn document(mutate: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let mut value: serde_json::Value =
            serde_json::from_slice(&fixture("valid/synced-nts.json")).expect("fixture JSON");
        mutate(&mut value);
        serde_json::to_vec(&value).expect("serializes")
    }

    #[test]
    fn a_document_that_breaks_the_schema_in_any_member_is_non_conforming() {
        let now = at(FIXTURE_NOW);
        type Mutation = Box<dyn FnOnce(&mut serde_json::Value)>;
        let cases: Vec<(&str, Mutation)> = vec![
            ("an extra member", Box::new(|v| v["extra"] = 1.into())),
            (
                "a missing member",
                Box::new(|v| {
                    v.as_object_mut().expect("object").remove("offset_ms");
                }),
            ),
            (
                "another document type",
                Box::new(|v| v["_type"] = "suderra.time-state.v2".into()),
            ),
            (
                "an offset that is not an integer",
                Box::new(|v| v["offset_ms"] = 1.5.into()),
            ),
            (
                "an offset beyond the safe integers",
                Box::new(|v| v["offset_ms"] = 9_007_199_254_740_992_i64.into()),
            ),
            (
                "a timestamp with an offset",
                Box::new(|v| v["updated_at"] = "2026-10-20T11:59:59+00:00".into()),
            ),
            (
                "a timestamp that is not padded",
                Box::new(|v| v["floor_at"] = "2026-10-2T00:00:00Z".into()),
            ),
            (
                "a timestamp that is no date",
                Box::new(|v| v["last_sync_at"] = "2026-13-40T00:00:00Z".into()),
            ),
            (
                "a floor that is no timestamp",
                Box::new(|v| v["floor_at"] = 5.into()),
            ),
        ];
        for (what, mutate) in cases {
            assert_eq!(
                evaluate_time_state(&document(mutate), now),
                Err(UnsyncedCause::NonConforming),
                "{what}"
            );
        }
        for bytes in [&b""[..], b"not json", b"[]", b"null", b"{}"] {
            assert_eq!(
                evaluate_time_state(bytes, now),
                Err(UnsyncedCause::NonConforming),
                "{bytes:?}"
            );
        }
        let oversized = vec![b' '; MAX_TIME_STATE_BYTES as usize + 1];
        assert_eq!(
            evaluate_time_state(&oversized, now),
            Err(UnsyncedCause::NonConforming)
        );
    }

    /// channels.json `time.stale_rule`: more than `max_age_seconds` from the
    /// reader's clock, in EITHER direction, is unsynced.
    #[test]
    fn a_document_further_than_the_max_age_from_this_clock_is_stale_either_way() {
        let updated = at("2026-10-20T11:59:59Z");
        let bytes = fixture("valid/synced-nts.json");
        for (offset, expected_fresh) in [
            (0, true),
            (TIME_STATE_MAX_AGE_SECS, true),
            (TIME_STATE_MAX_AGE_SECS + 1, false),
            (-TIME_STATE_MAX_AGE_SECS, true),
            (-TIME_STATE_MAX_AGE_SECS - 1, false),
        ] {
            let result = evaluate_time_state(&bytes, updated + offset);
            if expected_fresh {
                assert!(result.is_ok(), "offset {offset}: {result:?}");
            } else {
                assert_eq!(result, Err(UnsyncedCause::Stale), "offset {offset}");
            }
        }
    }

    /// A stale `unsynced` document is reported stale: the helper is not
    /// writing, which is the more useful thing to read in the journal.
    #[test]
    fn staleness_is_reported_before_the_state() {
        let updated = at("2026-10-20T11:59:59Z");
        assert_eq!(
            evaluate_time_state(&fixture("valid/unsynced.json"), updated + 500),
            Err(UnsyncedCause::Stale)
        );
    }

    fn write_state(dir: &Path, state: &str, updated_at: i64) -> PathBuf {
        let path = dir.join("time-state");
        let stamp = |secs: i64| {
            chrono::DateTime::from_timestamp(secs, 0)
                .expect("a timestamp")
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        };
        let synced = state != "unsynced";
        let doc = serde_json::json!({
            "_type": TIME_STATE_TYPE,
            "state": state,
            "floor_at": stamp(updated_at - 86_400),
            "last_sync_at": synced.then(|| stamp(updated_at - 60)),
            "offset_ms": synced.then_some(3),
            "updated_at": stamp(updated_at),
        });
        std::fs::write(&path, serde_json::to_vec(&doc).expect("serializes")).expect("write");
        path
    }

    fn now_unix() -> i64 {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("after the epoch")
                .as_secs(),
        )
        .expect("fits")
    }

    #[tokio::test]
    async fn the_authority_reads_the_document_on_every_call() {
        let dir = tempfile::tempdir().expect("tempdir");
        let authority = TimeStateClockAuthority::new(dir.path().join("time-state"), 3600);

        // Absent: unsynced, and the agent goes on (the error is a value).
        assert_eq!(
            authority.trustworthy_wall_clock().await.unwrap_err(),
            ClockError::Unsynced(UnsyncedCause::Unreadable)
        );

        write_state(dir.path(), "unsynced", now_unix());
        assert_eq!(
            authority.trustworthy_wall_clock().await.unwrap_err(),
            ClockError::Unsynced(UnsyncedCause::ReportedUnsynced)
        );

        write_state(dir.path(), "synced-nts", now_unix());
        let reading = authority
            .trustworthy_wall_clock()
            .await
            .expect("a synchronized, fresh document is a reading");
        assert!(
            (59..=62).contains(&reading.nts_sync_age_secs),
            "{reading:?}"
        );

        write_state(dir.path(), "synced-unauthenticated", now_unix());
        assert!(authority.trustworthy_wall_clock().await.is_ok());

        write_state(dir.path(), "synced-nts", now_unix() - 600);
        assert_eq!(
            authority.trustworthy_wall_clock().await.unwrap_err(),
            ClockError::Unsynced(UnsyncedCause::Stale)
        );
    }

    /// DEC-7.5: monotonic time (deadlines, TTLs, the comms-loss supervisor) is
    /// local control. It never asks the document, so it works in every state.
    #[tokio::test]
    async fn the_monotonic_clock_does_not_depend_on_the_document() {
        let dir = tempfile::tempdir().expect("tempdir");
        let authority = TimeStateClockAuthority::new(dir.path().join("absent"), 3600);
        let first = authority.monotonic_now().expect("monotonic");
        let second = authority.monotonic_now().expect("monotonic");
        assert!(second.nanos_since_process_epoch() >= first.nanos_since_process_epoch());
        assert!(
            crate::runtime_safety::clock::MonotonicDeadline::from_duration_now(
                std::time::Duration::from_secs(5),
                &authority,
            )
            .await
            .is_ok(),
            "a forced output's TTL needs no wall clock"
        );
    }

    #[tokio::test]
    async fn an_oversized_file_is_read_bounded_and_unsynced() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("time-state");
        std::fs::write(&path, vec![b' '; 1 << 20]).expect("write");
        let authority = TimeStateClockAuthority::new(path, 3600);
        assert_eq!(
            authority.trustworthy_wall_clock().await.unwrap_err(),
            ClockError::Unsynced(UnsyncedCause::NonConforming)
        );
    }
}
