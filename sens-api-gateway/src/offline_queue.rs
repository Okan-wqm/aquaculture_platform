//! Offline Message Queue with Priority Support
//!
//! Provides persistent storage for MQTT messages when the broker is unreachable.
//! Messages are stored locally and replayed in priority order when connectivity is restored.
//!
//! # Features
//! - Priority-based message ordering (higher priority first)
//! - Bounded queue size to prevent unbounded memory growth
//! - SQLite persistence for crash recovery
//! - FIFO ordering within same priority level
//!
//! # IEC 62443 SL2 Compliance
//! - FR5: Resource availability (bounded queue prevents DoS)
//! - FR6: Monitoring (queue metrics for observability)
//!
//! # v1.2.3 Improvements
//! - Added mutex poison recovery for better resilience

use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tracing::{debug, error, info, warn};

/// Derive the SQLCipher encryption key from machine-id + a device-local secret file.
///
/// The key is HMAC-SHA256(machine_id, secret_key) where:
/// - machine_id: read from /etc/machine-id (device-unique, survives reboots)
/// - secret_key: a 32-byte random key stored at /etc/suderra/db.key (0400 permissions)
///
/// The secret file is auto-generated on first run and is only readable by the
/// suderra service user.  This addresses the audit finding that machine-id alone
/// is world-readable and therefore insufficient as sole key material (IEC 62443 FR4).
///
/// Returns an error if machine-id or secret key cannot be obtained.
///
/// ## Caching discipline (Batch 96 architectural fix)
///
/// The derived hex is cached in a process-global `OnceLock`
/// on first successful computation. Subsequent calls return
/// the cached value WITHOUT re-reading /etc/machine-id or
/// /etc/suderra/db.key. This:
///
/// 1. Eliminates the parallel-test flake where env-var
///    mutation on one thread raced against file-read on
///    another (Batch 88+90 partial mitigations via
///    ENV_RACE_MUTEX + LazyLock were targeted fixes;
///    this is the root-cause architectural fix).
/// 2. Bounds the filesystem-read cost to ONE syscall per
///    process lifetime rather than N-per-connection.
/// 3. Matches the production invariant: the derived key
///    never changes during a process lifetime (machine-id
///    is stable, secret file is touched only at provision
///    time). Any key rotation inherently requires an
///    agent restart (Batch 85 rotate_master documents this
///    explicitly).
///
/// Test discipline: the cache persists across tests within a
/// single `cargo test` process. The first test to call
/// `derive_db_encryption_key` latches the value; subsequent
/// tests with different `SUDERRA_DB_KEY_PATH` env values
/// would observe the cached first-call result. This is
/// intentional — tests that need a specific path MUST set
/// the env BEFORE the first call, exactly as the sandbox
/// LazyLock in the test module does.
///
/// ## Algorithm SSoT (Batch #335 — closes ULTRA-HIGH-082's
/// HIGH-001 audit finding)
///
/// The HMAC-SHA256(secret_key, machine_id) algorithm is
/// implemented exactly ONCE in the codebase, at
/// `crate::db_migration::v1_legacy_key::derive_v1_legacy_key`.
/// This function is the IO-cached production wrapper:
///
///   1. Reads `/etc/machine-id` (or the `SUDERRA_DB_KEY_PATH`
///      override) — IO that the pure kernel cannot do.
///   2. Reads or creates `/etc/suderra/db.key` — IO that the
///      pure kernel cannot do.
///   3. Calls the kernel to compute the HMAC bytes.
///   4. Formats the bytes as the SQLCipher PRAGMA-key
///      lower-hex string via the kernel's
///      `format_sqlcipher_pragma_key_hex` helper.
///   5. Caches the hex string in `OnceLock` so subsequent
///      calls skip steps 1-4.
///
/// Pre-Batch-#335, this function inlined the HMAC + hex
/// formatting locally — that produced TWO copies of the
/// algorithm (here + in `db_migration::v1_legacy_key`). The
/// audit finding [registry: ULTRA-HIGH-082's HIGH-001
/// surfaced by edge-industrial-auditor] flagged that the
/// "cross-validation parity" test in
/// `tests/invariants/db_migration_v1_legacy_key.rs`
/// reimplemented the algorithm in the test file using the
/// same `hmac`+`sha2` crates — it never imported THIS
/// function. So a one-byte change here (e.g., switching
/// to upper-hex) would NOT have been caught by the parity
/// test, even though the migration tool's correctness
/// depends on byte-for-byte parity. The architectural fix:
/// this function delegates to the kernel; there is no
/// second copy to drift away.
pub(crate) fn derive_db_encryption_key() -> Result<String> {
    use std::sync::OnceLock;

    static CACHED: OnceLock<String> = OnceLock::new();

    if let Some(hex) = CACHED.get() {
        return Ok(hex.clone());
    }

    // Batch #344 (closes ORPHAN-MEDIUM-033): delegate
    // to crate::machine_id::read() which wraps
    // machine_uid::get() with the SUDERRA_MACHINE_ID_PATH
    // env-override. Production path is byte-identical to
    // pre-#344 (env unset → falls through to
    // machine_uid::get() with the same error context);
    // CI / test paths can sandbox the machine-id read
    // alongside the SUDERRA_DB_KEY_PATH override.
    let machine_id = crate::machine_id::read().context("Cannot derive database encryption key")?;

    let secret_key = load_or_create_db_secret()?;

    // Single-source-of-truth delegation. The HMAC algorithm
    // + hex format live in `db_migration::v1_legacy_key`;
    // this function is the IO-cached wrapper.
    let key_bytes = crate::db_migration::v1_legacy_key::derive_v1_legacy_key(
        machine_id.as_bytes(),
        &secret_key,
    );
    let hex = crate::db_migration::v1_legacy_key::format_sqlcipher_pragma_key_hex(&key_bytes);

    // Store via OnceLock::get_or_init to handle the race
    // where multiple threads invoke derive_db_encryption_
    // key() before any has cached. First writer wins; other
    // threads observe the winner's value (happens-before
    // via OnceLock's internal barrier).
    let cached_ref = CACHED.get_or_init(|| hex.clone());
    Ok(cached_ref.clone())
}

/// Load or create the device-local secret key for database encryption.
///
/// The secret is stored at `/etc/suderra/db.key` with 0400
/// permissions by default. If `SUDERRA_DB_KEY_PATH` env var is
/// set (Batch 88 CI-sandbox support), that path is used instead
/// — enables non-root CI runners to exercise tests that need
/// the SQLCipher derivation path without needing `/etc`
/// write access.
///
/// If the file does not exist, a 32-byte random key is generated.
/// **Delegating wrapper** (PR-195 Batch #14 SSoT
/// extraction). The IO-read-or-create logic now lives
/// in `crate::db_secret::read_or_create_v1_secret`.
/// This function is retained as a thin delegating
/// wrapper so callers within `offline_queue.rs` (every
/// SQLCipher-key-using path) keep their byte-for-byte
/// behavior — the extraction is a NAME change, not a
/// semantic change. Other consumers
/// (license_cache, retain_persistence, bytecode_retain)
/// import `db_secret::read_or_create_v1_secret` directly,
/// not this wrapper.
fn load_or_create_db_secret() -> Result<Vec<u8>> {
    crate::db_secret::read_or_create_v1_secret()
}

// EDGE-HIGH-026: the former `apply_db_encryption_key` / `apply_pragma_key_hex`
// helpers were deleted — the SQLCipher PRAGMA-key ceremony (raw key +
// journal/synchronous/busy_timeout/auto_vacuum) now lives ONLY in
// `crate::db::sqlcipher_factory`. `derive_db_encryption_key` (above) stays
// here as the v1 key-material SSoT the factory delegates to.

/// 2026-04-29 enterprise shutdown fsync helper.
///
/// What it solves: checkpoint code can explicitly sync each SQLite file that
/// exists without treating absent WAL/SHM sidecars as an error.
fn sync_file_if_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    let file = std::fs::File::open(path)
        .with_context(|| format!("Failed to open {} for fsync", path.display()))?;
    file.sync_all()
        .with_context(|| format!("Failed to fsync {}", path.display()))?;
    Ok(())
}

/// 2026-04-29 enterprise SQLite sidecar path helper.
///
/// What it solves: WAL/SHM file names are built from the raw OS path, not
/// `Display`, so non-UTF-8 filesystem paths are preserved.
fn sqlite_sidecar_path(db_path: &Path, suffix: &str) -> PathBuf {
    let mut raw = db_path.as_os_str().to_os_string();
    raw.push(suffix);
    PathBuf::from(raw)
}

/// Acquire mutex lock with poison recovery (v1.2.3)
///
/// If the mutex is poisoned (previous holder panicked), this function
/// will recover the lock and log a warning. The data may be in an
/// inconsistent state, but for SQLite connections this is generally safe
/// as SQLite handles its own transaction rollback.
///
/// # v1.3.3: Added connection health check after poison recovery
///
/// **Batch #257 wire status:** retained as a generic helper for
/// non-SQLite mutex paths (no current callers — SQLite hot path
/// migrated to `acquire_sqlite_lock` for the BUG-015 health-check
/// fix). Kept compiled with `#[allow(dead_code)]` so future
/// non-Connection mutex consumers can reuse the simple-poison-
/// recovery shape without re-deriving it.
#[allow(dead_code)]
fn acquire_lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    match mutex.lock() {
        Ok(guard) => Ok(guard),
        Err(poisoned) => {
            error!(
                "Mutex was poisoned by a panicked thread. Recovering lock. \
                Data may be inconsistent - consider restarting the agent."
            );
            // Recover the lock - SQLite will have rolled back any incomplete transaction
            Ok(poisoned.into_inner())
        }
    }
}

/// Acquire SQLite connection lock with poison recovery and health check (v1.3.3)
///
/// After recovering from a poisoned mutex, validates that the SQLite connection
/// is still usable by executing a simple query **exactly once** — on the first
/// acquisition after the panic. Subsequent acquisitions on the still-poisoned
/// mutex skip the health check because `health_verified` is set to `true` after
/// the first successful validation.
///
/// # Why `health_verified`?
/// `std::sync::Mutex` keeps its poisoned state permanently — every call to
/// `.lock()` after a panic returns `Err(PoisonError)` for the lifetime of the
/// process. Without the flag, `SELECT 1` would run on every hot-path lock
/// acquisition (enqueue, dequeue, stats) for the rest of the process lifetime,
/// adding unnecessary SQLite overhead in scan-cycle mode (BUG-015).
///
/// ## Wire status (Batch #257)
///
/// Wired across all 11 hot-path callers (enqueue, dequeue, ack,
/// peek, stats, retention-clean, etc.) as of Batch #257. The
/// SELECT-1 health probe fires exactly once after a mutex
/// poison event — subsequent acquisitions on the same poisoned
/// mutex skip the probe via the `poison_health_verified` flag,
/// keeping the hot-path overhead at one atomic-load per call.
fn acquire_sqlite_lock<'a>(
    mutex: &'a Mutex<Connection>,
    health_verified: &AtomicBool,
) -> Result<MutexGuard<'a, Connection>> {
    let was_poisoned;
    let guard = match mutex.lock() {
        Ok(guard) => {
            was_poisoned = false;
            guard
        }
        Err(poisoned) => {
            error!(
                "SQLite mutex was poisoned by a panicked thread. Recovering lock and validating connection..."
            );
            was_poisoned = true;
            poisoned.into_inner()
        }
    };

    // Run the health check only on the *first* acquisition after a poison event.
    // `health_verified` starts false; we flip it to true after a successful check
    // so subsequent calls skip the SELECT 1 query.
    if was_poisoned && !health_verified.load(Ordering::Acquire) {
        match guard.execute("SELECT 1", []) {
            Ok(_) => {
                warn!(
                    "SQLite connection validated after poison recovery. \
                    Any incomplete transaction was rolled back by SQLite."
                );
                // Mark as verified so subsequent poisoned-lock acquisitions skip this check.
                health_verified.store(true, Ordering::Release);
            }
            Err(e) => {
                error!(
                    "SQLite connection corrupted after poison recovery: {}. \
                    Manual intervention required - consider restarting the agent.",
                    e
                );
                return Err(anyhow::anyhow!(
                    "SQLite connection corrupted after mutex poison recovery: {}",
                    e
                ));
            }
        }
    }

    Ok(guard)
}

/// Message priority levels (higher value = higher priority)
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[repr(u8)]
#[derive(Default)]
pub enum MessagePriority {
    /// Low priority - background data, can be delayed
    Low = 0,
    /// Normal priority - regular telemetry
    #[default]
    Normal = 1,
    /// High priority - important events
    High = 2,
    /// Critical priority - alarms, safety events
    Critical = 3,
}

impl From<u8> for MessagePriority {
    fn from(value: u8) -> Self {
        match value {
            0 => MessagePriority::Low,
            1 => MessagePriority::Normal,
            2 => MessagePriority::High,
            3.. => MessagePriority::Critical,
        }
    }
}

/// Queued message with metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedMessage {
    /// Unique message ID
    pub id: i64,
    /// MQTT topic
    pub topic: String,
    /// Message payload (JSON)
    pub payload: String,
    /// Message priority
    pub priority: MessagePriority,
    /// MQTT QoS level (0, 1, 2)
    pub qos: u8,
    /// Retain flag
    pub retain: bool,
    /// Creation timestamp (milliseconds since epoch)
    pub created_at: i64,
    /// Number of retry attempts
    pub retry_count: u32,
}

/// Queue statistics for monitoring
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueueStats {
    /// Total messages in queue
    pub total_messages: usize,
    /// Messages by priority
    pub by_priority: [usize; 4],
    /// Oldest message age in seconds
    pub oldest_message_age_secs: Option<u64>,
    /// Total bytes used (payload + topic)
    pub total_bytes: usize,
    /// Database file size in bytes (v1.2.0)
    pub db_size_bytes: u64,
    /// Percentage of disk limit used (v1.2.0)
    pub disk_usage_percent: f32,
}

/// Default maximum disk size: 50 MB
const DEFAULT_MAX_DISK_BYTES: u64 = 50 * 1024 * 1024;

/// Offline message queue with SQLite persistence
///
/// # Thread Safety
/// Uses interior mutability with Mutex for safe concurrent access.
///
/// # Resource Limits (v1.2.0)
/// Enforces both message count limit and disk size limit to prevent
/// unbounded resource consumption (IEC 62443 SL2 FR5).
pub struct OfflineQueue {
    /// Database connection (protected by mutex for sync access)
    conn: Mutex<Connection>,
    /// 2026-04-29 enterprise shutdown durability:
    /// filesystem path for file-backed queues.
    ///
    /// What it solves: graceful shutdown can fsync the SQLite DB/WAL files and
    /// parent directory after a WAL checkpoint. In-memory test queues keep
    /// this as None.
    db_path: Option<PathBuf>,
    /// Maximum queue size (message count)
    max_size: usize,
    /// Maximum message age before expiration (seconds)
    max_age_secs: u64,
    /// Maximum disk size in bytes (v1.2.0)
    max_disk_bytes: u64,
    /// Tracks whether the SQLite connection health check has already passed after
    /// a mutex poison event. Prevents running SELECT 1 on every hot-path lock
    /// acquisition for the lifetime of the process once a panic has been recovered
    /// (BUG-015 fix). Wired by Batch #257 — every `acquire_sqlite_lock` callsite
    /// passes a reference to this flag.
    poison_health_verified: AtomicBool,
}

impl OfflineQueue {
    /// Create a new offline queue with file-based persistence
    ///
    /// # Arguments
    /// * `db_path` - Path to SQLite database file
    /// * `max_size` - Maximum number of messages to store
    /// * `max_age_secs` - Maximum age before messages expire (0 = no expiration)
    pub fn new(db_path: &Path, max_size: usize, max_age_secs: u64) -> Result<Self> {
        Self::with_disk_limit(db_path, max_size, max_age_secs, DEFAULT_MAX_DISK_BYTES)
    }

    /// Create a new offline queue with custom disk limit (v1.2.0)
    ///
    /// # Arguments
    /// * `db_path` - Path to SQLite database file
    /// * `max_size` - Maximum number of messages to store
    /// * `max_age_secs` - Maximum age before messages expire (0 = no expiration)
    /// * `max_disk_bytes` - Maximum disk space in bytes (0 = no limit)
    pub fn with_disk_limit(
        db_path: &Path,
        max_size: usize,
        max_age_secs: u64,
        max_disk_bytes: u64,
    ) -> Result<Self> {
        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory
        // (v1 device-secret key). Encrypts the database at rest (IEC 62443
        // FR4) so physical access to the device does not expose queued
        // telemetry or PLC state; the factory owns the PRAGMA key + WAL /
        // synchronous / busy_timeout / auto_vacuum sequence.
        let conn = crate::db::sqlcipher_factory::open_device_secret(
            db_path,
            "offline_queue",
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )?;

        let queue = Self {
            conn: Mutex::new(conn),
            db_path: Some(db_path.to_path_buf()),
            max_size,
            max_age_secs,
            max_disk_bytes,
            poison_health_verified: AtomicBool::new(false),
        };

        queue.init_schema()?;
        info!(
            "Offline queue initialized: max_size={}, max_age_secs={}, max_disk_mb={}",
            max_size,
            max_age_secs,
            max_disk_bytes / (1024 * 1024)
        );

        Ok(queue)
    }

    /// Manifest-aware constructor (PR-195 Batch #13).
    ///
    /// Reads the per-DB sidecar manifest (Batch #329)
    /// and derives the SQLCipher PRAGMA key via
    /// `db_migration::consumer_key_resolver` (Batch #8) —
    /// missing manifest = legacy v1 default per Batch
    /// #330; v1 manifest = HMAC-SHA256 kernel; v2
    /// manifest = keystore-derived key.
    ///
    /// **Why this constructor exists:** the legacy
    /// `with_disk_limit` always derives v1, which
    /// works on un-migrated hosts but fails-closed on
    /// hosts where the operator has run the migration
    /// ceremony (manifest now declares v2; v1-derived
    /// PRAGMA key would not decrypt the v2-encrypted
    /// pages). This constructor reads the manifest
    /// FIRST, picks the correct derivation path, and
    /// opens with the matching key — works on BOTH
    /// pre-migration and post-migration hosts.
    ///
    /// **Caller contract:**
    ///
    ///   - `db_path` — same path as the legacy
    ///     constructor; the manifest sidecar lives
    ///     at `manifest_path_for_db(db_path)`.
    ///   - `keystore` — agent's already-built keystore
    ///     handle for the v2 path.
    ///   - `deployment_uuid` — provisioning device UUID
    ///     bytes (v2 device-bound consumer context per
    ///     ADR-031). OfflineQueue is device-bound, so
    ///     program SHA is `None` internally.
    ///
    /// **Async:** `Keystore::derive_key` is async;
    /// caller awaits this constructor at boot time.
    /// Once constructed, the queue's hot-path methods
    /// remain sync (no async leakage to the enqueue /
    /// peek / ack callers).
    pub async fn with_keystore_derivation(
        db_path: &Path,
        max_size: usize,
        max_age_secs: u64,
        max_disk_bytes: u64,
        keystore: std::sync::Arc<dyn crate::keystore::Keystore>,
        deployment_uuid: Vec<u8>,
    ) -> Result<Self> {
        // EDGE-HIGH-026: open + key via the canonical SQLCipher factory's
        // resolver path. The factory assembles the v1 inputs (machine-id +
        // device secret) internally and owns the PRAGMA key + durability
        // sequence. ConsumerContext for OfflineQueue is device-bound per
        // ADR-031: deployment_uuid required; program_artifact_sha256 None.
        let ctx = crate::db_migration::consumer_context::ConsumerContext {
            deployment_uuid,
            program_artifact_sha256: None,
        };
        let opened = crate::db::sqlcipher_factory::open_resolved(
            db_path,
            crate::keystore::purpose::KeyPurpose::SqlCipherOfflineQueue,
            &ctx,
            keystore.as_ref(),
            crate::db::sqlcipher_factory::PragmaProfile::DEFAULT,
        )
        .await?;

        let queue = Self {
            conn: Mutex::new(opened.conn),
            db_path: Some(db_path.to_path_buf()),
            max_size,
            max_age_secs,
            max_disk_bytes,
            poison_health_verified: AtomicBool::new(false),
        };
        queue.init_schema()?;

        info!(
            "OfflineQueue (manifest-aware) initialized: \
             max_size={}, max_age_secs={}, max_disk_mb={}, schema_version={:?}",
            max_size,
            max_age_secs,
            max_disk_bytes / (1024 * 1024),
            opened.key_version,
        );

        Ok(queue)
    }

    /// Create an in-memory queue (for testing)
    pub fn in_memory(max_size: usize) -> Result<Self> {
        let conn = Connection::open_in_memory().context("Failed to create in-memory database")?;

        let queue = Self {
            conn: Mutex::new(conn),
            db_path: None,
            max_size,
            max_age_secs: 0,   // No expiration
            max_disk_bytes: 0, // No disk limit for in-memory
            poison_health_verified: AtomicBool::new(false),
        };

        queue.init_schema()?;
        Ok(queue)
    }

    /// Get current database file size in bytes (v1.2.0)
    ///
    /// Uses SQLite's page_count * page_size for accurate measurement.
    fn get_db_size(&self, conn: &Connection) -> u64 {
        conn.query_row(
            "SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|size| size as u64)
        .unwrap_or(0)
    }

    /// Evict oldest low-priority messages until disk usage is under limit (v1.2.0)
    /// v1.2.6: Added bounds validation to prevent SQL injection via format string
    fn evict_for_disk_space(&self, conn: &Connection, evict_count: usize) -> Result<usize> {
        // v1.2.6: Validate evict_count to prevent potential issues
        // Max reasonable eviction is 10000 messages at once
        const MAX_EVICT_COUNT: usize = 10000;
        if evict_count == 0 {
            return Ok(0);
        }
        let safe_count = evict_count.min(MAX_EVICT_COUNT);

        // Note: SQLite LIMIT doesn't support parameters, but evict_count is
        // already validated as usize and bounded above
        let result = conn.execute(
            &format!(
                "DELETE FROM message_queue WHERE id IN (
                    SELECT id FROM message_queue
                    ORDER BY priority ASC, created_at ASC
                    LIMIT {}
                )",
                safe_count
            ),
            [],
        );

        match result {
            Ok(deleted) => {
                if deleted > 0 {
                    warn!("Evicted {} messages due to disk space limit", deleted);
                }
                Ok(deleted)
            }
            Err(e) => Err(anyhow::anyhow!(
                "Failed to evict messages for disk space: {}",
                e
            )),
        }
    }

    /// Initialize database schema
    fn init_schema(&self) -> Result<()> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        conn.execute_batch(
            "
            -- Enable WAL mode for better concurrent access
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA busy_timeout=5000;

            -- Message queue table
            CREATE TABLE IF NOT EXISTS message_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                topic TEXT NOT NULL,
                payload TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 1,
                qos INTEGER NOT NULL DEFAULT 1,
                retain INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0
            );

            -- Index for priority-based dequeue (highest priority, oldest first)
            CREATE INDEX IF NOT EXISTS idx_queue_priority_created
            ON message_queue (priority DESC, created_at ASC);

            -- Index for expiration cleanup
            CREATE INDEX IF NOT EXISTS idx_queue_created
            ON message_queue (created_at);

            -- EDGE-CRITICAL-004: persisted high-water-mark for the outbound
            -- edge_seq idempotency counter. A single row (id=1) whose
            -- reserved_hwm only ever increases; a Hi/Lo allocator reserves
            -- blocks from it so the seq is strictly monotonic and never
            -- reused across restarts (a crash loses at most a block, which is
            -- harmless — the dedup key needs uniqueness, not contiguity).
            CREATE TABLE IF NOT EXISTS edge_seq_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                reserved_hwm INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .context("Failed to initialize queue schema")?;

        Ok(())
    }

    /// EDGE-CRITICAL-004: reserve a contiguous block of `block` edge_seq
    /// values and return the new reserved high-water-mark. The reserved
    /// block is `[hwm - block, hwm)`. The persisted `reserved_hwm` only
    /// ever increases, so across restarts the next boot resumes strictly
    /// above every value ever handed out — no reuse is possible.
    pub fn reserve_seq_block(&self, block: u64) -> Result<u64> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;
        // Ensure the singleton row exists, then bump it atomically and read
        // back the new value. `INSERT OR IGNORE` + `UPDATE ... RETURNING` is
        // one connection-serialized transaction under the lock.
        conn.execute(
            "INSERT OR IGNORE INTO edge_seq_state (id, reserved_hwm) VALUES (1, 0)",
            [],
        )
        .context("Failed to seed edge_seq_state")?;
        let new_hwm: i64 = conn
            .query_row(
                "UPDATE edge_seq_state SET reserved_hwm = reserved_hwm + ?1
                  WHERE id = 1 RETURNING reserved_hwm",
                params![block as i64],
                |row| row.get(0),
            )
            .context("Failed to reserve edge_seq block")?;
        Ok(new_hwm as u64)
    }

    /// Enqueue a message
    ///
    /// If queue is at capacity (message count or disk size), the oldest
    /// low-priority messages are removed (v1.2.0: disk size limit).
    pub fn enqueue(
        &self,
        topic: &str,
        payload: &str,
        priority: MessagePriority,
        qos: u8,
        retain: bool,
    ) -> Result<i64> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        // Check current queue size
        let mut current_size: usize = conn
            .query_row("SELECT COUNT(*) FROM message_queue", [], |row| row.get(0))
            .context("Failed to query queue size")?;

        // If at message count capacity, remove oldest low-priority message
        if current_size >= self.max_size {
            self.evict_one(&conn)?;
            current_size = current_size.saturating_sub(1);
        }

        // v1.2.0: Check disk size limit and evict if necessary
        // v1.2.6: Loop until under limit to prevent disk exhaustion
        if self.max_disk_bytes > 0 {
            let mut db_size = self.get_db_size(&conn);
            let mut eviction_rounds = 0;
            const MAX_EVICTION_ROUNDS: usize = 10; // Prevent infinite loop

            while db_size >= self.max_disk_bytes
                && current_size > 0
                && eviction_rounds < MAX_EVICTION_ROUNDS
            {
                // Evict 10% of messages (min 5, max 50) to reclaim disk space.
                // Use the actual deleted count returned by evict_for_disk_space() to avoid
                // current_size drifting below the real SQLite row count when partial
                // deletion occurs (e.g., SQLite busy timeout, WAL lock contention).
                let evict_target = (current_size / 10).max(5).min(50);
                let actually_deleted = self.evict_for_disk_space(&conn, evict_target)?;
                current_size = current_size.saturating_sub(actually_deleted);
                db_size = self.get_db_size(&conn);
                eviction_rounds += 1;
            }
        }

        let now = chrono::Utc::now().timestamp_millis();

        conn.execute(
            "INSERT INTO message_queue (topic, payload, priority, qos, retain, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![topic, payload, priority as u8, qos, retain as i32, now],
        )
        .context("Failed to enqueue message")?;

        let id = conn.last_insert_rowid();
        debug!(
            "Enqueued message {} to '{}' (priority={:?})",
            id, topic, priority
        );

        Ok(id)
    }

    /// Remove oldest low-priority message to make room
    fn evict_one(&self, conn: &Connection) -> Result<()> {
        // Find and remove the oldest message with lowest priority
        let result = conn.execute(
            "DELETE FROM message_queue WHERE id = (
                SELECT id FROM message_queue
                ORDER BY priority ASC, created_at ASC
                LIMIT 1
            )",
            [],
        );

        match result {
            Ok(1) => {
                warn!("Evicted oldest low-priority message (queue at capacity)");
                Ok(())
            }
            Ok(_) => Ok(()), // Nothing to evict
            Err(e) => Err(anyhow::anyhow!("Failed to evict message: {}", e)),
        }
    }

    /// Dequeue the highest priority message
    ///
    /// Returns the message but does NOT remove it from queue.
    /// Call `ack()` after successful processing to remove.
    pub fn peek(&self) -> Result<Option<QueuedMessage>> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        // Clean up expired messages first
        if self.max_age_secs > 0 {
            self.cleanup_expired(&conn)?;
        }

        let result = conn.query_row(
            "SELECT id, topic, payload, priority, qos, retain, created_at, retry_count
             FROM message_queue
             ORDER BY priority DESC, created_at ASC
             LIMIT 1",
            [],
            |row| {
                Ok(QueuedMessage {
                    id: row.get(0)?,
                    topic: row.get(1)?,
                    payload: row.get(2)?,
                    priority: MessagePriority::from(row.get::<_, u8>(3)?),
                    qos: row.get(4)?,
                    retain: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                    retry_count: row.get(7)?,
                })
            },
        );

        match result {
            Ok(msg) => Ok(Some(msg)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow::anyhow!("Failed to peek message: {}", e)),
        }
    }

    /// Acknowledge successful message processing (removes from queue)
    pub fn ack(&self, message_id: i64) -> Result<bool> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        let deleted = conn
            .execute(
                "DELETE FROM message_queue WHERE id = ?1",
                params![message_id],
            )
            .context("Failed to ack message")?;

        if deleted > 0 {
            debug!("Acknowledged message {}", message_id);
        }

        Ok(deleted > 0)
    }

    /// Mark message for retry (increments retry count)
    pub fn nack(&self, message_id: i64) -> Result<()> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        conn.execute(
            "UPDATE message_queue SET retry_count = retry_count + 1 WHERE id = ?1",
            params![message_id],
        )
        .context("Failed to nack message")?;

        debug!("Nacked message {} (will retry)", message_id);
        Ok(())
    }

    /// Get multiple messages for batch processing
    pub fn peek_batch(&self, max_count: usize) -> Result<Vec<QueuedMessage>> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        // Clean up expired messages first
        if self.max_age_secs > 0 {
            self.cleanup_expired(&conn)?;
        }

        let mut stmt = conn.prepare(
            "SELECT id, topic, payload, priority, qos, retain, created_at, retry_count
             FROM message_queue
             ORDER BY priority DESC, created_at ASC
             LIMIT ?1",
        )?;

        let messages = stmt
            .query_map(params![max_count], |row| {
                Ok(QueuedMessage {
                    id: row.get(0)?,
                    topic: row.get(1)?,
                    payload: row.get(2)?,
                    priority: MessagePriority::from(row.get::<_, u8>(3)?),
                    qos: row.get(4)?,
                    retain: row.get::<_, i32>(5)? != 0,
                    created_at: row.get(6)?,
                    retry_count: row.get(7)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(messages)
    }

    /// Acknowledge multiple messages
    pub fn ack_batch(&self, message_ids: &[i64]) -> Result<usize> {
        if message_ids.is_empty() {
            return Ok(0);
        }

        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        // Build parameterized query
        let placeholders: Vec<String> =
            (1..=message_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "DELETE FROM message_queue WHERE id IN ({})",
            placeholders.join(", ")
        );

        let params: Vec<&dyn rusqlite::ToSql> = message_ids
            .iter()
            .map(|id| id as &dyn rusqlite::ToSql)
            .collect();

        let deleted = conn
            .execute(&sql, params.as_slice())
            .context("Failed to ack batch")?;

        debug!("Acknowledged {} messages in batch", deleted);
        Ok(deleted)
    }

    /// Clean up expired messages
    fn cleanup_expired(&self, conn: &Connection) -> Result<usize> {
        if self.max_age_secs == 0 {
            return Ok(0);
        }

        // v1.2.6: Safe timestamp calculation to prevent overflow on large max_age_secs
        let max_age_millis = (self.max_age_secs as i64)
            .checked_mul(1000)
            .unwrap_or(i64::MAX);
        let cutoff = chrono::Utc::now().timestamp_millis() - max_age_millis;

        let deleted = conn
            .execute(
                "DELETE FROM message_queue WHERE created_at < ?1",
                params![cutoff],
            )
            .context("Failed to cleanup expired messages")?;

        if deleted > 0 {
            info!("Cleaned up {} expired messages from offline queue", deleted);
        }

        Ok(deleted)
    }

    /// Get queue statistics
    pub fn stats(&self) -> Result<QueueStats> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        let total_messages: usize = conn
            .query_row("SELECT COUNT(*) FROM message_queue", [], |row| row.get(0))
            .context("Failed to query message count")?;

        // Count by priority
        // v1.2.4: Priority array for Low(0), Normal(1), High(2), Critical(3)
        let mut by_priority = [0usize; 4];
        let mut stmt =
            conn.prepare("SELECT priority, COUNT(*) FROM message_queue GROUP BY priority")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, u8>(0)?, row.get::<_, usize>(1)?))
        })?;
        for row in rows.flatten() {
            let (priority, count) = row;
            if priority < 4 {
                by_priority[priority as usize] = count;
            } else {
                // v1.2.4: Log corrupted priority values instead of silently dropping
                warn!(
                    "Offline queue contains {} messages with invalid priority {} (expected 0-3)",
                    count, priority
                );
            }
        }

        // Oldest message age
        let oldest_message_age_secs = conn
            .query_row("SELECT MIN(created_at) FROM message_queue", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .ok()
            .flatten()
            .map(|oldest| {
                let now = chrono::Utc::now().timestamp_millis();
                ((now - oldest) / 1000) as u64
            });

        // Total bytes (payload + topic)
        let total_bytes: usize = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(topic) + LENGTH(payload)), 0) FROM message_queue",
                [],
                |row| row.get(0),
            )
            .context("Failed to query total bytes")?;

        // v1.2.0: Database file size
        let db_size_bytes = self.get_db_size(&conn);
        let disk_usage_percent = if self.max_disk_bytes > 0 {
            (db_size_bytes as f32 / self.max_disk_bytes as f32) * 100.0
        } else {
            0.0
        };

        Ok(QueueStats {
            total_messages,
            by_priority,
            oldest_message_age_secs,
            total_bytes,
            db_size_bytes,
            disk_usage_percent,
        })
    }

    /// Clear all messages from queue
    pub fn clear(&self) -> Result<usize> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        let deleted = conn
            .execute("DELETE FROM message_queue", [])
            .context("Failed to clear queue")?;

        info!("Cleared {} messages from offline queue", deleted);
        Ok(deleted)
    }

    /// Check if queue is empty
    pub fn is_empty(&self) -> bool {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(_) => return true,
        };

        let count: usize = conn
            .query_row("SELECT COUNT(*) FROM message_queue", [], |row| row.get(0))
            .unwrap_or(0);

        count == 0
    }

    /// Get current queue length
    pub fn len(&self) -> usize {
        let conn = match self.conn.lock() {
            Ok(c) => c,
            Err(e) => {
                // v1.2.6: Log poisoned mutex instead of silent failure
                tracing::error!("Queue database mutex poisoned: {}", e);
                return 0;
            }
        };

        conn.query_row("SELECT COUNT(*) FROM message_queue", [], |row| row.get(0))
            .unwrap_or(0)
    }

    /// Vacuum the database to reclaim disk space (v1.2.2)
    ///
    /// SQLite doesn't automatically reclaim space from deleted rows.
    /// This method should be called periodically (e.g., after batch acks)
    /// or when disk usage is high.
    ///
    /// # Returns
    /// * `Ok((before, after))` - Bytes before and after VACUUM
    /// * `Err` if VACUUM fails
    pub fn vacuum(&self) -> Result<(u64, u64)> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        let before = self.get_db_size(&conn);

        conn.execute("VACUUM", [])
            .context("Failed to VACUUM database")?;

        let after = self.get_db_size(&conn);

        if before > after {
            info!(
                "VACUUM reclaimed {} bytes ({} -> {} bytes)",
                before - after,
                before,
                after
            );
        } else {
            debug!("VACUUM completed (no space reclaimed)");
        }

        Ok((before, after))
    }

    /// Vacuum if disk usage exceeds threshold (v1.2.2)
    ///
    /// Only runs VACUUM if:
    /// 1. Database size exceeds 80% of max_disk_bytes
    /// 2. There have been significant deletes (freelist pages > 10%)
    ///
    /// # Returns
    /// * `Some((before, after))` if VACUUM was run
    /// * `None` if VACUUM was skipped
    pub fn vacuum_if_needed(&self) -> Result<Option<(u64, u64)>> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;

        // Skip if no disk limit set
        if self.max_disk_bytes == 0 {
            return Ok(None);
        }

        let db_size = self.get_db_size(&conn);
        // v1.2.6: Use integer arithmetic to avoid f64 precision loss on large values
        let threshold = self.max_disk_bytes * 4 / 5; // 80% threshold

        // Check freelist pages (space available for reuse)
        let freelist_count: i64 = conn
            .query_row("PRAGMA freelist_count", [], |row| row.get(0))
            .context("Failed to query freelist count")?;
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap_or(1); // Safe: page_count is always >= 1

        let freelist_ratio = freelist_count as f64 / page_count as f64;

        // VACUUM if usage > 80% OR freelist > 10% of pages
        if db_size > threshold || freelist_ratio > 0.10 {
            drop(conn); // Release lock before vacuum
            let result = self.vacuum()?;
            return Ok(Some(result));
        }

        Ok(None)
    }

    /// 2026-04-29 enterprise graceful-shutdown checkpoint.
    ///
    /// What it solves: shutdown no longer logs an offline-queue flush while
    /// doing no persistence work. The method forces a SQLite WAL checkpoint
    /// and then fsyncs the DB, WAL/SHM sidecars when present, and parent
    /// directory so queued MQTT messages survive process exit and power-loss
    /// windows as far as the underlying filesystem allows.
    pub fn checkpoint_and_fsync(&self) -> Result<()> {
        let conn = acquire_sqlite_lock(&self.conn, &self.poison_health_verified)?;
        conn.execute_batch(
            "
            PRAGMA synchronous=FULL;
            PRAGMA wal_checkpoint(FULL);
            ",
        )
        .context("Failed to checkpoint offline queue WAL")?;
        drop(conn);

        if let Some(db_path) = self.db_path.as_ref() {
            sync_file_if_exists(db_path)?;

            let wal_path = sqlite_sidecar_path(db_path, "-wal");
            sync_file_if_exists(&wal_path)?;

            let shm_path = sqlite_sidecar_path(db_path, "-shm");
            sync_file_if_exists(&shm_path)?;

            if let Some(parent) = db_path.parent() {
                sync_file_if_exists(parent)?;
            }
        }

        info!("Offline queue WAL checkpoint + fsync completed");
        Ok(())
    }

    /// Create a backup using VACUUM INTO (v1.2.4)
    ///
    /// Creates a consistent, compact backup of the database to the specified path.
    /// Unlike regular file copy, VACUUM INTO:
    /// - Creates a consistent snapshot even during writes
    /// - Compacts the database (removes fragmentation)
    /// - Is atomic (backup is complete or doesn't exist)
    ///
    /// # Arguments
    /// * `backup_path` - Path for the backup file (will be overwritten if exists)
    ///
    /// # Example
    /// ```ignore
    /// queue.backup_to("/var/backups/offline_queue_2024-01-15.db")?;
    /// ```
    pub fn backup_to(&self, backup_path: &str) -> Result<u64> {
        // Strict allowlist validation to prevent SQL injection in VACUUM INTO
        // VACUUM INTO does not support parameterized queries, so we must sanitize the path.
        // Only allow: alphanumeric, forward slash, backslash, hyphen, underscore, dot
        if backup_path.is_empty() {
            anyhow::bail!("Backup path cannot be empty");
        }
        let path_is_safe = backup_path
            .chars()
            .all(|c| c.is_alphanumeric() || "/\\-_.".contains(c));
        if !path_is_safe {
            anyhow::bail!(
                "Backup path contains characters not allowed by security policy \
                 (only alphanumeric, /, \\, -, _, . are permitted): {}",
                backup_path
            );
        }

        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("Failed to lock database connection: {}", e))?;

        // VACUUM INTO creates an atomic backup
        // Path is validated above to not contain SQL injection vectors
        conn.execute(&format!("VACUUM INTO '{}'", backup_path), [])
            .with_context(|| format!("Failed to backup database to {}", backup_path))?;

        // Get backup file size
        let backup_size = std::fs::metadata(backup_path).map(|m| m.len()).unwrap_or(0);

        info!(
            backup_path = %backup_path,
            size_bytes = backup_size,
            "Database backup created successfully"
        );

        Ok(backup_size)
    }

    /// Create a rolling backup with timestamp (v1.2.4)
    ///
    /// Creates a backup file with timestamp in the specified directory.
    /// Automatically cleans up old backups if count exceeds max_backups.
    ///
    /// # Arguments
    /// * `backup_dir` - Directory for backup files
    /// * `max_backups` - Maximum number of backup files to keep (0 = unlimited)
    ///
    /// # Returns
    /// * Path to the created backup file
    pub fn backup_rolling(&self, backup_dir: &str, max_backups: usize) -> Result<String> {
        use chrono::Local;
        use std::fs;

        // Create backup directory if needed
        fs::create_dir_all(backup_dir)
            .with_context(|| format!("Failed to create backup directory: {}", backup_dir))?;

        // Generate timestamped filename
        let timestamp = Local::now().format("%Y%m%d_%H%M%S");
        let backup_path = format!("{}/offline_queue_{}.db", backup_dir, timestamp);

        // Create backup
        self.backup_to(&backup_path)?;

        // Clean up old backups if needed
        if max_backups > 0 {
            self.cleanup_old_backups(backup_dir, max_backups)?;
        }

        Ok(backup_path)
    }

    /// Clean up old backup files, keeping only the most recent ones
    fn cleanup_old_backups(&self, backup_dir: &str, max_backups: usize) -> Result<()> {
        use std::fs;

        let mut backups: Vec<_> = fs::read_dir(backup_dir)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("offline_queue_")
                    && entry.file_name().to_string_lossy().ends_with(".db")
            })
            .collect();

        // Sort by modified time (oldest first)
        backups.sort_by_key(|entry| {
            entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });

        // Remove oldest backups if we have too many
        while backups.len() > max_backups {
            if let Some(oldest) = backups.first() {
                let path = oldest.path();
                if let Err(e) = fs::remove_file(&path) {
                    warn!(path = %path.display(), error = %e, "Failed to remove old backup");
                } else {
                    debug!(path = %path.display(), "Removed old backup");
                }
                backups.remove(0);
            }
        }

        Ok(())
    }

    /// Run SQLite integrity check (v1.2.4)
    ///
    /// Performs PRAGMA integrity_check to verify database consistency.
    /// Returns Ok(true) if database is healthy, Ok(false) if corruption detected.
    ///
    /// # SRE Note
    /// Run this periodically (e.g., daily or on startup) to detect corruption early.
    /// If corruption is detected, restore from backup and investigate root cause.
    pub fn integrity_check(&self) -> Result<IntegrityCheckResult> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("Failed to lock database connection: {}", e))?;

        let mut stmt = conn.prepare("PRAGMA integrity_check")?;
        let results: Vec<String> = stmt
            .query_map([], |row: &rusqlite::Row| row.get(0))?
            .filter_map(|r: std::result::Result<String, _>| r.ok())
            .collect();

        let is_ok = results.len() == 1 && results[0] == "ok";

        if is_ok {
            info!("SQLite integrity check passed");
            Ok(IntegrityCheckResult {
                is_healthy: true,
                errors: vec![],
            })
        } else {
            error!(
                errors = ?results,
                "SQLite integrity check FAILED - database may be corrupted"
            );
            Ok(IntegrityCheckResult {
                is_healthy: false,
                errors: results,
            })
        }
    }

    /// Quick integrity check using PRAGMA quick_check (v1.2.4)
    ///
    /// Faster than full integrity_check but less thorough.
    /// Good for frequent checks (e.g., after each restart).
    pub fn quick_check(&self) -> Result<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("Failed to lock database connection: {}", e))?;

        let result: String =
            conn.query_row("PRAGMA quick_check", [], |row: &rusqlite::Row| row.get(0))?;
        Ok(result == "ok")
    }
}

/// Result of SQLite integrity check
#[derive(Debug, Clone)]
pub struct IntegrityCheckResult {
    /// True if database passed all checks
    pub is_healthy: bool,
    /// List of errors found (empty if healthy)
    pub errors: Vec<String>,
}

// ============================================================================
// Async Wrapper (v1.2.4)
// ============================================================================

/// Async wrapper for OfflineQueue that uses spawn_blocking
///
/// All SQLite operations are wrapped in `tokio::task::spawn_blocking` to
/// prevent blocking the async runtime. This is important for high-throughput
/// scenarios where multiple async tasks access the queue concurrently.
///
/// # Example
/// ```ignore
/// let queue = AsyncOfflineQueue::new(OfflineQueue::new(path, 1000, 3600)?);
/// queue.enqueue_async("topic", "payload", MessagePriority::Normal, 1, false).await?;
/// ```
/// EDGE-CRITICAL-004: in-memory half of the Hi/Lo `edge_seq` allocator.
/// `next` is the next id to hand out; `ceiling` is the exclusive top of the
/// currently-reserved block. When `next == ceiling` a new block is reserved
/// from the persisted `edge_seq_state` high-water-mark.
#[derive(Default)]
struct EdgeSeqAllocator {
    next: u64,
    ceiling: u64,
}

/// EDGE-CRITICAL-004: how many `edge_seq` values to reserve per SQLite
/// round-trip. Keeps the telemetry hot path (io_data every 100-500 ms) off a
/// per-message disk write; a crash wastes at most this many ids (harmless).
const EDGE_SEQ_BLOCK: u64 = 256;

pub struct AsyncOfflineQueue {
    inner: std::sync::Arc<OfflineQueue>,
    /// Optional HealthState for Batch 105 observability
    /// instrumentation. Set via `with_health_state` post-
    /// construction. When Some, enqueue/ack operations
    /// increment the offline-queue counter family +
    /// update the queue-size gauge. None = no-op.
    health_state: Option<crate::health::HealthState>,
    /// EDGE-CRITICAL-004: Hi/Lo allocator state for the outbound edge_seq
    /// idempotency counter. Guarded by an async mutex; the block-reserve
    /// SQLite write happens under it via spawn_blocking.
    edge_seq: tokio::sync::Mutex<EdgeSeqAllocator>,
}

impl AsyncOfflineQueue {
    /// Create a new async wrapper around an OfflineQueue
    pub fn new(queue: OfflineQueue) -> Self {
        Self {
            inner: std::sync::Arc::new(queue),
            health_state: None,
            edge_seq: tokio::sync::Mutex::new(EdgeSeqAllocator::default()),
        }
    }

    /// Create from an existing `Arc<OfflineQueue>`
    pub fn from_arc(queue: std::sync::Arc<OfflineQueue>) -> Self {
        Self {
            inner: queue,
            health_state: None,
            edge_seq: tokio::sync::Mutex::new(EdgeSeqAllocator::default()),
        }
    }

    /// EDGE-CRITICAL-004: allocate the next strictly-monotonic, never-reused
    /// `edge_seq`. Hands out from the in-memory block; reserves a fresh block
    /// from the persisted high-water-mark (via spawn_blocking) when exhausted.
    /// The value survives restart because the persisted `reserved_hwm` only
    /// increases, so `(device_id, edge_seq)` is a stable idempotency key a
    /// backend consumer can dedup store-and-forward replays against.
    pub async fn alloc_edge_seq(&self) -> Result<u64> {
        let mut alloc = self.edge_seq.lock().await;
        if alloc.next >= alloc.ceiling {
            let queue = std::sync::Arc::clone(&self.inner);
            let new_ceiling =
                tokio::task::spawn_blocking(move || queue.reserve_seq_block(EDGE_SEQ_BLOCK))
                    .await
                    .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))??;
            // The reserved block is [new_ceiling - EDGE_SEQ_BLOCK, new_ceiling).
            alloc.next = new_ceiling.saturating_sub(EDGE_SEQ_BLOCK);
            alloc.ceiling = new_ceiling;
        }
        let seq = alloc.next;
        alloc.next += 1;
        Ok(seq)
    }

    /// Batch 105 observability wire. Attach a HealthState so
    /// enqueue/ack paths update counters + the queue-size
    /// gauge. Builder-style so existing call sites keep
    /// working; only main.rs init_offline_queue wires this.
    pub fn with_health_state(mut self, health_state: crate::health::HealthState) -> Self {
        self.health_state = Some(health_state);
        self
    }

    /// Get a clone of the inner Arc for sharing
    pub fn inner(&self) -> std::sync::Arc<OfflineQueue> {
        self.inner.clone()
    }

    /// Async enqueue - wraps blocking SQLite operation in spawn_blocking
    pub async fn enqueue_async(
        &self,
        topic: &str,
        payload: &str,
        priority: MessagePriority,
        qos: u8,
        retain: bool,
    ) -> Result<i64> {
        let queue = self.inner.clone();
        let topic = topic.to_string();
        let payload = payload.to_string();

        let result = tokio::task::spawn_blocking(move || {
            queue.enqueue(&topic, &payload, priority, qos, retain)
        })
        .await
        .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?;

        // Batch 105: on successful enqueue, bump the
        // "queued_total" lifetime counter + refresh the
        // queue-size gauge. Errors don't change either.
        if result.is_ok() {
            if let Some(hs) = self.health_state.as_ref() {
                hs.inc_offline_queued();
                hs.set_offline_queue_size(self.inner.len() as u64);
            }
        }

        result
    }

    /// Async peek - get next message without removing
    pub async fn peek_async(&self) -> Result<Option<QueuedMessage>> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.peek())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async ack - acknowledge and remove message
    pub async fn ack_async(&self, message_id: i64) -> Result<bool> {
        let queue = self.inner.clone();

        let result = tokio::task::spawn_blocking(move || queue.ack(message_id))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?;

        // Batch 105: on successful ack, bump the "sent_total"
        // lifetime counter (ack = message delivered +
        // removed from queue) + refresh the queue-size
        // gauge.
        if matches!(result, Ok(true)) {
            if let Some(hs) = self.health_state.as_ref() {
                hs.inc_offline_sent();
                hs.set_offline_queue_size(self.inner.len() as u64);
            }
        }

        result
    }

    /// Async nack - mark message for retry
    pub async fn nack_async(&self, message_id: i64) -> Result<()> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.nack(message_id))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async peek_batch - get multiple messages
    pub async fn peek_batch_async(&self, max_count: usize) -> Result<Vec<QueuedMessage>> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.peek_batch(max_count))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async ack_batch - acknowledge multiple messages
    pub async fn ack_batch_async(&self, message_ids: Vec<i64>) -> Result<usize> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.ack_batch(&message_ids))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async stats - get queue statistics
    pub async fn stats_async(&self) -> Result<QueueStats> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.stats())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async clear - remove all messages
    pub async fn clear_async(&self) -> Result<usize> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.clear())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async vacuum - reclaim disk space
    pub async fn vacuum_async(&self) -> Result<(u64, u64)> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.vacuum())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async vacuum_if_needed - conditionally reclaim disk space
    pub async fn vacuum_if_needed_async(&self) -> Result<Option<(u64, u64)>> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.vacuum_if_needed())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// 2026-04-29 enterprise graceful-shutdown checkpoint.
    ///
    /// What it solves: shutdown can run WAL checkpoint + fsync without
    /// blocking the async runtime thread.
    pub async fn checkpoint_and_fsync_async(&self) -> Result<()> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.checkpoint_and_fsync())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async integrity check - verify database consistency
    pub async fn integrity_check_async(&self) -> Result<IntegrityCheckResult> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.integrity_check())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async quick check - fast database health check
    pub async fn quick_check_async(&self) -> Result<bool> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.quick_check())
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async backup to specific path
    pub async fn backup_to_async(&self, backup_path: String) -> Result<u64> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.backup_to(&backup_path))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Async rolling backup with automatic cleanup
    pub async fn backup_rolling_async(
        &self,
        backup_dir: String,
        max_backups: usize,
    ) -> Result<String> {
        let queue = self.inner.clone();

        tokio::task::spawn_blocking(move || queue.backup_rolling(&backup_dir, max_backups))
            .await
            .map_err(|e| anyhow::anyhow!("spawn_blocking join error: {}", e))?
    }

    /// Sync len (doesn't need spawn_blocking - very fast query)
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    /// Sync is_empty
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Clone for AsyncOfflineQueue {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            health_state: self.health_state.clone(),
            // EDGE-CRITICAL-004: a fresh allocator per clone is safe — each
            // reserves its own non-overlapping block from the shared,
            // atomically-bumped persisted high-water-mark, so no two clones
            // can hand out the same edge_seq.
            edge_seq: tokio::sync::Mutex::new(EdgeSeqAllocator::default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-wide shared key-path sandbox (Batch 88 / 90 / 96
    /// architecture). Set ONCE on first backup-test
    /// invocation; the Batch 96 `OnceLock<String>` cache
    /// inside `derive_db_encryption_key` then latches the
    /// derived hex + all subsequent calls return the cached
    /// value without re-reading the env or filesystem — the
    /// root-cause architectural fix for the parallel-test
    /// race that previously required a Mutex guard.
    ///
    /// Tests that need the sandbox call `ensure_key_sandbox()`
    /// which triggers LazyLock init (sets env) + returns.
    /// Subsequent calls are no-op. First call that reaches
    /// `derive_db_encryption_key` does the derivation using
    /// the sandbox path; OnceLock caches; all further tests
    /// see the cached value regardless of thread interleaving.
    static TEST_KEY_PATH_INIT: std::sync::LazyLock<std::path::PathBuf> =
        std::sync::LazyLock::new(|| {
            let dir = std::env::temp_dir()
                .join(format!("suderra-offline-queue-test-{}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("mkdir test key dir");
            let path = dir.join("db.key");
            // SAFETY: set_var happens ONCE inside LazyLock::
            // new (internal synchronization). Correct
            // memory-ordering visibility is guaranteed by
            // Batch 96's OnceLock<String> cache in
            // derive_db_encryption_key — once any thread
            // latches the derived hex, no thread re-reads
            // the env regardless of interleaving.
            unsafe {
                std::env::set_var("SUDERRA_DB_KEY_PATH", &path);
            }
            path
        });

    fn ensure_key_sandbox() {
        let path = &*TEST_KEY_PATH_INIT;
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() >= crate::db_secret::MIN_SECRET_KEY_LEN => {}
            _ => {
                std::fs::write(path, vec![0xA5u8; 32]).expect("seed test db key");
            }
        }
        // SAFETY: tests in this binary mutate process-wide env. Re-setting the
        // canonical sandbox path on every caller keeps v1 fallback tests from
        // inheriting a transient path left by another env-mutating test.
        unsafe {
            std::env::set_var("SUDERRA_DB_KEY_PATH", path);
        }
    }

    // EDGE-CRITICAL-004: the outbound edge_seq idempotency counter.

    #[test]
    fn reserve_seq_block_is_monotonic_and_non_overlapping() {
        let queue = OfflineQueue::in_memory(100).unwrap();
        let a = queue.reserve_seq_block(256).unwrap();
        let b = queue.reserve_seq_block(256).unwrap();
        let c = queue.reserve_seq_block(10).unwrap();
        // Each reservation advances the high-water-mark by exactly `block`.
        assert_eq!(a, 256);
        assert_eq!(b, 512);
        assert_eq!(c, 522);
        // Blocks [0,256), [256,512), [512,522) do not overlap.
    }

    #[tokio::test]
    async fn alloc_edge_seq_is_strictly_monotonic() {
        let queue = AsyncOfflineQueue::new(OfflineQueue::in_memory(100).unwrap());
        let mut prev = None;
        // Cross a block boundary (EDGE_SEQ_BLOCK = 256) to exercise re-reserve.
        for _ in 0..300u32 {
            let seq = queue.alloc_edge_seq().await.unwrap();
            if let Some(p) = prev {
                assert_eq!(seq, p + 1, "edge_seq must be strictly monotonic +1");
            }
            prev = Some(seq);
        }
    }

    #[test]
    fn reserve_seq_block_never_regresses_across_reopen() {
        ensure_key_sandbox();
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("oq-seq.db");

        let handed_out_ceiling;
        {
            let queue = OfflineQueue::new(&path, 100, 3600).expect("open 1");
            let _ = queue.reserve_seq_block(256).unwrap();
            handed_out_ceiling = queue.reserve_seq_block(256).unwrap(); // hwm = 512
        }
        // Reopen the SAME db file — a fresh boot must resume STRICTLY above
        // every id ever handed out, so no seq can be reused.
        {
            let queue = OfflineQueue::new(&path, 100, 3600).expect("open 2");
            let after_reopen = queue.reserve_seq_block(256).unwrap();
            assert!(
                after_reopen > handed_out_ceiling,
                "reserved hwm must not regress across restart (was {}, got {})",
                handed_out_ceiling,
                after_reopen
            );
        }
    }

    #[test]
    fn test_enqueue_dequeue() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        let id = queue
            .enqueue(
                "test/topic",
                r#"{"value": 42}"#,
                MessagePriority::Normal,
                1,
                false,
            )
            .unwrap();

        let msg = queue.peek().unwrap().unwrap();
        assert_eq!(msg.id, id);
        assert_eq!(msg.topic, "test/topic");
        assert_eq!(msg.priority, MessagePriority::Normal);

        queue.ack(id).unwrap();
        assert!(queue.is_empty());
    }

    #[test]
    fn test_priority_ordering() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        // Enqueue in reverse priority order
        queue
            .enqueue("low", "low", MessagePriority::Low, 1, false)
            .unwrap();
        queue
            .enqueue("normal", "normal", MessagePriority::Normal, 1, false)
            .unwrap();
        queue
            .enqueue("high", "high", MessagePriority::High, 1, false)
            .unwrap();
        queue
            .enqueue("critical", "critical", MessagePriority::Critical, 1, false)
            .unwrap();

        // Should dequeue in priority order (highest first)
        let msg1 = queue.peek().unwrap().unwrap();
        assert_eq!(msg1.topic, "critical");
        queue.ack(msg1.id).unwrap();

        let msg2 = queue.peek().unwrap().unwrap();
        assert_eq!(msg2.topic, "high");
        queue.ack(msg2.id).unwrap();

        let msg3 = queue.peek().unwrap().unwrap();
        assert_eq!(msg3.topic, "normal");
        queue.ack(msg3.id).unwrap();

        let msg4 = queue.peek().unwrap().unwrap();
        assert_eq!(msg4.topic, "low");
        queue.ack(msg4.id).unwrap();

        assert!(queue.is_empty());
    }

    #[test]
    fn test_capacity_eviction() {
        let queue = OfflineQueue::in_memory(3).unwrap();

        // Fill queue
        queue
            .enqueue("msg1", "1", MessagePriority::Low, 1, false)
            .unwrap();
        queue
            .enqueue("msg2", "2", MessagePriority::Normal, 1, false)
            .unwrap();
        queue
            .enqueue("msg3", "3", MessagePriority::High, 1, false)
            .unwrap();

        assert_eq!(queue.len(), 3);

        // Add another - should evict lowest priority (msg1)
        queue
            .enqueue("msg4", "4", MessagePriority::Critical, 1, false)
            .unwrap();

        assert_eq!(queue.len(), 3);

        // Verify msg1 was evicted
        let messages = queue.peek_batch(10).unwrap();
        let topics: Vec<&str> = messages.iter().map(|m| m.topic.as_str()).collect();
        assert!(!topics.contains(&"msg1"));
        assert!(topics.contains(&"msg4"));
    }

    #[test]
    fn test_batch_operations() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        // Enqueue multiple
        for i in 0..5 {
            queue
                .enqueue(
                    &format!("topic{}", i),
                    &format!("{}", i),
                    MessagePriority::Normal,
                    1,
                    false,
                )
                .unwrap();
        }

        // Peek batch
        let batch = queue.peek_batch(3).unwrap();
        assert_eq!(batch.len(), 3);

        // Ack batch
        let ids: Vec<i64> = batch.iter().map(|m| m.id).collect();
        let acked = queue.ack_batch(&ids).unwrap();
        assert_eq!(acked, 3);
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn test_stats() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        queue
            .enqueue("topic1", "payload1", MessagePriority::Low, 1, false)
            .unwrap();
        queue
            .enqueue("topic2", "payload2", MessagePriority::High, 1, false)
            .unwrap();
        queue
            .enqueue("topic3", "payload3", MessagePriority::High, 1, false)
            .unwrap();

        let stats = queue.stats().unwrap();
        assert_eq!(stats.total_messages, 3);
        assert_eq!(stats.by_priority[MessagePriority::Low as usize], 1);
        assert_eq!(stats.by_priority[MessagePriority::High as usize], 2);
        assert!(stats.total_bytes > 0);
    }

    #[test]
    fn test_nack_retry() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        let id = queue
            .enqueue("topic", "payload", MessagePriority::Normal, 1, false)
            .unwrap();

        let msg1 = queue.peek().unwrap().unwrap();
        assert_eq!(msg1.retry_count, 0);

        // Nack (mark for retry)
        queue.nack(id).unwrap();

        let msg2 = queue.peek().unwrap().unwrap();
        assert_eq!(msg2.retry_count, 1);
        assert_eq!(msg2.id, id); // Same message, incremented retry count
    }

    #[test]
    fn test_clear() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        for i in 0..10 {
            queue
                .enqueue(
                    &format!("topic{}", i),
                    "payload",
                    MessagePriority::Normal,
                    1,
                    false,
                )
                .unwrap();
        }

        assert_eq!(queue.len(), 10);

        let cleared = queue.clear().unwrap();
        assert_eq!(cleared, 10);
        assert!(queue.is_empty());
    }

    #[test]
    fn test_integrity_check() {
        let queue = OfflineQueue::in_memory(100).unwrap();

        // Fresh database should pass integrity check
        let result = queue.integrity_check().unwrap();
        assert!(result.is_healthy);
        assert!(result.errors.is_empty());

        // Quick check should also pass
        assert!(queue.quick_check().unwrap());

        // Add some data and check again
        queue
            .enqueue("test", "payload", MessagePriority::Normal, 1, false)
            .unwrap();
        let result2 = queue.integrity_check().unwrap();
        assert!(result2.is_healthy);
    }

    #[test]
    fn test_backup_to() {
        // Batch 88/90/96: sandbox the SUDERRA_DB_KEY_PATH
        // before first derive_db_encryption_key call. Batch
        // 96's OnceLock cache in the derive function makes
        // the Mutex guard unnecessary — the first call
        // latches the derived hex; parallel tests are safe.
        ensure_key_sandbox();
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let backup_path = temp_dir.path().join("backup.db");

        // Create queue with some data
        let queue = OfflineQueue::new(&db_path, 100, 3600).unwrap();
        queue
            .enqueue("test", "payload", MessagePriority::Normal, 1, false)
            .unwrap();

        // Create backup
        let size = queue.backup_to(backup_path.to_str().unwrap()).unwrap();
        assert!(size > 0);
        assert!(backup_path.exists());

        // Verify backup is valid by opening it
        let backup_queue = OfflineQueue::new(&backup_path, 100, 3600).unwrap();
        assert_eq!(backup_queue.len(), 1);
    }

    #[test]
    fn test_backup_rolling() {
        ensure_key_sandbox();
        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("test.db");
        let backup_dir = temp_dir.path().join("backups");

        // Create queue with some data
        let queue = OfflineQueue::new(&db_path, 100, 3600).unwrap();
        queue
            .enqueue("test", "payload", MessagePriority::Normal, 1, false)
            .unwrap();

        // Create rolling backup
        let backup_path = queue
            .backup_rolling(backup_dir.to_str().unwrap(), 3)
            .unwrap();
        assert!(std::path::Path::new(&backup_path).exists());
        assert!(backup_path.contains("offline_queue_"));
    }

    // -------- Batch #13 — manifest-aware constructor tests --------
    //
    // Validates that `with_keystore_derivation` reads
    // the per-DB sidecar manifest, picks the correct
    // derivation path (v1 fallback for missing /
    // legacy manifest, v2 for keystore-derived
    // manifest), and successfully opens the DB +
    // initializes the schema.
    //
    // The tests reuse the existing `ensure_key_sandbox`
    // helper for the secret-key path, plus their own
    // tempdir for the DB + manifest sidecar.

    use crate::db_migration::manifest::{
        DbKeySourceManifest, manifest_path_for_db, write_manifest,
    };
    use crate::db_migration::schema_version::DbKeySchemaVersion;
    use crate::keystore::error::{KeyDerivationError, KeystoreError, KeystoreErrorKind};
    use crate::keystore::purpose::{DerivedKeyId, KeyPurpose};
    use crate::keystore::secret::KeyMaterial;
    use crate::keystore::{KeyBackend, RotationSource};
    use async_trait::async_trait;

    /// Stub keystore returning a deterministic 32-byte
    /// derived key (0xb1 prefix for SqlCipherOfflineQueue).
    /// Mirrors the pattern in cli_executor / cli_runtime
    /// tests.
    struct OfflineQueueStubKeystore;

    #[async_trait]
    impl crate::keystore::Keystore for OfflineQueueStubKeystore {
        fn backend(&self) -> KeyBackend {
            KeyBackend::FileBacked
        }

        async fn derive_key(
            &self,
            purpose: KeyPurpose,
            _context: &[u8],
        ) -> std::result::Result<KeyMaterial, KeyDerivationError> {
            let mut bytes = [0u8; 32];
            bytes[0] = match purpose {
                KeyPurpose::SqlCipherOfflineQueue => 0xb1,
                _ => 0xff,
            };
            Ok(KeyMaterial::from_derived_bytes(purpose, bytes))
        }

        fn derived_key_id(&self, _purpose: KeyPurpose, _context: &[u8]) -> DerivedKeyId {
            DerivedKeyId([0u8; 16])
        }

        async fn rotate_master(&self) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }

        async fn rotate_master_with_source(
            &self,
            _source: RotationSource<'_>,
        ) -> std::result::Result<(), KeystoreError> {
            Err(KeystoreError::new(
                KeystoreErrorKind::NotImplemented,
                String::from("stub"),
            ))
        }
    }

    #[tokio::test]
    async fn with_keystore_derivation_no_manifest_uses_v1_legacy_default() {
        // Missing manifest → resolver returns v1 default
        // per Batch #330 boot-detector architectural
        // decision. The constructor opens the DB with
        // the v1-derived key + initializes schema.
        ensure_key_sandbox();
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("offline_queue.db");

        let queue = OfflineQueue::with_keystore_derivation(
            &db_path,
            100,
            3600,
            DEFAULT_MAX_DISK_BYTES,
            std::sync::Arc::new(OfflineQueueStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await
        .expect("open with v1 fallback");

        // Schema initialized + queue empty.
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn with_keystore_derivation_v2_manifest_opens_with_keystore_key() {
        // Pre-seed: open the DB with the v2-keystore-
        // derived key directly (mirrors what the
        // migration ceremony would do). Write a v2
        // manifest. Then with_keystore_derivation should
        // read the v2 manifest + open the DB with the
        // keystore-derived key (NOT the v1 fallback).
        ensure_key_sandbox();
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("offline_queue.db");

        // Compute the v2 key the resolver will produce.
        let v2_bytes = {
            let mut b = [0u8; 32];
            b[0] = 0xb1;
            b
        };
        let v2_hex = crate::db_migration::v1_legacy_key::format_sqlcipher_pragma_key_hex(&v2_bytes);

        // Seed the DB encrypted under v2.
        {
            let conn = Connection::open(&db_path).expect("open");
            // Seeds a v2-encrypted DB fixture directly, not via a production opener.
            // INVARIANT-ALLOW: sqlcipher-test-seed
            conn.execute_batch(&format!("PRAGMA key = \"x'{}'\";", v2_hex))
                .expect("apply v2 key");
            conn.execute_batch(
                "CREATE TABLE seed (id INTEGER PRIMARY KEY); \
                 INSERT INTO seed VALUES (1);",
            )
            .expect("seed");
        }

        // Write v2 manifest sidecar.
        write_manifest(
            &manifest_path_for_db(&db_path),
            &DbKeySourceManifest {
                schema_version: DbKeySchemaVersion::V2KeystoreDerived,
                last_updated_at_unix_secs: 1_700_000_000,
            },
        )
        .expect("seed v2 manifest");

        // Constructor should read v2 manifest + open
        // with keystore-derived key. If the resolver
        // mis-routes (v1 instead of v2), the DB would
        // fail to open with `not a database`.
        let queue = OfflineQueue::with_keystore_derivation(
            &db_path,
            100,
            3600,
            DEFAULT_MAX_DISK_BYTES,
            std::sync::Arc::new(OfflineQueueStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await
        .expect("open with v2 keystore key");

        // After the constructor's init_schema runs,
        // the queue is functional.
        assert!(queue.is_empty());
    }

    #[tokio::test]
    async fn with_keystore_derivation_corrupt_manifest_fails_closed() {
        ensure_key_sandbox();
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("offline_queue.db");

        // Write a corrupt manifest sidecar.
        std::fs::write(manifest_path_for_db(&db_path), b"not valid json").expect("seed corrupt");

        let result = OfflineQueue::with_keystore_derivation(
            &db_path,
            100,
            3600,
            DEFAULT_MAX_DISK_BYTES,
            std::sync::Arc::new(OfflineQueueStubKeystore),
            b"deployment-uuid".to_vec(),
        )
        .await;

        // Resolver fails → constructor returns Err. The
        // DB is NOT silently opened with a guessed key
        // (would brick the DB if guess is wrong).
        assert!(result.is_err());
        let err = match result {
            Ok(_) => panic!("expected error"),
            Err(e) => e,
        };
        let msg = format!("{:#}", err);
        assert!(
            msg.contains("resolver failed"),
            "expected resolver-failed error, got: {msg}"
        );
    }
}
