//! SQLCipher key-derivation schema migration
//! infrastructure (Batch #329 D-3 primitive-first split).
//!
//! ## Why this module exists
//!
//! Plan §5 Faz 2 D-3 + IEC 62443 FR4 (Data Confidentiality)
//! mandate a migration path from the v1 machine-id-derived
//! SQLCipher key to a v2 keystore-derived key. The current
//! v1 derivation (`offline_queue::derive_db_encryption_key`)
//! is `HMAC-SHA256(machine_id, /etc/suderra/db.key)` — the
//! audit history captures this is INSUFFICIENT as sole key
//! material because `/etc/machine-id` is world-readable and
//! `/etc/suderra/db.key` lives outside the
//! D-1a/D-1b/D-2 keystore hierarchy (no TPM seal, no mlock,
//! no zeroize-on-drop guarantees, no rotation cadence).
//!
//! The v2 target derives the SQLCipher key via
//! `Keystore::derive_key(KeyPurpose::SqlCipherOfflineQueue,
//! &db_path_bytes)` from the master key in the keystore
//! hierarchy. This puts the SQLCipher key under all the
//! D-1a/D-1b/D-2 protections automatically.
//!
//! ## Multi-batch arc
//!
//! D-3 is a substantial arc that lands in stages:
//!
//!   - **Batch #329 — primitive-first split.**
//!     - `DbKeySchemaVersion` enum (V1MachineIdDerived,
//!       V2KeystoreDerived).
//!     - `DbKeySourceManifest` sidecar JSON shape with
//!       atomic-write persistence (mirrors Batch #316
//!       RotationMarkerStore pattern).
//!     - `DbMigrationError` taxonomy.
//!   - **Batch #330 (this batch) — boot-time detector.**
//!     - `detect_db_migration_backlog(db_paths)` pure
//!       function that scans a list of DB paths, reads
//!       each sidecar manifest, treats missing manifests
//!       as legacy v1 default (the historical pre-D-3
//!       state), and returns a `DbMigrationBacklogReport`.
//!     - `DbMigrationBacklogReport::log_structured_warn`
//!       emits one operator-readable WARN per backlog
//!       entry + a single SUMMARY WARN with the count.
//!     - The corresponding Prometheus metric
//!       `suderra_db_migration_backlog` is a label-free
//!       gauge (we deliberately do NOT label by db_path
//!       to avoid high-cardinality storage blow-up; per-DB
//!       detail lives in the structured WARN log so
//!       operators correlate via timestamp).
//!   - **Future Batch — migration binary.** A
//!     `db-migrate-cli` binary that reads a v1 DB with
//!     the machine-id-derived key, rekeys to the v2
//!     keystore-derived key via `PRAGMA rekey`, atomically
//!     replaces the manifest sidecar, and verifies the
//!     post-migration DB is readable with the v2 key.
//!   - **Future Batch — consumer migration.** Each
//!     SQLCipher consumer (offline_queue, license_cache,
//!     scripting/persistence, scripting/bytecode_retain)
//!     adopts the v2 key derivation at construction
//!     time. Production cold-boot picks v2 by default;
//!     legacy v1 DBs trigger the boot-time detector +
//!     operator runs the migration binary.
//!
//! ## Why a sidecar manifest (not a DB column)
//!
//! A `schema_version` column inside the SQLCipher DB
//! itself would create a chicken-and-egg problem at boot:
//! the agent needs to know which key to derive BEFORE it
//! can open the DB to read the column. The sidecar JSON
//! lives next to the DB file (e.g., `offline_queue.db` +
//! `offline_queue.db.key-source.json`) so the agent reads
//! the manifest pre-open + selects the correct key
//! derivation path.
//!
//! ## Why atomic temp+rename (not direct write)
//!
//! Same architectural reasoning as Batch #316
//! RotationMarkerStore: the manifest is the only source
//! of truth for which key derivation works for a given
//! DB. A torn write that leaves the manifest pointing to
//! the WRONG schema version would brick the DB
//! permanently — the agent would derive the wrong key +
//! every subsequent open would fail with
//! `database is encrypted or is not a database`. Atomic
//! rename ensures either the OLD manifest stays intact OR
//! the NEW manifest is fully written; never a partial.

pub mod boot_detector;
pub mod manifest;
pub mod schema_version;

// **Why allow(unused_imports):** the D-3 arc lands the
// re-exports at primitive time (Batch #329) + boot
// detector (Batch #330) BEFORE the consumer-migration
// arc wires call sites in offline_queue / license_cache /
// scripting persistence / scripting bytecode_retain
// (future batches). The re-exports are the architectural
// public-API contract — they must exist now so the
// future consumer batches can use them at the documented
// path (`crate::db_migration::*`) without rearranging
// internal module layout. The lint suppression is the
// minimum-noise way to land the contract early.
#[allow(unused_imports)]
pub use boot_detector::{
    detect_db_migration_backlog, DbMigrationBacklogEntry,
    DbMigrationBacklogReport,
};
#[allow(unused_imports)]
pub use manifest::{
    manifest_path_for_db, read_manifest, write_manifest,
    DbKeySourceManifest, DbMigrationError, DB_KEY_SOURCE_MANIFEST_SUFFIX,
};
#[allow(unused_imports)]
pub use schema_version::DbKeySchemaVersion;
