//! `sensor-ingestion` library surface — declares every module
//! that the binary entrypoint (`main.rs`) wires together.
//!
//! # Why a lib + bin split
//!
//! The crate is primarily a binary (the Rust ingestion sidecar),
//! but the workspace's integration tests in `tests/*.rs` need to
//! reach into the modules — and Rust's integration-test target
//! can only link against a library crate, not a binary's
//! `main.rs`. Publishing every module through this `lib.rs` file
//! gives the integration tests compile-level access while
//! keeping the binary's layout unchanged (main.rs still imports
//! via `use crate::foo` and Rust resolves it against this lib
//! when the crate is built as a bin+lib pair).
//!
//! The modules are `pub` so integration tests can construct the
//! types + call the functions. Their internal APIs are
//! intentionally MINIMAL surface — anything that does not need
//! external visibility stays `pub(crate)` inside each module.

#![cfg_attr(not(test), forbid(unsafe_code))]
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
    )
)]

pub mod batch;
pub mod cache;
pub mod config;
pub mod error;
pub mod events;
pub mod ingest_backend;
pub mod mqtt;
pub mod payload;
pub mod persistence;
pub mod pipeline;
pub mod policy;
pub mod runtime;
pub mod sensor_lookup;
pub mod topic;
