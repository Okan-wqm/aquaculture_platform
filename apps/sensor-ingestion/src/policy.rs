//! ADR-031 NATS-served policy orchestrator for
//! [`crate::ingest_backend::DynamicBackendPolicy`].
//!
//! # Why this module exists
//!
//! `DynamicBackendPolicy` holds the atomic state cell; this module
//! owns the wire I/O that drives it. Splitting the two keeps the
//! state primitive unit-testable without a live NATS broker, while
//! the orchestrator's cold-start + subscriber concerns live behind
//! a single `bootstrap_policy` + `spawn_policy_subscriber` surface.
//!
//! # Cold-start fallback chain (fail-closed)
//!
//! 1. **NATS `policy.ingest_backend.snapshot`** — request-reply with
//!    [`IngestBackendConfig::snapshot_request_retries`] attempts
//!    spaced by the single-attempt timeout. On success the snapshot
//!    is BOTH handed to the caller AND persisted to disk so the next
//!    cold boot has a durable fallback.
//! 2. **Disk fallback** — the last snapshot the sidecar persisted
//!    (after a successful NATS snapshot or after any applied change
//!    event). Covers the "NATS broker is unreachable at boot but we
//!    DID have authoritative state last time we ran" case — the
//!    sidecar starts draining using the operator's last-known
//!    intent, not a static config that may be weeks stale.
//! 3. **TOML config** — the operator-signed `[ingest_backend]`
//!    section from `config.toml`. Defaults to "every tenant on
//!    Node" per ADR-031 §safe-rollout: a misconfigured deploy degrades
//!    to "no Rust-side processing" (fail-closed) rather than "every
//!    tenant silently double-processed" (fail-open).
//!
//! # Subscriber (policy.ingest_backend.>)
//!
//! Every incremental change published by admin-api-service becomes a
//! `policy.ingest_backend.changed` event carrying an
//! [`IngestBackendChange`]. The subscriber task applies each change
//! via [`DynamicBackendPolicy::apply_change`] (lock-free `ArcSwap`
//! store) then persists the resulting snapshot to disk so durability
//! keeps pace with the in-memory state.
//!
//! # Shutdown
//!
//! The subscriber task holds a [`CancellationToken`] the orchestrator
//! triggers at SIGTERM. The in-flight decode always completes before
//! the task exits — a spurious decode error in the middle of shutdown
//! never trails after the task is torn down.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde::Serialize;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::config::IngestBackendConfig;
use crate::ingest_backend::{DynamicBackendPolicy, IngestBackendChange, IngestBackendSnapshot};
use crate::ingest_backend::{IngressOwnerPolicy, PolicyApplyOutcome, VersionedOwnerPolicies};

/// Canonical request-reply subject the Rust sidecar consults at
/// cold-start. Pinned by the `subject_literal_is_canonical` test so
/// a refactor that mistypes the literal breaks the build.
///
/// The admin-api-service responder subscribes to the same literal;
/// both sides break loud on drift per ADR-031.
pub const SNAPSHOT_SUBJECT: &str = "policy.ingest_backend.snapshot";

/// Subject filter for the incremental change stream. `>` is the NATS
/// greedy wildcard; in practice admin-api-service publishes to
/// `policy.ingest_backend.changed` but the filter leaves room for
/// orthogonal fan-outs (e.g. `policy.ingest_backend.health`) without
/// a subscriber-side code change.
pub const CHANGE_SUBJECT_FILTER: &str = "policy.ingest_backend.>";

/// Versioned per-tenant owner-policy updates. This stream is the only source
/// that can authorize an MQTT ACK-drop by a non-owner sidecar session.
pub const OWNER_POLICY_SUBJECT_FILTER: &str = "policy.ingress_owner.changed.*";

/// Cold-start request-reply snapshot for versioned owner policies.
pub const OWNER_POLICY_SNAPSHOT_SUBJECT: &str = "policy.ingress_owner.snapshot";

const OWNER_POLICY_RECONCILIATION_INTERVAL: Duration = Duration::from_secs(2);
const OWNER_POLICY_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(2);

/// Metric: bootstrap succeeded against a live NATS snapshot reply.
pub const BOOTSTRAP_SOURCE_NATS_METRIC: &str =
    "sensor_ingestion_policy_bootstrap_source_nats_total";

/// Metric: bootstrap fell back to the last disk-persisted snapshot.
pub const BOOTSTRAP_SOURCE_DISK_METRIC: &str =
    "sensor_ingestion_policy_bootstrap_source_disk_total";

/// Metric: bootstrap fell back to the operator-signed TOML config.
pub const BOOTSTRAP_SOURCE_CONFIG_METRIC: &str =
    "sensor_ingestion_policy_bootstrap_source_config_total";

/// Metric: a `policy.ingest_backend.>` event was applied to the
/// dynamic policy.
pub const CHANGE_APPLIED_METRIC: &str = "sensor_ingestion_policy_change_applied_total";

/// Metric: a change-event decode failed (payload bytes that did
/// not match the [`IngestBackendChange`] wire shape).
pub const CHANGE_DECODE_FAILED_METRIC: &str = "sensor_ingestion_policy_change_decode_failed_total";

/// Request body for [`SNAPSHOT_SUBJECT`]. Empty by design — the
/// subject itself disambiguates the intent; no per-caller parameter
/// gives the responder more information than the cert-SSoT caller
/// identity already does.
#[derive(Debug, Serialize)]
struct SnapshotRequest {}

/// Fetch the current owner-policy set. Any transport/decode failure returns an
/// empty registry, which is fail-closed because unknown tenants are RETRY.
pub async fn bootstrap_owner_policies(
    nats: &nats_client::NatsClient,
    timeout: Duration,
    retries: u8,
) -> Arc<VersionedOwnerPolicies> {
    let policies = Arc::new(VersionedOwnerPolicies::new());
    for attempt in 0..retries {
        let snapshot = nats_client::request_typed::<SnapshotRequest, Vec<IngressOwnerPolicy>>(
            nats,
            OWNER_POLICY_SNAPSHOT_SUBJECT,
            &SnapshotRequest {},
            timeout,
        )
        .await;
        match snapshot {
            Ok(rows) => {
                policies.reconcile_snapshot(rows);
                return policies;
            }
            Err(error) => {
                tracing::warn!(attempt = attempt + 1, error = %error, "owner policy snapshot failed");
            }
        }
    }
    tracing::error!("owner policy snapshot unavailable; all tenants remain fail-closed");
    policies
}

/// Which step of the fallback chain produced the snapshot the
/// caller is now holding. Exposed so [`bootstrap_policy`]'s caller
/// can log the source at INFO + the operator can distinguish a
/// healthy `Nats` boot from a degraded `Disk` / `Config` boot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicySource {
    /// Snapshot came from a live `policy.ingest_backend.snapshot`
    /// round trip (healthy path).
    Nats,
    /// Snapshot came from the disk fallback file (NATS unreachable
    /// or every retry timed out, but the sidecar had authoritative
    /// state persisted from a previous session).
    Disk,
    /// Snapshot came from the operator-signed TOML config (NATS +
    /// disk both unavailable — fail-closed path; the defaults route
    /// every tenant to Node).
    Config,
}

impl PolicySource {
    /// Emit the boot-source counter so an operator dashboard can show
    /// the fallback-chain hit ratio at a glance.
    pub fn emit_metric(self) {
        let name = match self {
            Self::Nats => BOOTSTRAP_SOURCE_NATS_METRIC,
            Self::Disk => BOOTSTRAP_SOURCE_DISK_METRIC,
            Self::Config => BOOTSTRAP_SOURCE_CONFIG_METRIC,
        };
        metrics::counter!(name).increment(1);
    }
}

/// Read the last-known snapshot from disk. Returns `None` for every
/// recoverable failure (file missing, unreadable, corrupted JSON)
/// so the caller falls through to the next step of the fallback
/// chain without special-casing each error class.
///
/// Failures that SHOULD alarm (permission errors on a path the
/// operator expected to work) are logged at WARN inside the helper;
/// the return value collapses them into `None` so the bootstrap's
/// control flow stays single-path.
#[must_use]
pub fn load_snapshot_from_disk(path: &Path) -> Option<IngestBackendSnapshot> {
    let raw = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::info!(
                path = %path.display(),
                "disk fallback absent (first boot or cleaned)"
            );
            return None;
        }
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "disk fallback read failed; falling through to TOML config"
            );
            return None;
        }
    };
    match serde_json::from_slice(&raw) {
        Ok(snap) => Some(snap),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "disk fallback decode failed; falling through to TOML config"
            );
            None
        }
    }
}

/// Persist the supplied snapshot to `path` atomically (write to
/// `<path>.tmp`, then rename) so a crash mid-write cannot leave a
/// truncated file that the next boot would silently treat as
/// authoritative.
///
/// # Errors
/// Propagates the underlying [`std::io::Error`] from create /
/// write / rename. The caller logs + drops — persistence is a
/// durability optimisation, NOT load-bearing for correctness (the
/// in-memory `DynamicBackendPolicy` already carries the authoritative
/// state for the running process).
pub fn persist_snapshot_to_disk(
    path: &Path,
    snapshot: &IngestBackendSnapshot,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        // `create_dir_all` is idempotent; skipping the check for
        // existence keeps the helper single-path.
        std::fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_vec(snapshot).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("snapshot serialise failed: {e}"),
        )
    })?;
    // Atomic replace: write to sibling temp, then rename over the
    // target so a reader that opens mid-write either sees the old
    // bytes or the new bytes, never a half-written mix.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &payload)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Drive the cold-start fallback chain described in the module docs.
/// Returns the snapshot the drain should seed its
/// `DynamicBackendPolicy` with + the source that produced it so the
/// caller can log + emit a boot-source counter.
///
/// # Why the fallback chain lives HERE, not inside
/// [`DynamicBackendPolicy::new`]
///
/// The policy primitive must stay free of I/O so unit tests can
/// exercise the hot-path invariants without a NATS broker, disk, or
/// config file. Keeping the I/O in `bootstrap_policy` preserves that
/// tier-1 separation; the orchestrator owns the one-shot boot decision.
///
/// # Panics / cancellation
///
/// The function is cancel-safe. If the caller drops the future mid-
/// retry the in-flight `request_typed` is torn down at the next await
/// point; no partial state is left on disk (persistence happens only
/// AFTER a successful request).
pub async fn bootstrap_policy(
    nats: Option<&nats_client::NatsClient>,
    cfg: &IngestBackendConfig,
) -> (IngestBackendSnapshot, PolicySource) {
    let timeout = Duration::from_secs(cfg.snapshot_request_timeout_secs);
    let retries = cfg.snapshot_request_retries;
    let disk_path = &cfg.disk_fallback_path;

    // Step 1 — NATS request-reply. Capped at `retries` attempts so a
    // persistently unreachable broker does not indefinitely delay
    // drain startup.
    if let Some(client) = nats {
        for attempt in 0..retries {
            match nats_client::request_typed::<SnapshotRequest, IngestBackendSnapshot>(
                client,
                SNAPSHOT_SUBJECT,
                &SnapshotRequest {},
                timeout,
            )
            .await
            {
                Ok(snap) => {
                    // Persist BEFORE returning so the next cold boot
                    // already has a fallback even if the broker goes
                    // down before the first change event.
                    if let Err(e) = persist_snapshot_to_disk(disk_path, &snap) {
                        tracing::warn!(
                            path = %disk_path.display(),
                            error = %e,
                            "persist bootstrap snapshot to disk failed (non-fatal)"
                        );
                    }
                    tracing::info!(
                        default_backend = ?snap.default_backend,
                        overrides = snap.overrides.len(),
                        attempt,
                        "policy bootstrap: live NATS snapshot accepted"
                    );
                    return (snap, PolicySource::Nats);
                }
                Err(e) => {
                    tracing::warn!(
                        attempt = attempt + 1,
                        retries,
                        error = %e,
                        "policy snapshot request failed"
                    );
                }
            }
        }
        tracing::warn!(
            retries,
            "policy bootstrap: NATS snapshot exhausted retries; falling back to disk"
        );
    } else {
        tracing::info!("policy bootstrap: no NATS configured; skipping NATS snapshot step");
    }

    // Step 2 — disk fallback.
    if let Some(snap) = load_snapshot_from_disk(disk_path) {
        tracing::warn!(
            path = %disk_path.display(),
            default_backend = ?snap.default_backend,
            overrides = snap.overrides.len(),
            "policy bootstrap: using disk fallback snapshot"
        );
        return (snap, PolicySource::Disk);
    }

    // Step 3 — TOML config (fail-closed default: every tenant on Node).
    let snap = IngestBackendSnapshot::from_config(cfg);
    tracing::warn!(
        default_backend = ?snap.default_backend,
        overrides = snap.overrides.len(),
        "policy bootstrap: using TOML config (NATS + disk both unavailable)"
    );
    (snap, PolicySource::Config)
}

/// Spawn the `policy.ingest_backend.>` subscriber task. Returns the
/// [`JoinHandle`] so the orchestrator can `.await` it during SIGTERM
/// teardown once the cancellation token has fired.
///
/// Every decoded [`IngestBackendChange`] is applied to the policy
/// via [`DynamicBackendPolicy::apply_change`] AND the resulting
/// snapshot is persisted to disk so durability tracks the in-memory
/// state one event at a time.
///
/// # Lifecycle
///
/// - Subscribe fails at start → task logs ERROR + exits. The policy
///   stays on its bootstrap snapshot (fail-closed). Operators see the
///   error + can restart; the alternative (spinning inside the task
///   retrying the subscribe forever) would mask the misconfiguration.
/// - Stream ends unexpectedly → task logs WARN + exits. Same rationale.
/// - Cancellation fires → task exits at the next tokio::select!
///   poll. The in-flight decode + apply + persist always completes
///   before exit (tokio::select! cancellation is await-point only).
#[must_use]
pub fn spawn_policy_subscriber(
    nats: Arc<nats_client::NatsClient>,
    policy: Arc<DynamicBackendPolicy>,
    disk_path: PathBuf,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut sub = match nats.subscribe(CHANGE_SUBJECT_FILTER).await {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(
                    subject = CHANGE_SUBJECT_FILTER,
                    error = %e,
                    "policy subscriber: failed to subscribe; updates will be missed until restart"
                );
                return;
            }
        };
        tracing::info!(
            subject = CHANGE_SUBJECT_FILTER,
            "policy subscriber: online, awaiting incremental changes"
        );
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    tracing::info!("policy subscriber: cancellation received, exiting");
                    break;
                }
                msg = sub.next() => {
                    let Some(msg) = msg else {
                        tracing::warn!(
                            "policy subscriber: stream ended; updates will be missed until restart"
                        );
                        break;
                    };
                    apply_change_message(&msg.subject, &msg.payload, &policy, &disk_path);
                }
            }
        }
    })
}

/// Subscribe to versioned per-tenant ingress-owner policies. Malformed,
/// conflicting, and stale messages leave the current policy unchanged.
#[must_use]
pub fn spawn_owner_policy_subscriber(
    nats: Arc<nats_client::NatsClient>,
    policies: Arc<VersionedOwnerPolicies>,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut sub = match nats.subscribe(OWNER_POLICY_SUBJECT_FILTER).await {
            Ok(subscriber) => subscriber,
            Err(error) => {
                tracing::error!(
                    subject = OWNER_POLICY_SUBJECT_FILTER,
                    error = %error,
                    "owner policy subscriber failed to start"
                );
                return;
            }
        };
        reconcile_owner_policy_snapshot(&nats, &policies).await;
        let mut reconciliation = tokio::time::interval_at(
            tokio::time::Instant::now() + OWNER_POLICY_RECONCILIATION_INTERVAL,
            OWNER_POLICY_RECONCILIATION_INTERVAL,
        );
        reconciliation.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                () = cancel.cancelled() => break,
                _ = reconciliation.tick() => {
                    reconcile_owner_policy_snapshot(&nats, &policies).await;
                }
                message = sub.next() => {
                    let Some(message) = message else {
                        tracing::error!("owner policy subscriber ended unexpectedly");
                        break;
                    };
                    apply_owner_policy_message(&message.payload, &policies);
                }
            }
        }
    })
}

async fn reconcile_owner_policy_snapshot(
    nats: &nats_client::NatsClient,
    policies: &VersionedOwnerPolicies,
) {
    match nats_client::request_typed::<SnapshotRequest, Vec<IngressOwnerPolicy>>(
        nats,
        OWNER_POLICY_SNAPSHOT_SUBJECT,
        &SnapshotRequest {},
        OWNER_POLICY_SNAPSHOT_TIMEOUT,
    )
    .await
    {
        Ok(snapshot) => policies.reconcile_snapshot(snapshot),
        Err(error) => {
            policies.reconcile_snapshot(Vec::new());
            tracing::error!(error = %error, "owner policy reconciliation failed closed");
        }
    }
}

fn apply_owner_policy_message(payload: &[u8], policies: &VersionedOwnerPolicies) {
    let policy = match serde_json::from_slice::<IngressOwnerPolicy>(payload) {
        Ok(policy) => policy,
        Err(error) => {
            tracing::warn!(error = %error, "invalid ingress owner policy rejected");
            return;
        }
    };
    match policies.apply(policy) {
        PolicyApplyOutcome::Applied | PolicyApplyOutcome::Duplicate => {}
        PolicyApplyOutcome::Stale => {
            tracing::warn!("stale or conflicting ingress owner policy rejected");
        }
    }
}

/// Decode + apply + persist one change-event message. Extracted as
/// a free function so the decode-failure + apply-success paths are
/// unit-testable without a live NATS subscriber — the task body calls
/// into this helper from its select! arm.
fn apply_change_message(
    subject: &str,
    payload: &[u8],
    policy: &DynamicBackendPolicy,
    disk_path: &Path,
) {
    match serde_json::from_slice::<IngestBackendChange>(payload) {
        Ok(change) => {
            policy.apply_change(change);
            metrics::counter!(CHANGE_APPLIED_METRIC).increment(1);
            // Persist AFTER apply so the on-disk copy reflects the
            // state a subsequent cold boot would see.
            let snap = policy.snapshot();
            if let Err(e) = persist_snapshot_to_disk(disk_path, &snap) {
                tracing::warn!(
                    path = %disk_path.display(),
                    error = %e,
                    "persist snapshot after change failed (non-fatal; in-memory state already updated)"
                );
            }
            tracing::info!(
                subject = %subject,
                default_backend = ?snap.default_backend,
                overrides = snap.overrides.len(),
                "policy change applied"
            );
        }
        Err(e) => {
            metrics::counter!(CHANGE_DECODE_FAILED_METRIC).increment(1);
            tracing::warn!(
                subject = %subject,
                payload_len = payload.len(),
                error = %e,
                "policy change decode failed (dropping message)"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CHANGE_SUBJECT_FILTER, PolicySource, SNAPSHOT_SUBJECT, apply_change_message,
        load_snapshot_from_disk, persist_snapshot_to_disk,
    };
    use crate::config::{IngestBackend, IngestBackendConfig};
    use crate::ingest_backend::{DynamicBackendPolicy, IngestBackendChange, IngestBackendSnapshot};
    use std::collections::HashMap;
    use tempfile::tempdir;
    use tenant_context::TenantId;
    use uuid::Uuid;

    fn tenant(seed: u8) -> TenantId {
        let mut bytes = [0_u8; 16];
        bytes[0] = seed;
        TenantId::from_uuid(Uuid::from_bytes(bytes))
    }

    #[test]
    fn subject_literal_is_canonical() {
        // Pin both the request-reply subject + the subscriber filter
        // so a typo fails the build immediately. The admin-api-service
        // responder mirrors SNAPSHOT_SUBJECT in its own test.
        assert_eq!(SNAPSHOT_SUBJECT, "policy.ingest_backend.snapshot");
        assert_eq!(CHANGE_SUBJECT_FILTER, "policy.ingest_backend.>");
    }

    #[test]
    fn policy_source_variants_are_distinguishable() {
        // A refactor that merged two variants (e.g. collapsed Disk
        // into Config) would silently lose an operator-facing signal.
        assert_ne!(PolicySource::Nats, PolicySource::Disk);
        assert_ne!(PolicySource::Disk, PolicySource::Config);
        assert_ne!(PolicySource::Config, PolicySource::Nats);
    }

    #[test]
    fn load_snapshot_missing_file_returns_none() {
        // Cold boot on a fresh host: no disk state yet. The bootstrap
        // must treat this as "fall through to TOML", not as a hard
        // error — operators on first deploy would otherwise see the
        // sidecar refuse to start.
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.json");
        assert!(load_snapshot_from_disk(&path).is_none());
    }

    #[test]
    fn persist_and_load_round_trip_preserves_snapshot() {
        // Durability invariant: a snapshot written to disk must be
        // byte-equivalent on the next load. Regressions on the serde
        // tag attribute or the Uuid representation would break this
        // at boot + force an unnecessary fallback to TOML.
        let dir = tempdir().unwrap();
        let path = dir.path().join("policy.json");

        let mut overrides = HashMap::new();
        overrides.insert(tenant(0x01), IngestBackend::Rust);
        overrides.insert(tenant(0x02), IngestBackend::Node);
        let original = IngestBackendSnapshot {
            default_backend: IngestBackend::Node,
            overrides,
        };

        persist_snapshot_to_disk(&path, &original).expect("persist succeeds");
        let decoded = load_snapshot_from_disk(&path).expect("load succeeds");
        assert_eq!(decoded, original);
    }

    #[test]
    fn persist_creates_missing_parent_directory() {
        // The default path is /var/lib/sensor-ingestion/last-known-
        // policy.json; on a clean droplet the directory may not exist
        // on first write. A helper that required the operator to
        // create it would make the sidecar fail on an easily-recoverable
        // state.
        let dir = tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("policy.json");
        let snap = IngestBackendSnapshot {
            default_backend: IngestBackend::Rust,
            overrides: HashMap::new(),
        };
        persist_snapshot_to_disk(&nested, &snap).expect("nested write succeeds");
        assert!(nested.exists());
    }

    #[test]
    fn load_snapshot_corrupt_file_returns_none() {
        // A partial write from a crash (pre-rename) or an operator's
        // accidental edit produces bytes that do not decode. The
        // fallback chain must treat this as "skip disk, use TOML"
        // rather than surface an error — the system stays functional
        // with the next fallback step.
        let dir = tempdir().unwrap();
        let path = dir.path().join("corrupt.json");
        std::fs::write(&path, b"this is not json").unwrap();
        assert!(load_snapshot_from_disk(&path).is_none());
    }

    #[test]
    fn apply_change_message_decodes_and_applies_valid_payload() {
        // The subscriber-task happy path: receive valid JSON, mutate
        // the policy, persist. Asserting through the public apply
        // path keeps the test honest about the wire shape + the
        // `ArcSwap` store being visible to subsequent reads.
        let dir = tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let policy = DynamicBackendPolicy::new(IngestBackendSnapshot::node_only());
        let t = tenant(0x42);

        let change = IngestBackendChange::SetTenant {
            tenant_id: t,
            backend: IngestBackend::Rust,
        };
        let payload = serde_json::to_vec(&change).unwrap();
        apply_change_message("policy.ingest_backend.changed", &payload, &policy, &path);

        let snap = policy.snapshot();
        assert_eq!(snap.overrides.get(&t).copied(), Some(IngestBackend::Rust));
        // And the on-disk copy tracks the in-memory state.
        let on_disk = load_snapshot_from_disk(&path).expect("persisted after apply");
        assert_eq!(on_disk, snap);
    }

    #[test]
    fn apply_change_message_survives_malformed_payload() {
        // Defence-in-depth: admin-api-service is the owner of the
        // wire shape, but a broker replay of stale bytes OR a version
        // skew must NOT panic the subscriber. Drop the message, log,
        // keep consuming.
        let dir = tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let policy = DynamicBackendPolicy::new(IngestBackendSnapshot::node_only());
        apply_change_message(
            "policy.ingest_backend.changed",
            b"not really json",
            &policy,
            &path,
        );
        // Policy unchanged because decode failed.
        assert_eq!(policy.snapshot(), IngestBackendSnapshot::node_only());
        // No persistence on decode failure — only successful apply
        // writes to disk.
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn bootstrap_falls_back_to_config_when_no_nats_and_no_disk() {
        // Green-field deploy: no NATS configured + no disk state.
        // Must end up with `PolicySource::Config` and the snapshot
        // must reflect the TOML defaults.
        let dir = tempdir().unwrap();
        let cfg = IngestBackendConfig {
            disk_fallback_path: dir.path().join("nothing.json"),
            snapshot_request_retries: 1,
            snapshot_request_timeout_secs: 1,
            ..IngestBackendConfig::default()
        };

        let (snap, source) = super::bootstrap_policy(None, &cfg).await;
        assert_eq!(source, PolicySource::Config);
        assert_eq!(snap.default_backend, IngestBackend::Node);
        assert!(snap.overrides.is_empty());
    }

    #[tokio::test]
    async fn bootstrap_uses_disk_when_nats_absent_and_disk_present() {
        // Degraded boot: NATS cert / server unreachable OR no
        // [nats] block, but a previous session left a fresh disk
        // snapshot. The sidecar must start from the disk state, NOT
        // regress to TOML defaults — the operator's last-known intent
        // survives a broker outage across a restart.
        let dir = tempdir().unwrap();
        let disk = dir.path().join("persisted.json");
        let mut overrides = HashMap::new();
        overrides.insert(tenant(0x11), IngestBackend::Rust);
        let persisted = IngestBackendSnapshot {
            default_backend: IngestBackend::Node,
            overrides,
        };
        persist_snapshot_to_disk(&disk, &persisted).unwrap();

        let cfg = IngestBackendConfig {
            disk_fallback_path: disk,
            snapshot_request_retries: 1,
            snapshot_request_timeout_secs: 1,
            ..IngestBackendConfig::default()
        };

        let (snap, source) = super::bootstrap_policy(None, &cfg).await;
        assert_eq!(source, PolicySource::Disk);
        assert_eq!(
            snap.overrides.get(&tenant(0x11)).copied(),
            Some(IngestBackend::Rust)
        );
    }
}
