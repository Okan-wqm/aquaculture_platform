//! Environment overrides of the generic-Linux profile (ADR-048 DEC-19, DEC-28).
//!
//! This is the only module that reads a security-relevant environment
//! variable: the agent's path overrides, the SCADA listener knobs, the backup
//! endpoint secret and the systemd credentials directory. `main.rs` declares it
//! under `#[cfg(not(feature = "suderra-os"))]`, so in the Suderra OS profile the
//! module does not exist and a caller that tries to consult one of these
//! variables does not compile: on Suderra OS a unit file, drop-in or
//! `Environment=` line can never select a path, a listener or a credential
//! (DEC-4.5, DEC-19). `tests/invariants/no_security_env_in_suderra_os.rs` keeps
//! every other environment read out of `src/`.
//!
//! The generic profile keeps honouring these variables for the v1.6.0 HC-1
//! fleet, whose cloud-generated unit and CI sandboxes rely on them (DEC-28).
//! An empty value counts as unset for paths (an empty path would resolve
//! against the working directory) and for the SCADA knobs (whose callers
//! already treated empty as unset).
//!
//! The file depends on `std` alone because the filesystem-contract invariant
//! (`tests/invariants/no_etc_write_paths.rs`) compiles it, together with
//! `src/paths.rs`, into its own test crate.

use std::path::PathBuf;

/// Config file override (default `/etc/suderra/config.yaml`).
pub const CONFIG_PATH_VAR: &str = "SUDERRA_CONFIG";
/// Agent data root override (default `/var/lib/suderra`).
pub const DATA_DIR_VAR: &str = "SUDERRA_DATA_DIR";
/// v1 SQLCipher device-secret file override.
pub const DB_KEY_PATH_VAR: &str = "SUDERRA_DB_KEY_PATH";
/// machine-id source override (CI sandboxes without `/etc/machine-id`).
pub const MACHINE_ID_PATH_VAR: &str = "SUDERRA_MACHINE_ID_PATH";
/// SCADA HMI listener address (default loopback).
#[cfg(feature = "scada-display")]
pub const SCADA_BIND_VAR: &str = "SUDERRA_SCADA_BIND";
/// SCADA HMI listener port (default 6526).
#[cfg(feature = "scada-display")]
pub const SCADA_PORT_VAR: &str = "SUDERRA_SCADA_PORT";
/// SCADA WebSocket bearer token.
#[cfg(feature = "scada-display")]
pub const SCADA_AUTH_TOKEN_VAR: &str = "SUDERRA_SCADA_AUTH_TOKEN";
/// Shared secret of the (future) backup HTTP endpoint.
pub const BACKUP_AUTH_SECRET_VAR: &str = "BACKUP_AUTH_SECRET";
/// Directory systemd fills from `LoadCredential=`.
#[cfg(feature = "health")]
pub const CREDENTIALS_DIRECTORY_VAR: &str = "CREDENTIALS_DIRECTORY";

/// A non-empty variable as a path.
fn non_empty_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// A non-empty, valid UTF-8 variable.
#[cfg(feature = "scada-display")]
fn non_empty_string(var: &str) -> Option<String> {
    std::env::var(var).ok().filter(|v| !v.is_empty())
}

/// `SUDERRA_CONFIG`.
pub fn config_path() -> Option<PathBuf> {
    non_empty_path(CONFIG_PATH_VAR)
}

/// `SUDERRA_DATA_DIR`.
pub fn data_dir() -> Option<PathBuf> {
    non_empty_path(DATA_DIR_VAR)
}

/// `SUDERRA_DB_KEY_PATH`.
pub fn db_key_path() -> Option<PathBuf> {
    non_empty_path(DB_KEY_PATH_VAR)
}

/// `SUDERRA_MACHINE_ID_PATH`.
pub fn machine_id_path() -> Option<PathBuf> {
    non_empty_path(MACHINE_ID_PATH_VAR)
}

/// `SUDERRA_SCADA_BIND`, unparsed (the caller owns the address grammar).
#[cfg(feature = "scada-display")]
pub fn scada_bind() -> Option<String> {
    non_empty_string(SCADA_BIND_VAR)
}

/// `SUDERRA_SCADA_PORT`, unparsed.
#[cfg(feature = "scada-display")]
pub fn scada_port() -> Option<String> {
    non_empty_string(SCADA_PORT_VAR)
}

/// `SUDERRA_SCADA_AUTH_TOKEN`.
#[cfg(feature = "scada-display")]
pub fn scada_auth_token() -> Option<String> {
    non_empty_string(SCADA_AUTH_TOKEN_VAR)
}

/// `BACKUP_AUTH_SECRET`, exactly as set: an explicitly empty secret stays a
/// configured (empty) secret rather than reading as "none configured",
/// which `BackupManager::validate_auth` treats as local-only.
pub fn backup_auth_secret() -> Option<String> {
    std::env::var(BACKUP_AUTH_SECRET_VAR).ok()
}

/// `CREDENTIALS_DIRECTORY`.
#[cfg(feature = "health")]
pub fn credentials_directory() -> Option<PathBuf> {
    non_empty_path(CREDENTIALS_DIRECTORY_VAR)
}
