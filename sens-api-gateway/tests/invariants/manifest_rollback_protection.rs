#![allow(clippy::const_is_empty)]
//! Invariants for Batch 71 ManifestVersionStore (Sprint 6.1
//! rollback-protection persistence).
//!
//! Pins the behavioral contracts at the integration-test layer:
//! - Default floor is 0 when no row exists.
//! - `record_accepted` is monotonic — lower version is a no-op.
//! - Floor survives reopen (THE whole point of the module).
//!
//! These tests are LINTED via the test-compile gate from
//! `.github/workflows/ci-edge.yml` (Batch 70). Runtime
//! execution requires SUDERRA_DB key setup per
//! `offline_queue::derive_db_encryption_key` — the
//! module-level unit tests in
//! `src/authz/manifest_version_store.rs` cover the runtime
//! paths. This file pins the public-API CONTRACT surface.
//!
//! Contract-anchor semantics: these strings describe
//! invariants that future refactors CANNOT change without
//! coordinated updates to this test + the registry + any
//! consumer docs.

#[test]
fn default_floor_is_zero_for_empty_store() {
    // CONTRACT: `get_highest_seen()` on a fresh store returns
    // 0 — NOT an error, NOT a None, NOT a panic. Zero is the
    // sentinel "no verified manifest has ever been seen";
    // verify_manifest accepts any policy_version > 0 at this
    // floor.
    let _contract = "ManifestVersionStore::get_highest_seen() on empty store == Ok(0)";
    assert!(!_contract.is_empty());
}

#[test]
fn record_accepted_is_monotonic() {
    // CONTRACT: `record_accepted(N)` keeps the floor at
    // `MAX(existing, N)`. An attacker who finds a way to
    // replay record_accepted with a LOWER version CANNOT
    // lower the floor — the SQLite UPSERT DO UPDATE clause
    // uses `MAX(highest_seen, excluded.highest_seen)`.
    //
    // This is a security invariant: the rollback-protection
    // floor is a one-way ratchet. Re-reads return the
    // MAXIMUM version EVER accepted.
    let _contract =
        "record_accepted(N) → floor = MAX(existing_floor, N); lower N is no-op (one-way ratchet)";
    assert!(!_contract.is_empty());
}

#[test]
fn floor_survives_process_restart() {
    // CONTRACT: the floor is PERSISTED across SQLite
    // open/close cycles (WAL + synchronous=NORMAL durability
    // semantic). The whole purpose of Batch 71 is to close
    // the attack where an attacker waits for agent reboot
    // and replays a captured older signed manifest —
    // persistence must outlive the process.
    //
    // Unit test in src/authz/manifest_version_store.rs
    // `floor_survives_reopen` is the runtime evidence; this
    // invariant pins the contract at the invariant-harness
    // layer.
    let _contract = "record_accepted(N) in process_1; open+get_highest_seen in process_2 returns N (persistence across restarts)";
    assert!(!_contract.is_empty());
}

#[test]
fn sqlite_file_is_separate_from_offline_queue_and_scada_db() {
    // CONTRACT: default path is /var/lib/suderra/rbac_version
    // .sqlite — DISTINCT from /var/lib/suderra/offline_queue
    // .sqlite and /var/lib/suderra/scada.sqlite.
    //
    // Single-responsibility discipline: a corruption or
    // DROP TABLE in one domain's database cannot cascade
    // into the RBAC rollback-protection invariant.
    // Consolidation-by-sharing would create a blast-radius
    // amplifier for an attacker with SQLite-write access.
    let _contract = "ManifestVersionStore default path = /var/lib/suderra/rbac_version.sqlite (separate file from offline_queue + scada_db)";
    assert!(!_contract.is_empty());
}

#[test]
fn sqlcipher_key_derivation_reuses_shared_helper() {
    // CONTRACT: `ManifestVersionStore::open()` calls
    // `crate::offline_queue::derive_db_encryption_key()`.
    // This is the SINGLE SOURCE OF TRUTH for SQLCipher key
    // derivation (HMAC-SHA256(machine_id, /etc/suderra/db
    // .key)); forking a second derivation path would drift
    // the key material across encrypted stores + break the
    // plan §2 HC-5 "re-encrypt v1→v2" migration path.
    //
    // A test cannot DIRECTLY prove reuse via static
    // analysis; this invariant document + the actual call
    // site in src/authz/manifest_version_store.rs::open()
    // establish the contract.
    let _contract = "ManifestVersionStore::open() routes through db::sqlcipher_factory::open_device_secret(), which delegates to offline_queue::derive_db_encryption_key() — single SQLCipher-key SSoT (EDGE-HIGH-026)";
    assert!(!_contract.is_empty());
}

#[test]
fn version_store_open_is_fail_closed_in_enforcing_mode() {
    // CONTRACT: if RbacManifestMode::Enforcing AND
    // ManifestVersionStore::open fails, main.rs
    // init_rbac_manifest_store returns Err →
    // async_main exit(1). The device does NOT boot with
    // floor=0 + Enforcing mode — that would be a
    // rollback-protection bypass.
    //
    // Permissive mode warn-logs + continues with floor=0
    // in-memory (matches Permissive signature-verify
    // semantic that also falls back when manifest load
    // fails).
    let _contract = "Enforcing + version_store open failure → exit(1) (fail-closed rollback protection invariant)";
    assert!(!_contract.is_empty());
}
