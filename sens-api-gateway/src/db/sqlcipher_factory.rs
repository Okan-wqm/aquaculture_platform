//! Canonical SQLCipher connection factory (EDGE-HIGH-026).
//!
//! # Why this exists
//!
//! Before this module, every SQLCipher-backed store hand-rolled its own
//! `Connection::open` + `PRAGMA key = "x'…'"` + journal/synchronous/
//! busy_timeout sequence. That produced three divergent pragma profiles,
//! no `auto_vacuum` discipline, and — most dangerously — ~19 independent
//! copies of the raw-key application logic, any of which could drift from
//! the others (the structural enabler of the EDGE-CRITICAL-002
//! key-derivation defect class).
//!
//! This factory is the SINGLE owner of:
//!   * the `PRAGMA key = "x'<hex>'"` raw-key literal, and
//!   * the canonical durability/security pragma sequence, emitted in the
//!     correct order (before any `CREATE TABLE`, so `auto_vacuum` is not a
//!     silent no-op on a fresh database).
//!
//! Stores keep their existing `Self { conn: Mutex::new(conn), … }` shape:
//! the factory returns a bare [`rusqlite::Connection`], so adopting it is a
//! localized change with zero struct-field ripple.
//!
//! Two entry points express the finding's requested
//! `Option<Arc<dyn Keystore>>` shape as a pair:
//!   * [`open_device_secret`] — SYNC, v1 device-secret key. Byte-identical
//!     key material to the historical `derive_db_encryption_key()` path, so
//!     stores without a dedicated `SqlCipher*` [`KeyPurpose`] adopt it with
//!     no ADR churn.
//!   * [`open_resolved`] — ASYNC, manifest-aware keystore/TPM path (v2 with
//!     v1 fallback) via the `consumer_key_resolver` SSoT.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::db_migration::consumer_context::ConsumerContext;
use crate::db_migration::consumer_key_resolver::{self, ResolvedConsumerKey, V1Inputs};
use crate::db_migration::schema_version::DbKeySchemaVersion;
use crate::keystore::Keystore;
use crate::keystore::purpose::KeyPurpose;

/// Store-specific PERFORMANCE + DURABILITY posture applied on top of the
/// canonical security sequence. The security pragmas (`key`, `journal_mode`,
/// `busy_timeout`, `auto_vacuum`) are NOT expressible here — the factory owns
/// them so no store can weaken them. `synchronous` is the one durability knob
/// a store may raise (never lower): the factory floor is `NORMAL`; a store
/// with a power-loss-critical write set may opt into `FULL`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PragmaProfile {
    /// `PRAGMA cache_size = <n>` when `Some`. Negative values are KiB (the
    /// SQLite convention); e.g. `Some(-8000)` = 8 MiB page cache.
    pub cache_size_kib: Option<i64>,
    /// `PRAGMA temp_store = MEMORY` when `true`.
    pub temp_store_memory: bool,
    /// When `true`, the store opens at `PRAGMA synchronous=FULL` (WAL frames
    /// fsync on every commit) instead of the `NORMAL` floor (fsync only at
    /// checkpoint). For stores whose EVERY write must survive a power cut and
    /// whose write rate makes per-commit fsync affordable (e.g. the LoRaWAN
    /// frame-counter store — PR935-MEDIUM-001).
    pub synchronous_full: bool,
}

impl PragmaProfile {
    /// No extra performance pragmas — the canonical security/durability
    /// sequence only. The right default for small, low-churn stores.
    pub const DEFAULT: Self = Self {
        cache_size_kib: None,
        temp_store_memory: false,
        synchronous_full: false,
    };

    /// Larger cache + in-memory temp store for hotter stores (bytecode /
    /// retain persistence / force registry).
    pub const PERF: Self = Self {
        cache_size_kib: Some(-8000),
        temp_store_memory: true,
        synchronous_full: false,
    };

    /// Whole-store power-loss durability: every commit fsyncs the WAL. For
    /// low-rate stores whose each write is safety- or replay-critical.
    pub const DURABLE: Self = Self {
        cache_size_kib: None,
        temp_store_memory: false,
        synchronous_full: true,
    };
}

/// Run `f` with the connection temporarily at `PRAGMA synchronous=FULL`, then
/// restore `NORMAL` — so a single power-loss-critical commit is fsync-durable
/// on a store that otherwise runs at the `NORMAL` floor for hot-path throughput
/// (PR935-HIGH-004: the offline-queue edge_seq high-water-mark reservation).
///
/// The caller MUST hold the connection lock across this call. `synchronous` is
/// restored even if `f` returns `Err`, so the hot path is never left on `FULL`.
pub fn durable_commit<T>(conn: &Connection, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    conn.pragma_update(None, "synchronous", "FULL")
        .context("durable_commit: raise synchronous=FULL failed")?;
    let out = f(conn);
    // Restore the NORMAL floor regardless of the outcome.
    let restored = conn
        .pragma_update(None, "synchronous", "NORMAL")
        .context("durable_commit: restore synchronous=NORMAL failed");
    let value = out?;
    restored?;
    Ok(value)
}

/// A freshly-opened, keyed SQLCipher connection plus the schema version its
/// key was derived under (so a resolver-path caller can route v1-backlog
/// telemetry). The v1 device-secret path always reports `None`.
pub struct OpenedDb {
    pub conn: Connection,
    pub key_version: Option<DbKeySchemaVersion>,
}

/// Open + key a SQLCipher database with the v1 device-secret key.
///
/// `store_label` is a telemetry-only tag (the v1 device secret is
/// purpose-agnostic — one shared key), so stores without a dedicated
/// `SqlCipher*` [`KeyPurpose`] can adopt the factory with no ADR change.
pub fn open_device_secret(
    db_path: &Path,
    store_label: &str,
    profile: PragmaProfile,
) -> Result<Connection> {
    let conn = Connection::open(db_path).with_context(|| {
        format!(
            "sqlcipher_factory({store_label}): open {} failed",
            db_path.display()
        )
    })?;
    let hex = crate::offline_queue::derive_db_encryption_key()
        .with_context(|| format!("sqlcipher_factory({store_label}): v1 key derivation failed"))?;
    finish_open(&conn, &hex, profile)
        .with_context(|| format!("sqlcipher_factory({store_label}): pragma sequence failed"))?;
    Ok(conn)
}

/// Open + key a SQLCipher database via the manifest-aware consumer-key
/// resolver (v2 keystore-derived, with v1 fallback on missing/v1 manifest).
///
/// `purpose` MUST be a `SqlCipher*` [`KeyPurpose`] (the resolver enforces
/// this via `context_bytes_for_purpose`). This is the sole store-side caller
/// of `resolve_consumer_pragma_key`; it assembles the `V1Inputs` (machine-id
/// + device secret) internally so stores don't duplicate that boilerplate.
pub async fn open_resolved(
    db_path: &Path,
    purpose: KeyPurpose,
    ctx: &ConsumerContext,
    keystore: &dyn Keystore,
    profile: PragmaProfile,
) -> Result<OpenedDb> {
    let machine_id = crate::machine_id::read()
        .context("sqlcipher_factory(open_resolved): machine_id read failed")?;
    let secret_key = crate::db_secret::read_or_create_v1_secret()
        .context("sqlcipher_factory(open_resolved): device secret load failed")?;
    let v1_inputs = V1Inputs {
        machine_id: machine_id.into_bytes(),
        secret_key,
    };

    let resolved: ResolvedConsumerKey = consumer_key_resolver::resolve_consumer_pragma_key(
        db_path, purpose, ctx, keystore, &v1_inputs,
    )
    .await
    .map_err(|e| anyhow::anyhow!("sqlcipher_factory(open_resolved): resolver failed: {e}"))?;

    let conn = Connection::open(db_path).with_context(|| {
        format!(
            "sqlcipher_factory(open_resolved): open {} failed",
            db_path.display()
        )
    })?;
    finish_open(&conn, resolved.pragma_key_hex.as_str(), profile)
        .context("sqlcipher_factory(open_resolved): pragma sequence failed")?;

    Ok(OpenedDb {
        conn,
        key_version: Some(resolved.current_version),
    })
}

/// The canonical open ceremony — the ONLY place in the crate (outside the
/// migration ceremonies) that emits `PRAGMA key`. Order is load-bearing:
/// the raw key first, then the durability pragmas, then `auto_vacuum`
/// BEFORE any schema so it actually takes effect on a fresh database, then
/// the store's optional performance pragmas.
fn finish_open(conn: &Connection, key_hex: &str, profile: PragmaProfile) -> Result<()> {
    // 1. Raw-key (x'<hex>') — the crate's ONLY steady-state PRAGMA-key literal.
    conn.execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))
        .context("PRAGMA key failed")?;
    // 2. Canonical durability + concurrency pragmas. `synchronous` is the one
    //    durability knob a profile may raise: NORMAL floor, or FULL for stores
    //    whose every commit must be power-loss durable.
    let synchronous = if profile.synchronous_full {
        "FULL"
    } else {
        "NORMAL"
    };
    conn.execute_batch(&format!(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous={synchronous};
         PRAGMA busy_timeout=5000;
         PRAGMA auto_vacuum=INCREMENTAL;"
    ))
    .context("canonical durability pragmas failed")?;
    // 3. Optional store performance pragmas.
    if let Some(kib) = profile.cache_size_kib {
        conn.execute_batch(&format!("PRAGMA cache_size={kib};"))
            .context("PRAGMA cache_size failed")?;
    }
    if profile.temp_store_memory {
        conn.execute_batch("PRAGMA temp_store=MEMORY;")
            .context("PRAGMA temp_store failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_secret_open_roundtrips_encrypted_db() {
        // A tempfile DB opened + keyed by the factory must accept schema +
        // data and read it back — proving the canonical ceremony produces a
        // working keyed connection.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("factory-roundtrip.db");
        let conn = open_device_secret(&path, "test-roundtrip", PragmaProfile::DEFAULT)
            .expect("factory open");
        conn.execute_batch("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT NOT NULL);")
            .expect("schema");
        conn.execute("INSERT INTO t (k, v) VALUES (1, 'hello')", [])
            .expect("insert");
        let got: String = conn
            .query_row("SELECT v FROM t WHERE k = 1", [], |r| r.get(0))
            .expect("select");
        assert_eq!(got, "hello");
    }

    #[test]
    fn device_secret_open_reopen_same_key_reads_prior_rows() {
        // Reopening the SAME file via the factory must decrypt prior rows —
        // proving the key derivation is stable across opens (byte-identical
        // to the historical device-secret path).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("factory-reopen.db");
        {
            let conn = open_device_secret(&path, "test", PragmaProfile::PERF).expect("open 1");
            conn.execute_batch("CREATE TABLE t (k INTEGER PRIMARY KEY);")
                .expect("schema");
            conn.execute("INSERT INTO t (k) VALUES (7)", [])
                .expect("insert");
        }
        let conn = open_device_secret(&path, "test", PragmaProfile::PERF).expect("open 2");
        let k: i64 = conn
            .query_row("SELECT k FROM t WHERE k = 7", [], |r| r.get(0))
            .expect("select after reopen");
        assert_eq!(k, 7);
    }

    #[test]
    fn profile_default_is_key_and_durability_only() {
        // Sanity: DEFAULT carries no perf pragmas.
        assert_eq!(PragmaProfile::DEFAULT.cache_size_kib, None);
        assert!(!PragmaProfile::DEFAULT.temp_store_memory);
        assert!(!PragmaProfile::DEFAULT.synchronous_full);
        assert!(PragmaProfile::DURABLE.synchronous_full);
    }

    #[test]
    fn durable_profile_opens_at_synchronous_full() {
        // PR935-MEDIUM-001: the DURABLE profile must land the connection at
        // synchronous=FULL (2), not the NORMAL floor (1).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("durable.db");
        let conn = open_device_secret(&path, "test-durable", PragmaProfile::DURABLE).expect("open");
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .expect("read synchronous");
        assert_eq!(sync, 2, "DURABLE profile must open at synchronous=FULL (2)");
    }

    #[test]
    fn durable_commit_runs_then_restores_normal_floor() {
        // PR935-HIGH-004: the scoped helper raises FULL for one commit and
        // restores the NORMAL floor afterwards, so the hot path is not left
        // fsyncing every write.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("scoped.db");
        let conn = open_device_secret(&path, "test-scoped", PragmaProfile::DEFAULT).expect("open");
        // Floor before.
        let before: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .expect("read");
        assert_eq!(before, 1, "DEFAULT should open at NORMAL (1)");

        conn.execute_batch("CREATE TABLE t (k INTEGER PRIMARY KEY);")
            .expect("schema");
        let n = durable_commit(&conn, |c| {
            c.execute("INSERT INTO t (k) VALUES (1)", [])
                .map_err(anyhow::Error::from)
        })
        .expect("durable_commit");
        assert_eq!(n, 1);

        // Floor restored after.
        let after: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .expect("read");
        assert_eq!(
            after, 1,
            "durable_commit must restore synchronous=NORMAL (1)"
        );
    }
}
