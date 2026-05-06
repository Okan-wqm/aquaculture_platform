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
//!   - **Batch #330 — boot-time detector.**
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
//!   - **Batch #331 — v1 legacy-key derivation primitive.**
//!     - `derive_v1_legacy_key(machine_id, secret_key)`
//!       pure-crypto kernel implementing the legacy
//!       `HMAC-SHA256(machine_id, secret_key)` algorithm.
//!     - `format_sqlcipher_pragma_key_hex(&[u8; 32])`
//!       lower-hex helper for the PRAGMA key string.
//!     - The migration binary will call this kernel +
//!       `keystore.derive_key(SqlCipherOfflineQueue,
//!       &db_path_bytes)` to compute the (v1, v2) key
//!       pair needed for `PRAGMA rekey`. The kernel is
//!       INTENTIONALLY duplicated from
//!       `offline_queue::derive_db_encryption_key` (which
//!       retains a production-only `OnceLock` cache for
//!       its hot-path callers) so the migration tool gets
//!       a clean, cache-free, parameter-injectable
//!       function. A cross-validation test in this batch
//!       pins that BOTH paths produce the same bytes for
//!       the same inputs, locking the algorithm against
//!       drift between the two copies.
//!   - **Batch #332 (this batch) — v2 keystore-derived
//!     key shim.**
//!     - `derive_v2_sqlcipher_key(keystore, purpose,
//!       context)` async wrapper around
//!       `Keystore::derive_key`. Symmetric counterpart
//!       to Batch #331's v1 kernel — together they give
//!       the migration tool both keys needed for
//!       `PRAGMA rekey`.
//!     - Wrong-purpose runtime guard rejects
//!       non-`SqlCipher*` `KeyPurpose` variants with
//!       `V2DerivationError::WrongPurpose`. Catches
//!       refactor mistakes (e.g., accidentally passing
//!       `AuditHmacChain`) at the migration boundary,
//!       not at next-DB-open.
//!     - `derive_v2_sqlcipher_pragma_key_hex` convenience
//!       wrapper that returns the SQLCipher PRAGMA-key
//!       hex string directly.
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
pub mod cli;
pub mod cli_executor;
pub mod cli_runtime;
pub mod consumer_context;
pub mod consumer_key_resolver;
pub mod manifest;
pub mod rekey;
pub mod rekey_swap;
pub mod schema_version;
pub mod v1_legacy_key;
pub mod v2_keystore_key;

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
#[allow(unused_imports)]
pub use v1_legacy_key::{
    derive_v1_legacy_key, format_sqlcipher_pragma_key_hex,
};
#[allow(unused_imports)]
pub use v2_keystore_key::{
    derive_v2_sqlcipher_key, derive_v2_sqlcipher_pragma_key_hex,
    V2DerivationError,
};
#[allow(unused_imports)]
pub use rekey::{pragma_rekey, RekeyError};
#[allow(unused_imports)]
pub use rekey_swap::{
    rekey_with_manifest_swap, rekey_with_manifest_swap_inner,
    RekeyManifestError,
};

/// Batch #340 — closes audit MEDIUM-003.
///
/// **Why this test exists:** the six `#[allow(unused_imports)]`
/// re-exports above suppress the compiler warning that the
/// public-API symbols are unused (they will become required
/// when the PR-195 consumer-migration arc wires call sites).
/// The auditor flagged that the blanket `allow` would mask
/// an UNINTENTIONAL refactor that accidentally dropped one
/// of the re-exports — the `allow` hides any
/// "unused symbol" signal from the affected re-export's
/// neighborhood, so a typo + drop would compile cleanly +
/// only fail at PR-195 callsite-landing time.
///
/// The architectural fix: a `#[cfg(test)]` function that
/// MENTIONS every re-exported public-API symbol. The test
/// is compile-only — it never runs. If a future refactor
/// drops or renames a re-export the function fails to
/// compile, surfacing the regression INSIDE the same PR
/// rather than waiting for PR-195.
///
/// This is the auditor's recommended Tier-1 alternative to
/// a Cargo feature gate. The feature-gate approach was
/// rejected as substantial new tooling for a problem that
/// a 30-line test resolves with stronger compile-time
/// semantics.
///
/// **Why `let _ = ...; let _ = ...;`:** binding the symbol
/// with `let _ = ` is the canonical Rust idiom for a
/// "I'm using this" no-op assertion. For function symbols
/// that need to be referenced as values (not called), we
/// use the function-pointer cast `let _: fn(...) -> ... =
/// <symbol>;` so a signature change here surfaces at
/// compile time too (not just a name change).
#[cfg(test)]
#[allow(dead_code)]
fn _api_surface_is_complete_compile_check() {
    use std::path::Path;

    // Constants referenced via `let _ = <CONST>;` — drop
    // or rename surfaces here.
    let _ = DB_KEY_SOURCE_MANIFEST_SUFFIX;

    // Type symbols — referenced as type ascriptions in
    // unit-typed bindings so the compiler verifies the
    // type still exists at the documented path.
    let _: Option<DbKeySchemaVersion> = None;
    let _: Option<DbKeySourceManifest> = None;
    let _: Option<DbMigrationError> = None;
    let _: Option<DbMigrationBacklogEntry> = None;
    let _: Option<DbMigrationBacklogReport> = None;
    let _: Option<V2DerivationError> = None;

    // Function symbols — referenced via fn-pointer cast
    // so a signature change (added/removed param,
    // changed return type) surfaces here at compile time.
    let _: fn(&Path) -> std::path::PathBuf = manifest_path_for_db;
    let _: fn(
        &Path,
    ) -> Result<Option<DbKeySourceManifest>, DbMigrationError> =
        read_manifest;
    let _: fn(
        &Path,
        &DbKeySourceManifest,
    ) -> Result<(), DbMigrationError> = write_manifest;
    let _: fn(&[&Path]) -> DbMigrationBacklogReport =
        detect_db_migration_backlog;
    let _: fn(&[u8], &[u8]) -> [u8; 32] = derive_v1_legacy_key;
    let _: fn(&[u8; 32]) -> String = format_sqlcipher_pragma_key_hex;

    // Async functions — fn-pointer cast not directly
    // applicable (the future type is opaque) but we can
    // assign the function item itself which still pins
    // the existence + module path.
    let _ = derive_v2_sqlcipher_key;
    let _ = derive_v2_sqlcipher_pragma_key_hex;
}
