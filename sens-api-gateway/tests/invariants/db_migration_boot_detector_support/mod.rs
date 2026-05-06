//! Support glue for `db_migration_boot_detector` (Batch
//! #330 D-3 boot detector integration test).
//!
//! Same architectural rationale as the Batch #329
//! `db_migration_primitive_support`: rustc resolves
//! inline-mod child `#[path]` values relative to a
//! synthetic directory that must physically exist on
//! disk. Materializing this directory lets the
//! integration test use a file-based `mod db_migration;`
//! with `#[path]` includes that reach into the bin's
//! `src/db_migration/`.

#[path = "../../../src/db_migration/schema_version.rs"]
pub mod schema_version;

#[path = "../../../src/db_migration/manifest.rs"]
pub mod manifest;

#[path = "../../../src/db_migration/boot_detector.rs"]
pub mod boot_detector;
