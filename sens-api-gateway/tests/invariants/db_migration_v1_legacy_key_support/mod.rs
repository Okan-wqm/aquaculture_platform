//! Support glue for the `db_migration_v1_legacy_key`
//! integration test (Batch #331). Same architectural
//! rationale as the prior support directories
//! (Batch #329 + #330): rustc's inline-mod path
//! resolution requires the synthetic directory to
//! physically exist on disk.

#[path = "../../../src/db_migration/v1_legacy_key.rs"]
pub mod v1_legacy_key;
