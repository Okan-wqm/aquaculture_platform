//! `shared_io` glue for the standalone integration test
//! (Batch #338). Manifest.rs delegates to
//! `crate::shared_io::atomic_json_sidecar::write_atomic_json`;
//! the test crate stages the helper module here so the
//! `crate::` path resolves identically to the bin
//! context.

#[path = "../../../src/shared_io/atomic_json_sidecar.rs"]
pub mod atomic_json_sidecar;
