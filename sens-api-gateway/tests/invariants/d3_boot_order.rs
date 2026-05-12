#![allow(clippy::expect_used, clippy::indexing_slicing, clippy::print_stdout, clippy::unwrap_used)]

//! PR-195 Batch #17 D-3 wire-status invariant — pins
//! the architectural prerequisite that
//! `init_keystore` runs BEFORE every SQLCipher consumer
//! init in main.rs's boot sequence (closes
//! ORPHAN-D3-BOOT-ORDER-001).
//!
//! ## Why this invariant exists
//!
//! PR-195 Batches #13-#15 landed manifest-aware
//! constructors on all 4 SQLCipher consumers
//! (`OfflineQueue::with_keystore_derivation`,
//! `LicenseCacheStore::open_with_keystore_derivation`,
//! `SqlitePersistence::new_with_keystore_derivation`,
//! `BytecodeRegistryStore::new_with_keystore_derivation`).
//! Each takes `Arc<dyn Keystore>` as a required arg.
//!
//! For `init_offline_queue` / `init_license_cache` /
//! etc. to actually USE these constructors,
//! `self.keystore` must be `Some(Arc<dyn Keystore>)`
//! at the time those `init_X` functions execute.
//!
//! Pre-Batch-#17, `init_keystore` ran AFTER the
//! consumer inits in main.rs's boot sequence — that
//! ordering was safe pre-D-3 because the legacy
//! constructors didn't depend on the keystore. Batch
//! #17 relocated `init_keystore` to BEFORE
//! `init_offline_queue` so the new manifest-aware
//! constructors have a populated keystore at call
//! time.
//!
//! ## What this test pins
//!
//! Reads `sens-api-gateway/src/main.rs` + finds the
//! line numbers of every SQLCipher consumer init call,
//! asserts `init_keystore` line number is strictly
//! smaller than each consumer's. A future refactor
//! that mis-orders the boot sequence (e.g., re-adds
//! `init_keystore` after `init_offline_queue`) fails
//! this test at CI time rather than waiting for an
//! integration-test boot to surface the regression.
//!
//! ## Why grep-based (not runtime-asserted)
//!
//! AppState::init_X functions don't have an explicit
//! contract that they require keystore-availability;
//! the contract is implicit in their bodies. A runtime
//! assertion would either:
//!
//!   (a) Require adding a guard to every consumer's
//!       init_X (intrusive — couples the consumer to
//!       boot-order awareness).
//!   (b) Live in a wrapper around the boot sequence
//!       (still requires a manual update when a 5th
//!       consumer is added).
//!
//! The grep-based detector is the lightest-weight
//! shape: pin the architectural fact (line ordering)
//! without coupling the consumers' code shape. Mirrors
//! the wire-status invariants from Batch #335
//! (no-direct-getRepository) + Batch #326
//! (SystemTime::now ban) + ADR-031 KNOWN_SQLCIPHER_
//! CONSUMERS pin.

use std::fs;
use std::path::PathBuf;

/// Locate the `state_guard.<method>` call for the given
/// init function. Returns the 1-based line number.
/// Panics with an architectural-fail message when the
/// call is missing — that means a previous batch
/// removed the init entirely, which is its own
/// correctness signal the test should surface.
fn find_state_guard_init_line(source: &str, fn_name: &str) -> usize {
    let needle = format!("state_guard.{}", fn_name);
    let line = source
        .lines()
        .enumerate()
        .find(|(_, l)| l.contains(&needle));
    match line {
        Some((i, _)) => i + 1, // 1-based
        None => panic!(
            "ORPHAN-D3-BOOT-ORDER-001 invariant: \
             expected `state_guard.{}` call in main.rs \
             not found. The init function may have \
             been renamed or removed; update this \
             invariant to track the new name OR \
             investigate whether the SQLCipher \
             consumer was de-wired (which would be \
             a separate architectural concern).",
            fn_name
        ),
    }
}

fn read_main_rs() -> String {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is set by `cargo test`");
    let path = PathBuf::from(manifest_dir).join("src").join("main.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "failed to read {} for boot-order invariant: {}",
            path.display(),
            e
        )
    })
}

#[test]
fn init_keystore_runs_before_init_offline_queue() {
    let source = read_main_rs();
    let keystore_line =
        find_state_guard_init_line(&source, "init_keystore");
    let offline_queue_line =
        find_state_guard_init_line(&source, "init_offline_queue");
    assert!(
        keystore_line < offline_queue_line,
        "ORPHAN-D3-BOOT-ORDER-001 (PR-195 Batch #17 invariant): \
         init_keystore (main.rs L{}) MUST run before \
         init_offline_queue (main.rs L{}). \
         OfflineQueue::with_keystore_derivation requires \
         self.keystore.is_some() at call time. \
         A boot-order regression breaks the manifest-\
         aware consumer adoption — see \
         docs/reviews/orphan-findings.md#ORPHAN-D3-BOOT-ORDER-001.",
        keystore_line,
        offline_queue_line,
    );
}

#[test]
fn init_keystore_runs_before_init_license_cache() {
    let source = read_main_rs();
    let keystore_line =
        find_state_guard_init_line(&source, "init_keystore");
    let license_cache_line =
        find_state_guard_init_line(&source, "init_license_cache");
    assert!(
        keystore_line < license_cache_line,
        "ORPHAN-D3-BOOT-ORDER-001 (PR-195 Batch #17 invariant): \
         init_keystore (main.rs L{}) MUST run before \
         init_license_cache (main.rs L{}). \
         LicenseCacheStore::open_with_keystore_derivation \
         requires self.keystore.is_some() at call time.",
        keystore_line,
        license_cache_line,
    );
}

#[test]
fn init_keystore_runs_before_init_bytecode_registry_store() {
    let source = read_main_rs();
    let keystore_line =
        find_state_guard_init_line(&source, "init_keystore");
    let bytecode_line =
        find_state_guard_init_line(&source, "init_bytecode_registry_store");
    assert!(
        keystore_line < bytecode_line,
        "ORPHAN-D3-BOOT-ORDER-001 (PR-195 Batch #17 invariant): \
         init_keystore (main.rs L{}) MUST run before \
         init_bytecode_registry_store (main.rs L{}). \
         Future program-bound manifest-aware adoption \
         for this consumer requires \
         self.keystore.is_some() at call time.",
        keystore_line,
        bytecode_line,
    );
}

#[test]
fn init_keystore_runs_before_init_retain_persistence() {
    let source = read_main_rs();
    let keystore_line =
        find_state_guard_init_line(&source, "init_keystore");
    let retain_line =
        find_state_guard_init_line(&source, "init_retain_persistence");
    assert!(
        keystore_line < retain_line,
        "ORPHAN-D3-BOOT-ORDER-001 (PR-195 Batch #17 invariant): \
         init_keystore (main.rs L{}) MUST run before \
         init_retain_persistence (main.rs L{}). \
         Future program-bound manifest-aware adoption \
         for this consumer requires \
         self.keystore.is_some() at call time.",
        keystore_line,
        retain_line,
    );
}
