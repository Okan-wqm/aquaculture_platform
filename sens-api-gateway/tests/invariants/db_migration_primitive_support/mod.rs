//! Support glue for the db_migration_primitive integration
//! test (Batch #329 D-3).
//!
//! ## Why this file exists
//!
//! `tests/invariants/db_migration_primitive.rs` cannot
//! declare an inline `mod db_migration { ... }` with
//! `#[path]` children because rustc resolves the inline
//! module's child paths relative to a SYNTHETIC directory
//! that must exist on disk (Linux's path resolver
//! requires every directory component along the relative
//! path to physically exist before `..` traversal). To
//! satisfy that requirement we materialize the directory
//! `tests/invariants/db_migration_primitive_support/`
//! and put the `#[path]` includes here.
//!
//! The test file then loads this module with
//! `#[path = "db_migration_primitive_support/mod.rs"]
//!  mod db_migration;`
//! which works because the synthetic directory now
//! physically exists.

#[path = "../../../src/db_migration/schema_version.rs"]
pub mod schema_version;

#[path = "../../../src/db_migration/manifest.rs"]
pub mod manifest;

// Batch #338 — `manifest.rs` now delegates to the
// shared atomic-JSON-sidecar helper at
// `crate::shared_io::atomic_json_sidecar`. The
// integration test binary has its own crate root, so we
// stage the helper here with the same path the bin uses
// (`crate::shared_io::atomic_json_sidecar`). Declared at
// the test-file level (not nested under db_migration) in
// db_migration_primitive.rs.
