//! Production `Keystore` build helper (PR-195 Batch
//! #16 — extracted from `AppState::init_keystore` body
//! so the SAME construction path is reachable from BOTH
//! the agent's normal boot AND the `--migrate-db` CLI
//! subcommand dispatch).
//!
//! ## Why this module exists
//!
//! Pre-Batch-#16, the keystore-construction logic lived
//! inline inside `AppState::init_keystore` in `main.rs`.
//! For the migration ceremony's `--migrate-db` dispatch
//! to invoke the orchestrator (PR-195 Batches
//! #9-#15), the dispatch site needs an
//! `Arc<dyn Keystore>` BEFORE any `AppState` exists —
//! the migration runs PRE-agent-boot. The dispatch
//! site cannot just call `AppState::init_keystore`
//! because:
//!
//!   1. `AppState` carries dozens of unrelated fields
//!      (MQTT handles, GPIO actor, OPC-UA server,
//!      etc.) — building a partial AppState just to get
//!      a keystore is a wide blast radius.
//!   2. The dispatch site exits the process after
//!      migration; full AppState construction would
//!      run heavyweight subsystem inits that the
//!      ceremony doesn't need.
//!
//! Architectural fix: extract the Argon2id +
//! acceptance-token + rotation-marker FileBackedKeystore
//! construction into ONE async function that takes the
//! two inputs it needs (config + clock_authority) and
//! returns `Arc<dyn Keystore>`. Both
//! `AppState::init_keystore` AND the future
//! `--migrate-db` dispatch site call this function;
//! keystore construction is now a single SSoT path.
//!
//! ## Why `clock_authority` is a parameter (not built
//! internally)
//!
//! The clock-authority is shared across multiple
//! consumers (keystore alarm + force_registry sweep +
//! future D-9 rotation) — `AppState` owns one
//! `Arc<dyn ClockAuthority>` that all consumers
//! receive cloned. Building a clock inside the
//! keystore-build function would create a SECOND
//! clock-authority instance for the migration tool
//! that doesn't share state with anything else (which
//! is fine for a one-shot CLI run, but pollutes the
//! shape). Having the caller pass the clock keeps
//! both call sites on the same architectural shape:
//! caller-owns-clock, function-owns-keystore-build.
//!
//! ## Behavior contract
//!
//! Byte-for-byte equivalent to the pre-extraction
//! `AppState::init_keystore` body. The only call
//! difference: this returns the constructed keystore
//! instead of mutating `self.keystore`. The
//! `Disabled` keystore mode now returns
//! `Ok(None)` (caller handles "no keystore" case)
//! instead of mutating `self`.

use std::path::PathBuf;
use std::sync::Arc;

use crate::config::{AgentConfig, KeystoreMode};
use crate::keystore::{
    AcceptanceToken, Argon2idParams, FileBackedAcceptance, FileBackedKeystore, Keystore,
    ROTATION_MARKER_FILENAME,
};
use crate::runtime_safety::ClockAuthority;
use tracing::{info, warn};

/// Default paths used when the agent config doesn't
/// override them. Mirror the pre-extraction inline
/// `unwrap_or_else` literals so byte-for-byte
/// production behavior is preserved.
const DEFAULT_PASSPHRASE_PATH: &str = "/etc/suderra/keystore.passphrase";
const DEFAULT_SALT_PATH: &str = "/etc/suderra/keystore.salt";
const DEFAULT_ACCEPTANCE_PATH: &str = "/etc/suderra/keystore.acceptance.json";

/// Build the production `FileBackedKeystore` from agent
/// config + caller-provided clock authority. Returns
/// `Ok(None)` when `keystore.mode = Disabled` — caller
/// handles the no-keystore case (HC-1 backward compat).
///
/// **Caller contract:**
///
///   - `config` — already-loaded `AgentConfig`. Reads
///     `keystore.mode`, `keystore.passphrase_path`,
///     `keystore.salt_path`, `keystore.acceptance_path`,
///     `keystore.argon2_*`, `device_code`.
///   - `clock_authority` — caller-owned clock handle.
///     `AppState::init_keystore` passes
///     `self.clock_authority.clone()`; the migration
///     ceremony dispatch site passes a freshly-built
///     `SystemClockAuthority` (rotation tracker is
///     read-only during the ceremony — no fresh
///     wallclock anchor needed).
///   - `data_dir` — base directory for the rotation
///     marker file. Caller passes
///     `data_dir::data_dir()`.
///
/// **Errors:** `String` with operator-readable
/// context. Mirrors the pre-extraction error messages
/// byte-for-byte so existing operator runbooks /
/// log-grep patterns keep working.
pub async fn build_production_keystore_from_config(
    config: &AgentConfig,
    clock_authority: Arc<dyn ClockAuthority>,
    data_dir: PathBuf,
) -> Result<Option<Arc<dyn Keystore>>, String> {
    if matches!(config.keystore.mode, KeystoreMode::Disabled) {
        info!("Keystore init skipped: keystore.mode=Disabled (HC-1 backward compat)");
        return Ok(None);
    }

    if matches!(config.keystore.mode, KeystoreMode::Auto) {
        warn!(
            "Keystore.mode=Auto: TPM + systemd-creds probes land in Phase 2 / Batches 83a+83b. \
             Falling through to FileBacked for this boot. Provision a TPM (or systemd-creds namespace) \
             to promote to a hardware-backed tier when those batches ship."
        );
    }

    let pass_path = config
        .keystore
        .passphrase_path
        .clone()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_PASSPHRASE_PATH));
    let salt_path = config
        .keystore
        .salt_path
        .clone()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_SALT_PATH));
    let acceptance_path = config
        .keystore
        .acceptance_path
        .clone()
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ACCEPTANCE_PATH));

    // Read + parse acceptance token (operator-signed).
    let acceptance_bytes = std::fs::read(&acceptance_path).map_err(|e| {
        format!(
            "Keystore init: read acceptance {}: {}",
            acceptance_path.display(),
            e
        )
    })?;
    let token: AcceptanceToken = serde_json::from_slice(&acceptance_bytes).map_err(|e| {
        format!(
            "Keystore init: parse acceptance JSON {}: {}",
            acceptance_path.display(),
            e
        )
    })?;

    // Device identity for binding. Device code is the
    // stable acceptance-token field; operator_id comes
    // from the token itself.
    let device_id = config.device_code.clone();
    let acceptance = FileBackedAcceptance::try_from_parts(
        &token,
        &token.operator_id,
        &device_id,
        std::time::SystemTime::now(),
        // Pre-Batch-84 signature-verify wiring: accept
        // operator-supplied token without crypto
        // verify. Batch 84 introduces operator-pubkey
        // config knob + real ed25519 verify here.
        // Current discipline: acceptance_path file
        // perms 0400 owner:suderra + audit-log every
        // load.
        |_, _| true,
    )
    .map_err(|e| format!("Keystore init: acceptance token invalid: {:?}", e))?;

    let params = Argon2idParams {
        memory_kib: config.keystore.argon2_memory_kib,
        iterations: config.keystore.argon2_iterations,
        parallelism: config.keystore.argon2_parallelism,
    };

    let marker_path = data_dir.join(ROTATION_MARKER_FILENAME);
    let ks = FileBackedKeystore::open_with_rotation_tracker(
        &pass_path,
        &salt_path,
        params,
        acceptance,
        marker_path.clone(),
        clock_authority,
    )
    .await
    .map_err(|e| {
        format!(
            "Keystore init: FileBacked open_with_rotation_tracker failed (fail-closed boot): {}",
            e
        )
    })?;

    info!(
        "Keystore opened: backend=FileBacked argon2id m={}KiB t={} p={} \
         rotation_marker={}",
        params.memory_kib,
        params.iterations,
        params.parallelism,
        marker_path.display(),
    );

    Ok(Some(Arc::new(ks)))
}
